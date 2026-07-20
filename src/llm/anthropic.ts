import type {
  CompletionRequest,
  CompletionResult,
  ReasoningPreference,
} from "../types.js";
import {
  defaultModels,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import { readJson, readStreamLines } from "./http.js";
import {
  anthropicToolBodyFields,
  createAnthropicToolStreamState,
  finalizeAnthropicToolStream,
  handleAnthropicStreamEvent,
  parseAnthropicToolUseBlocks,
  toAnthropicToolMessages,
} from "./adapters/anthropic-tools.js";
import { parseAnthropicUsage } from "./token-usage.js";
import type { TokenUsage } from "../types.js";

const baseUrl = "https://api.anthropic.com/v1";
const anthropicVersion = "2023-06-01";

function anthropicThinkingBudget(
  reasoning: ReasoningPreference | undefined,
): number | undefined {
  if (!reasoning?.enabled) return undefined;
  switch (reasoning.effort) {
    case "low":
      return 1_024;
    case "high":
      return 8_192;
    default:
      return 4_096;
  }
}

/**
 * Claude Opus 4.7+ and later generations (Sonnet 5, Opus 4.8, …) removed
 * manual extended thinking (`thinking: {type:"enabled", budget_tokens}`) —
 * it now returns HTTP 400. Those models require adaptive thinking
 * (`thinking: {type:"adaptive"}` + `effort`) instead. Earlier models
 * (3-7, 4, 4-5, 4-6) still use the legacy budget_tokens form.
 * https://docs.anthropic.com/en/docs/about-claude/models/extended-thinking-models
 */
function requiresAdaptiveThinking(model: string): boolean {
  return /claude-(?:opus|sonnet|haiku)-(?:4-[7-9]|4-\d\d|5(?:-|$))/i.test(model);
}

function anthropicThinkingField(
  reasoning: ReasoningPreference | undefined,
  model: string,
): Record<string, unknown> | undefined {
  if (!reasoning?.enabled) return undefined;
  if (requiresAdaptiveThinking(model)) {
    return { type: "adaptive", effort: reasoning.effort ?? "medium" };
  }
  const budget = anthropicThinkingBudget(reasoning);
  if (budget === undefined) return undefined;
  return { type: "enabled", budget_tokens: budget };
}

export function buildAnthropicBody(request: CompletionRequest, stream: boolean): string {
  const model = request.model ?? defaultModels.anthropic;
  const system = request.messages.find(
    (message) => message.role === "system",
  )?.content;
  const messages = toAnthropicToolMessages(request.messages);
  const thinking = anthropicThinkingField(request.thinking, model);
  return JSON.stringify({
    model,
    system,
    messages,
    max_tokens: request.maxTokens ?? 1_024,
    // Anthropic requires temperature to stay at its default (1) whenever
    // thinking is enabled — sending our 0.2 default returns HTTP 400
    // ("temperature may only be set to 1 when thinking is enabled").
    // Omit the field in that case rather than pin it to 1 explicitly, since
    // some non-thinking-capable models on the same body path (e.g. Haiku
    // 3.5) still support a real temperature.
    ...(thinking ? {} : { temperature: request.temperature ?? 0.2 }),
    ...(stream ? { stream: true } : {}),
    ...(thinking ? { thinking } : {}),
    ...anthropicToolBodyFields({
      tools: request.tools,
      toolChoice: request.toolChoice,
    }),
  });
}

export const anthropicProvider: LlmProvider = {
  id: "anthropic",
  displayName: "Anthropic",
  defaultModel: defaultModels.anthropic,
  envVar: "ANTHROPIC_API_KEY",
  validateKey: (key: string) => /^sk-ant-[A-Za-z0-9_-]{12,}$/.test(key),
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("Anthropic API key is required");
    const response = await fetch(`${baseUrl}/models`, {
      headers: {
        "x-api-key": auth.apiKey,
        "anthropic-version": anthropicVersion,
      },
    });
    await readJson<unknown>(response);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Anthropic API key is required");
    const model = request.model ?? defaultModels.anthropic;
    const response = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      signal: request.signal ?? null,
      headers: {
        "content-type": "application/json",
        "x-api-key": auth.apiKey,
        "anthropic-version": anthropicVersion,
      },
      body: buildAnthropicBody(request, false),
    });
    const data = await readJson<{
      content?: Array<{
        type: string;
        text?: string;
        thinking?: string;
        id?: string;
        name?: string;
        input?: unknown;
      }>;
      stop_reason?: string;
      usage?: unknown;
    }>(response);
    const parsed = parseAnthropicToolUseBlocks(data.content);
    if (!parsed.text && parsed.toolCalls.length === 0) {
      throw new Error("Anthropic returned no completion text");
    }
    const final = parsed.thinkingText
      ? `<think>${parsed.thinkingText}</think>${parsed.text}`
      : parsed.text;
    const usage = parseAnthropicUsage(data.usage);
    return {
      text: final,
      provider: "anthropic",
      model,
      ...(parsed.toolCalls.length ? { toolCalls: parsed.toolCalls } : {}),
      ...(data.stop_reason
        ? {
            finishReason:
              data.stop_reason === "tool_use" ? "tool_calls" : data.stop_reason,
          }
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
    if (!auth.apiKey) throw new Error("Anthropic API key is required");
    const model = request.model ?? defaultModels.anthropic;
    const response = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      signal: request.signal ?? null,
      headers: {
        "content-type": "application/json",
        "x-api-key": auth.apiKey,
        "anthropic-version": anthropicVersion,
      },
      body: buildAnthropicBody(request, true),
    });
    if (!response.ok) {
      await readJson<unknown>(response);
    }
    if (!response.body) {
      throw new Error("Anthropic returned no stream body");
    }
    let full = "";
    let inThinking = false;
    const streamState = createAnthropicToolStreamState();
    let stopReason: string | undefined;
    let streamUsage: TokenUsage | undefined;

    const enterThinking = (): void => {
      if (inThinking) return;
      inThinking = true;
      full += "<think>";
      onToken("<think>");
    };
    const exitThinking = (): void => {
      if (!inThinking) return;
      inThinking = false;
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
          type?: string;
          index?: number;
          usage?: unknown;
          message?: { usage?: unknown };
          content_block?: {
            type?: string;
            id?: string;
            name?: string;
            text?: string;
            thinking?: string;
          };
          delta?: {
            type?: string;
            text?: string;
            thinking?: string;
            partial_json?: string;
            stop_reason?: string;
          };
        };
        // message_start carries input tokens; message_delta carries output.
        if (parsed.type === "message_start" && parsed.message?.usage) {
          streamUsage = parseAnthropicUsage(parsed.message.usage) ?? streamUsage;
        }
        if (parsed.type === "message_delta") {
          if (parsed.delta?.stop_reason) {
            stopReason = parsed.delta.stop_reason;
          }
          if (parsed.usage) {
            const out = parseAnthropicUsage(parsed.usage);
            if (out) {
              streamUsage = {
                promptTokens: streamUsage?.promptTokens ?? out.promptTokens,
                completionTokens:
                  out.completionTokens || (streamUsage?.completionTokens ?? 0),
                totalTokens:
                  (streamUsage?.promptTokens ?? out.promptTokens) +
                  (out.completionTokens ||
                    (streamUsage?.completionTokens ?? 0)),
                exact: true,
              };
            }
          }
        }
        if (
          parsed.type === "content_block_start" ||
          parsed.type === "content_block_delta"
        ) {
          const deltas = handleAnthropicStreamEvent(streamState, parsed);
          if (deltas.thinkingDelta) {
            enterThinking();
            full += deltas.thinkingDelta;
            onToken(deltas.thinkingDelta);
          }
          if (deltas.textDelta) {
            if (inThinking) exitThinking();
            full += deltas.textDelta;
            onToken(deltas.textDelta);
          }
          if (deltas.toolCallDelta && request.onToolCallDelta) {
            const d = deltas.toolCallDelta;
            request.onToolCallDelta({
              index: d.index,
              ...(d.id !== undefined ? { id: d.id } : {}),
              ...(d.name !== undefined ? { name: d.name } : {}),
              ...(d.argumentsBytes !== undefined
                ? { argumentsBytes: d.argumentsBytes }
                : {}),
            });
          }
        }
      } catch {
        // Ignore malformed keepalive lines.
      }
    }
    exitThinking();
    const finalized = finalizeAnthropicToolStream(streamState);
    if (!full.trim() && finalized.toolCalls.length === 0) {
      throw new Error("Anthropic returned no completion text");
    }
    return {
      text: full,
      provider: "anthropic",
      model,
      ...(finalized.toolCalls.length
        ? { toolCalls: finalized.toolCalls }
        : {}),
      ...(stopReason
        ? {
            finishReason:
              stopReason === "tool_use" ? "tool_calls" : stopReason,
          }
        : finalized.toolCalls.length
          ? { finishReason: "tool_calls" }
          : {}),
      ...(streamUsage ? { usage: streamUsage } : {}),
    };
  },
};
