import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ReasoningPreference,
} from "../types.js";
import {
  defaultModels,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import {
  openAiCompatibleComplete,
  openAiCompatibleStream,
  toCompletionResult,
  readJson,
  readStreamLines,
  ProviderError,
  createSseFrameAssembler,
} from "./http.js";
import {
  anthropicToolBodyFields,
  createAnthropicToolStreamState,
  finalizeAnthropicToolStream,
  handleAnthropicStreamEvent,
  parseAnthropicToolUseBlocks,
  toAnthropicToolMessages,
} from "./adapters/anthropic-tools.js";
import { firstSystemPrompt } from "./system-messages.js";
import { anthropicMaxTokens } from "./anthropic.js";
import { parseAnthropicUsage } from "./token-usage.js";
import type { TokenUsage } from "../types.js";

const baseUrl = "https://bedrock-mantle.ap-south-1.api.aws/anthropic/v1";
const openAiBaseUrl = "https://bedrock-mantle.ap-south-1.api.aws/v1";
const modelsBaseUrl = "https://bedrock-mantle.ap-south-1.api.aws";
const anthropicVersion = "2023-06-01";

function getWorkspaceId(): string {
  return process.env.ANTHROPIC_WORKSPACE_ID ?? "default";
}

function anthropicThinkingBudget(reasoning: ReasoningPreference | undefined): number | undefined {
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

/** See anthropic.ts — Opus 4.7+ / Sonnet 5+ require adaptive thinking. */
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

function isAnthropicMantleModel(model: string): boolean {
  return /(?:^|[./-])(?:anthropic|claude)(?:[./-]|$)/i.test(model);
}

export const mantleProvider: LlmProvider = {
  id: "aws-mantle",
  displayName: "AWS Mantle",
  defaultModel: defaultModels["aws-mantle"],
  envVar: "ANTHROPIC_API_KEY",
  validateKey: (key: string) => /^[A-Za-z0-9+/=_-]{8,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    if (!auth.apiKey) throw new Error("Mantle API key is required");
    const response = await fetch(`${modelsBaseUrl}/v1/models`, {
      headers: {
        "x-api-key": auth.apiKey,
        "anthropic-version": anthropicVersion,
      },
    });
    const data = await readJson<
      | Array<{ id?: string } | string>
      | { data?: Array<{ id?: string } | string>; models?: Array<{ id?: string } | string> }
    >(response);
    const entries = Array.isArray(data) ? data : (data.data ?? data.models ?? []);
    return entries
      .map((entry) => typeof entry === "string" ? entry : entry.id)
      .filter((id): id is string => Boolean(id))
      .sort();
  },
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("Mantle API key is required");
    const response = await fetch(`${modelsBaseUrl}/v1/models`, {
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
    if (!auth.apiKey) throw new Error("Mantle API key is required");
    const model = request.model ?? defaultModels["aws-mantle"];
    if (!isAnthropicMantleModel(model)) {
      const payload = await openAiCompatibleComplete({
        provider: "AWS Mantle",
        providerId: "aws-mantle",
        baseUrl: openAiBaseUrl,
        apiKey: auth.apiKey,
        model,
        messages: request.messages,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        signal: request.signal,
        reasoning: request.thinking,
        reasoningStyle: "nvidia",
        tools: request.tools,
        toolChoice: request.toolChoice,
        parallelToolCalls: request.parallelToolCalls,
      });
      return toCompletionResult("aws-mantle", model, payload);
    }
    const system = firstSystemPrompt(request.messages);
    const messages = toAnthropicToolMessages(request.messages);
    const thinking = anthropicThinkingField(request.thinking, model);
    const response = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      signal: request.signal ?? null,
      headers: {
        "content-type": "application/json",
        "x-api-key": auth.apiKey,
        "anthropic-version": anthropicVersion,
        "anthropic-workspace-id": getWorkspaceId(),
      },
      body: JSON.stringify({
        model,
        system,
        messages,
        max_tokens: anthropicMaxTokens(request.maxTokens, thinking),
        // See anthropic.ts: temperature must stay default when thinking is on.
        ...(thinking ? {} : { temperature: request.temperature ?? 0.2 }),
        ...anthropicToolBodyFields({
          tools: request.tools,
          toolChoice: request.toolChoice,
        }),
        ...(thinking ? { thinking } : {}),
      }),
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
    const usage = parseAnthropicUsage(data.usage);
    const parsed = parseAnthropicToolUseBlocks(data.content);
    if (!parsed.text && parsed.toolCalls.length === 0) {
      throw new Error("Mantle returned no completion text");
    }
    const reasoningBlock =
      parsed.thinkingSignature && parsed.thinkingText
        ? { text: parsed.thinkingText, signature: parsed.thinkingSignature }
        : undefined;
    const final = parsed.thinkingText
      ? `<thinking>${parsed.thinkingText}</thinking>${parsed.text}`
      : parsed.text;
    return {
      text: final,
      provider: "aws-mantle",
      model,
      ...(usage ? { usage } : {}),
      ...(parsed.toolCalls.length ? { toolCalls: parsed.toolCalls } : {}),
      ...(reasoningBlock ? { reasoningBlock } : {}),
      ...(data.stop_reason
        ? {
            finishReason:
              data.stop_reason === "tool_use" ? "tool_calls" : data.stop_reason,
          }
        : parsed.toolCalls.length
          ? { finishReason: "tool_calls" }
          : {}),
    };
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Mantle API key is required");
    const model = request.model ?? defaultModels["aws-mantle"];
    if (!isAnthropicMantleModel(model)) {
      const payload = await openAiCompatibleStream({
        provider: "AWS Mantle",
        providerId: "aws-mantle",
        baseUrl: openAiBaseUrl,
        apiKey: auth.apiKey,
        model,
        messages: request.messages,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        signal: request.signal,
        onToken,
      onToolCallDelta: request.onToolCallDelta,
        reasoning: request.thinking,
        reasoningStyle: "nvidia",
        tools: request.tools,
        toolChoice: request.toolChoice,
        parallelToolCalls: request.parallelToolCalls,
      });
      return toCompletionResult("aws-mantle", model, payload);
    }
    const system = firstSystemPrompt(request.messages);
    const messages = toAnthropicToolMessages(request.messages);
    const thinking = anthropicThinkingField(request.thinking, model);
    const response = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      signal: request.signal ?? null,
      headers: {
        "content-type": "application/json",
        "x-api-key": auth.apiKey,
        "anthropic-version": anthropicVersion,
        "anthropic-workspace-id": getWorkspaceId(),
      },
      body: JSON.stringify({
        model,
        system,
        messages,
        max_tokens: anthropicMaxTokens(request.maxTokens, thinking),
        ...(thinking ? {} : { temperature: request.temperature ?? 0.2 }),
        ...anthropicToolBodyFields({
          tools: request.tools,
          toolChoice: request.toolChoice,
        }),
        stream: true,
        ...(thinking ? { thinking } : {}),
      }),
    });
    if (!response.ok) {
      await readJson<unknown>(response);
    }
    if (!response.body) {
      throw new Error("Mantle returned no stream body");
    }
    let full = "";
    let inThinking = false;
    const streamState = createAnthropicToolStreamState();
    let stopReason: string | undefined;
    let streamUsage: TokenUsage | undefined;

    const enterThinking = (): void => {
      if (inThinking) return;
      inThinking = true;
      full += "<thinking>";
      onToken("<thinking>");
    };
    const exitThinking = (): void => {
      if (!inThinking) return;
      inThinking = false;
      full += "</thinking>";
      onToken("</thinking>");
    };

    const sseFrames = createSseFrameAssembler();
    for await (const line of readStreamLines(response, {
      signal: request.signal,
    })) {
      const payload = sseFrames.pushLine(line);
      if (payload === undefined) continue;
      if (payload === "[DONE]") break;
      try {
        const parsed = JSON.parse(payload) as {
          type?: string;
          index?: number;
          error?: { message?: string; type?: string };
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
        // LLM-011: surface mid-stream provider error frames.
        if (parsed.type === "error") {
          throw new ProviderError(
            `AWS Mantle stream error: ${parsed.error?.message ?? parsed.error?.type ?? "unknown"}`,
            undefined,
            payload.slice(0, 500),
          );
        }
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
      } catch (frameError) {
        // Only malformed JSON frames are ignorable (LLM-011).
        if (!(frameError instanceof SyntaxError)) throw frameError;
      }
    }
    exitThinking();
    const finalized = finalizeAnthropicToolStream(streamState);
    if (!full.trim() && finalized.toolCalls.length === 0) {
      throw new Error("Mantle returned no completion text");
    }
    return {
      text: full,
      provider: "aws-mantle",
      model,
      ...(streamUsage ? { usage: streamUsage } : {}),
      ...(finalized.toolCalls.length ? { toolCalls: finalized.toolCalls } : {}),
      ...(finalized.thinkingSignature && finalized.thinkingText
        ? {
            reasoningBlock: {
              text: finalized.thinkingText,
              signature: finalized.thinkingSignature,
            },
          }
        : {}),
      ...(stopReason
        ? {
            finishReason:
              stopReason === "tool_use" ? "tool_calls" : stopReason,
          }
        : finalized.toolCalls.length
          ? { finishReason: "tool_calls" }
          : {}),
    };
  },
};
