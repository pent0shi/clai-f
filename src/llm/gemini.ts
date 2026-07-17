import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ReasoningPreference,
  TokenUsage,
} from "../types.js";
import {
  defaultModels,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import { ProviderError, readJson, readStreamLines } from "./http.js";
import {
  geminiToolBodyFields,
  parseGeminiFunctionCalls,
  toGeminiToolContents,
} from "./adapters/gemini-tools.js";
import { fromWireName } from "./tool-protocol.js";
import { parseGeminiUsage } from "./token-usage.js";

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

function geminiContents(
  messages: ChatMessage[],
): Array<{ role: "user" | "model"; parts: GeminiPart[] }> {
  return toGeminiToolContents(messages) as Array<{
    role: "user" | "model";
    parts: GeminiPart[];
  }>;
}

function systemInstruction(
  messages: ChatMessage[],
): { parts: Array<{ text: string }> } | undefined {
  const system = messages.find((message) => message.role === "system");
  return system ? { parts: [{ text: system.content }] } : undefined;
}

function isGemini3Model(model: string): boolean {
  return /gemini-3(?:[.-]|$)/i.test(model);
}

function geminiThinkingConfig(
  reasoning: ReasoningPreference | undefined,
  model: string,
): Record<string, unknown> | undefined {
  if (!reasoning) return undefined;
  if (isGemini3Model(model)) {
    // Gemini 3 models use `thinkingLevel`, not Gemini 2.5's token budget.
    // Flash-Lite supports `minimal`, which is the closest available recovery
    // mode when the runner needs a visible answer instead of a long thought.
    // 3.1 Pro does not support `minimal`, so `low` is its least costly mode.
    const effort = reasoning?.effort ?? "medium";
    const wantsMinimal = !reasoning?.enabled || effort === "none" || effort === "minimal";
    const isPro = /gemini-3(?:\.\d)?-pro/i.test(model);
    const thinkingLevel = wantsMinimal
      ? isPro
        ? "low"
        : "minimal"
      : effort === "low"
        ? "low"
        : effort === "high" || effort === "xhigh"
          ? "high"
          : "medium";
    return {
      thinkingLevel,
      // On a recovery retry, keep Gemini's minimal internal reasoning but do
      // not stream thought summaries back as an apparent empty completion.
      ...(reasoning?.enabled ? { includeThoughts: true } : {}),
    };
  }

  if (!/gemini-2\.5/i.test(model)) return undefined;
  if (!reasoning?.enabled) {
    // Flash and Flash-Lite support an explicit zero budget. Gemini 2.5 Pro
    // cannot disable thinking, so omit the control rather than send an
    // invalid value.
    return /gemini-2\.5-(?:flash|flash-lite)/i.test(model)
      ? { thinkingBudget: 0 }
      : undefined;
  }
  switch (reasoning.effort) {
    case "low":
      return { thinkingBudget: 1_024, includeThoughts: true };
    case "high":
    case "xhigh":
      return { thinkingBudget: 16_384, includeThoughts: true };
    default:
      return { thinkingBudget: 4_096, includeThoughts: true };
  }
}

export function geminiBody(request: CompletionRequest): string {
  const model = request.model ?? defaultModels.gemini;
  const thinkingConfig = geminiThinkingConfig(request.thinking, model);
  const defaultMaxTokens = request.thinking?.enabled ? 8_192 : 4_096;
  const body: Record<string, unknown> = {
    contents: geminiContents(request.messages),
    generationConfig: {
      temperature: request.temperature ?? 0.2,
      maxOutputTokens: request.maxTokens ?? defaultMaxTokens,
      ...(thinkingConfig !== undefined
        ? { thinkingConfig }
        : {}),
    },
    ...geminiToolBodyFields({
      tools: request.tools,
      toolChoice: request.toolChoice,
    }),
  };
  const sys = systemInstruction(request.messages);
  if (sys) body.systemInstruction = sys;
  return JSON.stringify(body);
}

export const geminiProvider: LlmProvider = {
  id: "gemini",
  displayName: "Google Gemini",
  defaultModel: defaultModels.gemini,
  envVar: "GEMINI_API_KEY",
  validateKey: (key: string) => /^AIza[0-9A-Za-z_-]{12,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    if (!auth.apiKey) throw new Error("Gemini API key is required");
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(auth.apiKey)}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to list Gemini models: HTTP ${response.status}`);
    }
    const data = await readJson<{
      models?: Array<{
        name?: string;
        supportedGenerationMethods?: string[];
      }>;
    }>(response);
    return (
      data.models
        ?.filter((m) => m.name && m.supportedGenerationMethods?.includes("generateContent"))
        .map((m) => m.name!.replace(/^models\//, ""))
        .sort() ?? []
    );
  },
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("Gemini API key is required");
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(auth.apiKey)}`,
    );
    await readJson<unknown>(response);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Gemini API key is required");
    const model = request.model ?? defaultModels.gemini;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(auth.apiKey)}`,
      {
        method: "POST",
        signal: request.signal ?? null,
        headers: { "content-type": "application/json" },
        body: geminiBody(request),
      },
    );
    const data = await readJson<{
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
            thought?: boolean;
            functionCall?: {
              name?: string;
              args?: Record<string, unknown>;
              id?: string;
            };
          }>;
        };
        finishReason?: string;
      }>;
      usageMetadata?: unknown;
    }>(response);
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const thought = parts
      .filter((part) => part.thought)
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    const parsed = parseGeminiFunctionCalls(parts);
    if (!parsed.text && parsed.toolCalls.length === 0) {
      throw new ProviderError("Gemini completed without a visible answer.");
    }
    const final = thought
      ? `<think>${thought}</think>${parsed.text}`
      : parsed.text;
    const usage = parseGeminiUsage(data.usageMetadata);
    return {
      text: final,
      provider: "gemini",
      model,
      ...(parsed.toolCalls.length ? { toolCalls: parsed.toolCalls } : {}),
      ...(data.candidates?.[0]?.finishReason
        ? { finishReason: data.candidates[0].finishReason }
        : parsed.toolCalls.length
          ? { finishReason: "tool_calls" }
          : {}),
      ...(usage ? { usage } : {}),
    };
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Gemini API key is required");
    const model = request.model ?? defaultModels.gemini;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(auth.apiKey)}`,
      {
        method: "POST",
        signal: request.signal ?? null,
        headers: { "content-type": "application/json" },
        body: geminiBody(request),
      },
    );
    if (!response.ok) {
      await readJson<unknown>(response);
    }
    if (!response.body) {
      throw new Error("Gemini returned no stream body");
    }
    let full = "";
    let visible = "";
    let inThought = false;
    const collectedParts: Array<{
      text?: string;
      thought?: boolean;
      functionCall?: {
        name?: string;
        args?: Record<string, unknown>;
        id?: string;
      };
    }> = [];
    let finishReason: string | undefined;
    let streamUsage: TokenUsage | undefined;

    const enterThought = (): void => {
      if (inThought) return;
      inThought = true;
      full += "<think>";
      onToken("<think>");
    };
    const exitThought = (): void => {
      if (!inThought) return;
      inThought = false;
      full += "</think>";
      onToken("</think>");
    };

    for await (const line of readStreamLines(response, {
      signal: request.signal,
    })) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") break;
      try {
        const parsed = JSON.parse(payload) as {
          usageMetadata?: unknown;
          candidates?: Array<{
            finishReason?: string;
            content?: {
              parts?: Array<{
                text?: string;
                thought?: boolean;
                functionCall?: {
                  name?: string;
                  args?: Record<string, unknown>;
                  id?: string;
                };
              }>;
            };
          }>;
        };
        const u = parseGeminiUsage(parsed.usageMetadata);
        if (u) streamUsage = u;
        const candidate = parsed.candidates?.[0];
        if (candidate?.finishReason) finishReason = candidate.finishReason;
        const parts = candidate?.content?.parts ?? [];
        for (const part of parts) {
          collectedParts.push(part);
          if (part.functionCall) {
            if (request.onToolCallDelta && part.functionCall.name) {
              const idx =
                collectedParts.filter((p) => p.functionCall).length - 1;
              const wire = part.functionCall.name;
              request.onToolCallDelta({
                index: idx,
                ...(part.functionCall.id
                  ? { id: part.functionCall.id }
                  : {}),
                name: fromWireName(wire) ?? wire,
                argumentsBytes: JSON.stringify(part.functionCall.args ?? {})
                  .length,
              });
            }
            continue;
          }
          if (!part.text) continue;
          if (part.thought) {
            enterThought();
            full += part.text;
            onToken(part.text);
          } else {
            if (inThought) exitThought();
            visible += part.text;
            full += part.text;
            onToken(part.text);
          }
        }
      } catch {
        // Ignore malformed keepalive lines.
      }
    }
    exitThought();
    const toolParsed = parseGeminiFunctionCalls(collectedParts);
    if (!visible.trim() && toolParsed.toolCalls.length === 0) {
      throw new ProviderError("Gemini completed without a visible answer.");
    }
    return {
      text: full,
      provider: "gemini",
      model,
      ...(toolParsed.toolCalls.length
        ? { toolCalls: toolParsed.toolCalls }
        : {}),
      ...(finishReason
        ? { finishReason }
        : toolParsed.toolCalls.length
          ? { finishReason: "tool_calls" }
          : {}),
      ...(streamUsage ? { usage: streamUsage } : {}),
    };
  },
};
