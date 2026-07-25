import type {
  ChatMessage,
  NativeToolCall,
  ReasoningPreference,
  ProviderId,
  TokenUsage,
  ToolChoice,
  ToolDefinition,
} from "../types.js";
import {
  modelSupportsVision,
  modelSupportsThinking,
  isReasoningUnsupported,
} from "./capabilities.js";
import { resolveSampling } from "./sampling.js";
import {
  accumulateOpenAiToolCallDelta,
  finalizeOpenAiToolCalls,
  fromWireName,
  parseOpenAiMessageToolCalls,
} from "./tool-protocol.js";
import {
  openAiToolBodyFields,
  toOpenAiToolMessages,
} from "./adapters/openai-tools.js";
import { parseOpenAiUsage } from "./token-usage.js";

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number | undefined,
    public readonly body?: string | undefined,
    public readonly retryAfterSeconds?: number | undefined,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

function parseRetryAfterHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  // HTTP-date form: "Wed, 21 Oct 2015 07:28:00 GMT"
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    const diff = (date - Date.now()) / 1000;
    if (diff > 0) return diff;
  }
  return undefined;
}

function parseRetryHintFromBody(text: string): number | undefined {
  const match = text.match(/try again in\s+([0-9.]+)\s*s/i);
  if (match) {
    const seconds = Number.parseFloat(match[1]!);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  }
  return undefined;
}

function statusCodeHint(status: number): string {
  if (status === 401) {
    return " — check that the API key is valid (run `clai providers` to inspect)";
  }
  if (status === 403) {
    return " — the key was rejected (insufficient permissions, billing, or region restriction)";
  }
  if (status === 404) {
    return " — endpoint or model not found (try `/model list` to see supported names)";
  }
  if (status === 422) {
    return " — the provider rejected the request body (model name or parameter mismatch)";
  }
  if (status === 413) {
    return " — request exceeded the provider input limit; retry with a compact prompt or pick another model";
  }
  if (status >= 500 && status < 600) {
    return " — upstream provider error; try again or switch with `/provider`";
  }
  return "";
}

export async function readJson<T>(response: Response): Promise<T> {
  const text = await readBodyCapped(response, MAX_JSON_RESPONSE_BYTES);
  if (!response.ok) {
   
    let detail = "";
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      const error = (body as { error?: unknown }).error;
      let msg = "";
      if (typeof error === "string") {
        msg = error;
      } else if (error && typeof error === "object") {
        const errObj = error as {
          message?: string;
          type?: string;
          code?: string;
        };
        msg = errObj.message ?? "";
        if (!msg && (errObj.type || errObj.code)) {
          msg = errObj.type ?? errObj.code ?? "";
        }
      }
      if (!msg) {
        msg =
          (body as { message?: string }).message ??
          (body as { detail?: string }).detail ??
          "";
      }
      if (msg) {
        // Detect NVIDIA DEGRADED function errors and enrich the message.
        if (/DEGRADED/i.test(msg)) {
          detail = ` — ${msg} (model is temporarily unavailable on this provider; try a different model with \`/model\`)`;
        } else {
          detail = ` — ${msg}`;
        }
      }
    } catch {
      if (text.length > 0) detail = ` — ${text.slice(0, 200)}`;
    }
    const retryAfterSeconds =
      parseRetryAfterHeader(response.headers.get("retry-after")) ??
      parseRetryHintFromBody(text);
    const retryHint =
      retryAfterSeconds !== undefined
        ? ` (retry after ${Math.ceil(retryAfterSeconds)}s)`
        : "";
    const codeHint = statusCodeHint(response.status);
    throw new ProviderError(
      `Provider request failed with HTTP ${response.status}${retryHint}${detail}${codeHint}`,
      response.status,
      text.slice(0, 1_000),
      retryAfterSeconds,
    );
  }
  return JSON.parse(text) as T;
}

/** Hard cap on a JSON response body so a misbehaving provider can't OOM us. */
const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;

async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    
    const text = await response.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let collected = "";
  let bytesRead = 0;
  try {
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - bytesRead;
      if (value.byteLength > remaining) {
        collected += decoder.decode(value.subarray(0, remaining), {
          stream: true,
        });
        bytesRead += remaining;
        try {
          await reader.cancel();
        } catch {
          // ignore — we're abandoning the body deliberately
        }
        break;
      }
      collected += decoder.decode(value, { stream: true });
      bytesRead += value.byteLength;
    }
    collected += decoder.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
  return collected;
}

/**
 * Default no-byte watchdog for provider streams (all providers / modes).
 * Unified to 60s so "stream stalled" behaves the same everywhere.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;

/**
 * Mid-stream silence budget when reasoning/thinking is enabled.
 * Same as the global default (1 minute).
 */
export const THINKING_STREAM_IDLE_TIMEOUT_MS = 60_000;

/**
 * First-byte idle budget when reasoning/thinking is enabled.
 * Same as the global default (1 minute).
 */
export const THINKING_STREAM_INITIAL_IDLE_TIMEOUT_MS = 60_000;



export interface StreamLineReaderOptions {
  signal?: AbortSignal | undefined;
  idleTimeoutMs?: number | undefined;
  maxBytes?: number | undefined;
  /** If provided, called after every read so callers can reset their own
   *  watchdogs (eg the OpenAI-compatible streamer's existing one). */
  onActivity?: (() => void) | undefined;
}


function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("Stream aborted"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    const succeed = (value: ReadableStreamReadResult<Uint8Array>): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = (): void => {
      fail(signal.reason ?? new Error("Stream aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      void reader.read().then(succeed, fail);
    } catch (error) {
      fail(error);
    }
  });
}

export async function* readStreamLines(
  response: Response,
  options: StreamLineReaderOptions = {},
): AsyncGenerator<string, void, void> {
  if (!response.body) return;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const idleController = new AbortController();
  let idleTimer: NodeJS.Timeout | undefined;
  let idleFired = false;
  const resetIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleFired = true;
      idleController.abort();
    }, idleTimeoutMs);
  };
  resetIdleTimer();
  const onCallerAbort = (): void => idleController.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  // LLM-011: a caller abort must surface as an abort error, not as a clean
  // end-of-stream — otherwise the partial text is returned as a successful
  // completion and enters history as the model's final answer.
  const callerAbortError = (): Error =>
    (options.signal?.reason as Error | undefined) ??
    new DOMException("The operation was aborted.", "AbortError");
  if (options.signal?.aborted) {
    if (idleTimer) clearTimeout(idleTimer);
    throw callerAbortError();
  }
  // If the idle watchdog already fired, bail before starting the loop.
  if (idleController.signal.aborted) {
    if (idleTimer) clearTimeout(idleTimer);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytesRead = 0;
  
  const cancelReaderOnAbort = (): void => {
    reader.cancel().catch(() => undefined);
  };
  idleController.signal.addEventListener("abort", cancelReaderOnAbort, {
    once: true,
  });

  try {
    while (true) {
      if (idleController.signal.aborted) {
        if (idleFired) {
          throw new ProviderError(
            `Provider stream stalled — no data for ${Math.round(idleTimeoutMs / 1000)}s.`,
          );
        }
        throw callerAbortError();
      }
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await readWithAbort(reader, idleController.signal);
      } catch (error) {
        if (idleFired) {
          throw new ProviderError(
            `Provider stream stalled — no data for ${Math.round(idleTimeoutMs / 1000)}s.`,
          );
        }
        throw error;
      }
      const { done, value } = readResult;
      if (done) {
        if (idleFired) {
          throw new ProviderError(
            `Provider stream stalled — no data for ${Math.round(idleTimeoutMs / 1000)}s.`,
          );
        }
        break;
      }
      if (value) {
        bytesRead += value.byteLength;
        if (bytesRead > maxBytes) {
          throw new ProviderError(
            `Provider stream exceeded ${maxBytes.toLocaleString()} bytes — aborting.`,
          );
        }
      }
      resetIdleTimer();
      options.onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) yield line;
    }
    if (buffer.length > 0) yield buffer;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", onCallerAbort);
    idleController.signal.removeEventListener("abort", cancelReaderOnAbort);
    
    void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail: "high" } };

/** Result of OpenAI-compatible complete/stream (text + optional native tools). */
export interface OpenAiCompatibleResult {
  text: string;
  toolCalls?: NativeToolCall[] | undefined;
  finishReason?: string | undefined;
  usage?: TokenUsage | undefined;
}

/** Map shared OpenAI-compatible payload → CompletionResult (includes usage). */
export function toCompletionResult(
  provider: ProviderId,
  model: string,
  payload: OpenAiCompatibleResult,
): import("../types.js").CompletionResult {
  return {
    text: payload.text,
    provider,
    model,
    ...(payload.toolCalls?.length ? { toolCalls: payload.toolCalls } : {}),
    ...(payload.finishReason ? { finishReason: payload.finishReason } : {}),
    ...(payload.usage ? { usage: payload.usage } : {}),
  };
}

/**
 * Reassembles SSE `data:` frames.
 *
 * Per the SSE spec a single event's payload may be split across several `data:`
 * lines that the client must concatenate before parsing; each fragment was
 * previously parsed on its own, failed `JSON.parse`, and was dropped as a
 * malformed keepalive — losing content without a trace.
 *
 * A payload is released as soon as it is syntactically complete, so
 * single-line frames behave exactly as before. A blank line (frame terminator)
 * discards an incomplete remainder, and a runaway fragment is dropped rather
 * than corrupting later frames.
 */
export function createSseFrameAssembler(options?: {
  maxBufferedBytes?: number;
}): {
  /** Returns a complete payload, or undefined while still buffering. */
  pushLine: (line: string) => string | undefined;
} {
  const maxBufferedBytes = options?.maxBufferedBytes ?? 1_000_000;
  let buffered = "";
  const complete = (payload: string): boolean => {
    if (payload === "[DONE]") return true;
    try {
      JSON.parse(payload);
      return true;
    } catch {
      return false;
    }
  };
  return {
    pushLine(line: string): string | undefined {
      const trimmed = line.trim();
      if (trimmed === "") {
        // End of event: an incomplete remainder was malformed.
        buffered = "";
        return undefined;
      }
      if (!trimmed.startsWith("data:")) return undefined;
      const chunk = trimmed.slice(5).trim();
      buffered = buffered ? `${buffered}\n${chunk}` : chunk;
      if (complete(buffered)) {
        const payload = buffered;
        buffered = "";
        return payload;
      }
      if (buffered.length > maxBufferedBytes) buffered = "";
      return undefined;
    },
  };
}

export function toOpenAiMessages(
  messages: ChatMessage[],
  supportsVision = true,
): Array<Record<string, unknown>> {
  return toOpenAiToolMessages(messages, (message) => {
    if (
      supportsVision &&
      message.images &&
      message.images.length > 0
    ) {
      const parts: OpenAiContentPart[] = [];
      if (message.content) parts.push({ type: "text", text: message.content });
      for (const img of message.images) {
        parts.push({
          type: "image_url",
          image_url: {
            url: `data:${img.mediaType};base64,${img.dataBase64}`,
            detail: "high",
          },
        });
      }
      return parts;
    }
    return message.content;
  }) as Array<Record<string, unknown>>;
}

export type ReasoningStyle =
  | "openai"
  | "nvidia"
  | "groq"
  | "openrouter"
  | "agentrouter"
  | "none";


export type NvidiaReasoningKind =
  | "kimi-thinking" // Kimi K2.6 — reasoning is on by default; `thinking:false` disables it
  | "deepseek-v4" // DeepSeek V4 — `thinking` plus V4's none/high reasoning effort
  | "thinking" // DeepSeek-R1/V3, older Nemotron — `chat_template_kwargs.thinking`
  | "nemotron-3" // Nemotron-3 — `enable_thinking` + reasoning_budget
  | "glm-thinking" // GLM-5/4.5 — `enable_thinking` + `clear_thinking:false`
  | "enable-thinking" // Gemma 3/4 — `chat_template_kwargs.enable_thinking`
  | "effort-only" // gpt-oss, qwen3, mistral 3+ — top-level `reasoning_effort`
  | "none"; // Llama, MiniMax m2.x, Step, Sarvam — no thinking knob

export function classifyNvidiaModel(model: string): NvidiaReasoningKind {
  const m = model.toLowerCase();
  if (/kimi-k2(?:\.6|-thinking|-instruct)?/.test(m)) return "kimi-thinking";
  if (/deepseek-v4/.test(m)) return "deepseek-v4";
  // Match newer Nemotron-3 (uses enable_thinking + reasoning_budget) before
  // the legacy Nemotron pattern below — the older `nemotron` bucket would
  // otherwise swallow these too.
  if (/nemotron-3/.test(m)) return "nemotron-3";
  if (/glm-?[345]/.test(m)) return "glm-thinking";
  if (/gemma-?[34]/.test(m)) return "enable-thinking";
  if (/deepseek-(?:v3|r1)|nemotron/.test(m)) return "thinking";
  if (/gpt-oss|qwen3|mistral-(?:medium|small|large)-(?:[3-9]|\d{2,})/.test(m))
    return "effort-only";
  return "none";
}

function supportsOpenRouterReasoning(model: string): boolean {
  return /:thinking|deepseek-r1|qwen3|kimi-k2|claude-(?:opus|sonnet|haiku)-4|gpt-5|(?:^|\/)o[134]|grok.*reasoner/i.test(
    model,
  );
}

export function buildReasoningPayload(
  reasoning: ReasoningPreference | undefined,
  style: ReasoningStyle,
  model?: string,
): Record<string, unknown> {
  if (style === "none") return {};
  const enabled = Boolean(reasoning?.enabled);
  const effort = reasoning?.effort ?? "medium";

  // Map expanded effort levels to the classic low/medium/high subset for
  // providers that only understand the smaller set.
  const clampEffort = (e: string): "low" | "medium" | "high" => {
    if (e === "none" || e === "minimal" || e === "low") return "low";
    if (e === "xhigh" || e === "high") return "high";
    return "medium";
  };

  switch (style) {
    case "openai": {
      if (!enabled) return {};
      // LLM-005: `reasoning_effort` is the Chat Completions knob. The nested
      // `reasoning` object belongs to the Responses API; strict gateways reject
      // unknown top-level fields with a hard 400.
      return { reasoning_effort: clampEffort(effort) };
    }
    case "agentrouter": {
      // AgentRouter proxies three families, each with a *different* reasoning
      // contract (verified live against agentrouter.org/v1, 2026-07). We send
      // only the standard top-level knob each one honours — no redundant
      // `reasoning` object (none of the routed models read it).
      const m = (model ?? "").toLowerCase();
      const clamped = clampEffort(effort);
      // OpenAI gpt-5.x / o-series: top-level `reasoning_effort`, and it uniquely
      // supports "minimal". These models can't be fully disabled, so "off"
      // degrades to the cheapest "minimal" rather than the medium default.
      if (/(?:^|\/)gpt-5|(?:^|\/)o[134](?:\b|-)/.test(m)) {
        if (!enabled) return { reasoning_effort: "minimal" };
        const gptEffort =
          effort === "none"
            ? "minimal"
            : effort === "xhigh"
              ? "high"
              : effort; // minimal | low | medium | high
        return { reasoning_effort: gptEffort };
      }
      // Zhipu GLM thinks by DEFAULT; `reasoning_effort` only modulates depth and
      // cannot turn it off. The one knob that actually disables it on this
      // gateway is `thinking.type=disabled` — so "off" must send that.
      if (/glm/.test(m)) {
        if (!enabled) return { thinking: { type: "disabled" } };
        return { reasoning_effort: clamped };
      }
      // Anthropic Claude: `reasoning_effort` enables extended thinking (the
      // gateway maps it to a thinking budget). Thinking is OFF by default, so
      // "off" simply omits the knob. `buildChatBody` floors max_tokens above the
      // budget so enabling it never trips the gateway's budget precondition.
      if (/claude/.test(m)) {
        if (!enabled) return {};
        return { reasoning_effort: clamped };
      }
      // Unknown model routed by AgentRouter → plain OpenAI-compatible behavior.
      if (!enabled) return {};
      return { reasoning_effort: clamped };
    }
    case "openrouter":
      if (!enabled) return {};
      if (!supportsOpenRouterReasoning(model ?? "")) return {};
      return { reasoning: { enabled: true, effort: clampEffort(effort) } };
    case "groq": {
      const m = (model ?? "").toLowerCase();
      if (/qwen\/qwen3-32b/.test(m)) {
        return { reasoning_effort: enabled ? "default" : "none" };
      }
      if (/openai\/gpt-oss-(?:20b|120b)/.test(m)) {
        
        return enabled
          ? { reasoning_effort: clampEffort(effort), include_reasoning: true }
          : { reasoning_effort: "low", include_reasoning: false };
      }
      return {};
    }
    case "nvidia": {
      const kind = classifyNvidiaModel(model ?? "");
      switch (kind) {
        case "kimi-thinking":
          return {
            chat_template_kwargs: {
              thinking: enabled,
            },
          };
        case "deepseek-v4":
          // NVIDIA's DeepSeek V4 API accepts none/high/max. Map expanded
          // effort levels: none/minimal/low → none; medium/high/xhigh → high.
          return {
            chat_template_kwargs: {
              thinking: enabled,
              reasoning_effort: enabled
                ? clampEffort(effort) === "low"
                  ? "none"
                  : "high"
                : "none",
            },
          };
        case "thinking":
          return {
            chat_template_kwargs: {
              thinking: enabled,
            },
          };
        case "nemotron-3": {
          // Nemotron-3 supports both `enable_thinking` and an optional
          // `reasoning_budget` cap. Map expanded effort to budget values.
          if (!enabled) {
            return {
              chat_template_kwargs: { enable_thinking: false },
            };
          }
          const clamped = clampEffort(effort);
          const budget =
            clamped === "low" ? 4_096 : clamped === "high" ? 16_384 : 8_192;
          return {
            reasoning_budget: budget,
            chat_template_kwargs: { enable_thinking: true },
          };
        }
        case "glm-thinking":
          // GLM-5 / 4.5 expects `clear_thinking:false` alongside
          // `enable_thinking:true` per the NIM docs example.
          return {
            chat_template_kwargs: enabled
              ? { enable_thinking: true, clear_thinking: false }
              : { enable_thinking: false },
          };
        case "enable-thinking":
          // Gemma 3/4 only documents `enable_thinking`; do not add
          // `clear_thinking` here since the chat template doesn't accept it.
          return {
            chat_template_kwargs: { enable_thinking: enabled },
          };
        case "effort-only":
          // NVIDIA GPT-OSS accepts only low/medium/high, so a retry cannot
          // fully disable it. Keep it at the lowest supported effort instead
          // of omitting the field and reverting to NVIDIA's medium default.
          if (!enabled && /gpt-oss/i.test(model ?? "")) {
            return { reasoning_effort: "low" };
          }
          if (!enabled && /qwen3|mistral-/i.test(model ?? "")) {
            return { reasoning_effort: "none" };
          }
          return { reasoning_effort: clampEffort(effort) };
        case "none":
        default:
          return {};
      }
    }
    default:
      return {};
  }
}

/**
 * Detects provider errors that mean the model rejected one of our
 * reasoning/thinking knobs (chat_template_kwargs, enable_thinking,
 * clear_thinking, reasoning_effort, reasoning_budget, thinking). NVIDIA NIM and
 * other OpenAI-compatible gateways return a 400/422 for chat templates that do
 * not accept these fields. When this matches, the router strips the reasoning
 * payload and retries so an unsupported option never fails the whole request.
 */
export function isReasoningUnsupportedError(error: unknown): boolean {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: number }).status)
      : undefined;
  const body =
    error && typeof error === "object" && "body" in error
      ? String((error as { body?: string }).body ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  const hay = `${message}\n${body}`.toLowerCase();

  const mentionsReasoningKnob =
    // `\breasoning\b` catches bodies like "Unrecognized request argument
    // supplied: reasoning" so a bare reasoning-field rejection also degrades.
    /chat_template_kwargs|enable_thinking|clear_thinking|reasoning_effort|reasoning_budget|reasoning_content|\breasoning\b|\bthinking\b/.test(
      hay,
    );
  if (!mentionsReasoningKnob) return false;

  // A 4xx that names a reasoning field is a parameter rejection — strip it.
  if (status === 400 || status === 422) return true;

  // Any status: explicit "not supported / unknown / invalid parameter" wording.
  return /not support|unsupported|unknown|unrecognized|not a valid|not allowed|unexpected keyword|does not accept|extra fields not permitted|additional propert|invalid[_ ]?(?:request[_ ]?)?(?:argument|parameter|field)/.test(
    hay,
  );
}

/**
 * legacy Chat Completions sampling knobs: `max_tokens` must be
 * `max_completion_tokens`, and `temperature`/`top_p` must be omitted or left
 * at their default (non-default values return HTTP 400 "Unsupported
 * parameter"). Matched by model name (not provider) since OpenAI-compatible
 * gateways that pass these model IDs through to the real OpenAI API hit the
 * same restriction.
 * https://help.openai.com/en/articles/5072518 (Chat Completions section).
 */
export function isOpenAiReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return /(?:^|\/)gpt-5(?:\.|-|$)/.test(m) || /(?:^|\/)o[134](?:\.|-|$)/.test(m);
}

export function buildChatBody(options: {
  model: string;
  /**
   * Canonical provider id. When given, the capability table is consulted so the
   * wire payload and the UI cannot disagree about whether the model has a
   * reasoning knob at all.
   */
  providerId?: ProviderId | undefined;
  messages: ChatMessage[];
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  stream: boolean;
  reasoning?: ReasoningPreference | undefined;
  reasoningStyle?: ReasoningStyle | undefined;
  supportsVision?: boolean | undefined;
  tools?: ToolDefinition[] | undefined;
  toolChoice?: ToolChoice | undefined;
  parallelToolCalls?: boolean | undefined;
}): string {
  // Skip reasoning knobs entirely for models observed to reject them this
  // session (see isReasoningUnsupportedError). This is how thinking degrades
  // gracefully: the request still runs, just without the unsupported option.
  const capabilityDeniesThinking =
    options.providerId !== undefined &&
    Boolean(options.reasoning?.enabled) &&
    !modelSupportsThinking(options.providerId, options.model);
  const reasoning =
    isReasoningUnsupported(options.model) || capabilityDeniesThinking
      ? {}
      : buildReasoningPayload(
          options.reasoning,
          options.reasoningStyle ?? "none",
          options.model,
        );
  
  const reasoningOn = Boolean(options.reasoning?.enabled);
  // Kimchi exposes this model as `minimax-m3`; NVIDIA uses the longer
  // `minimaxai/minimax-m3` ID. Both need the larger default output budget.
  const isMinimaxM3 = /minimax-m3/i.test(options.model);
  const defaultMaxTokens = isMinimaxM3 ? 8_192 : reasoningOn ? 8_192 : 4_096;
  // LLM-010: one declarative sampling policy; explicit caller value wins.
  const sampling = resolveSampling({
    model: options.model,
    reasoningEnabled: reasoningOn,
    requestedTemperature: options.temperature,
  });
  const reasoningModel = isOpenAiReasoningModel(options.model);
  // Claude extended thinking via AgentRouter maps reasoning_effort to an
  // Anthropic `thinking.budget_tokens`, and the gateway (Bedrock) rejects the
  // request with HTTP 400 unless `max_tokens > budget_tokens`. Some upstream
  // nodes enforce this intermittently, so whenever Claude reasoning is enabled
  // we guarantee a ceiling that clears the largest effort budget (32000 was
  // verified live to succeed while staying within Opus's output cap). This is a
  // ceiling, not a forced length — Claude still stops at its natural stop.
  const claudeThinking =
    reasoningOn &&
    options.reasoningStyle === "agentrouter" &&
    /claude/i.test(options.model);
  const effectiveMaxTokens = claudeThinking
    ? Math.max(options.maxTokens ?? defaultMaxTokens, 32_000)
    : (options.maxTokens ?? defaultMaxTokens);
  const body: Record<string, unknown> = {
    model: options.model,
    messages: toOpenAiMessages(options.messages, options.supportsVision),
    stream: options.stream,
    ...(reasoningModel
      ? { max_completion_tokens: effectiveMaxTokens }
      : { max_tokens: effectiveMaxTokens }),
    // gpt-5.x / o1 / o3 / o4 only accept the default temperature (1) and
    // reject any explicit value — omit the field entirely rather than send
    // our 0.2 default and get a 400.
    ...(reasoningModel ? {} : { temperature: sampling.temperature }),
    ...reasoning,
    ...openAiToolBodyFields({
      tools: options.tools,
      toolChoice: options.toolChoice,
      parallelToolCalls: options.parallelToolCalls,
    }),
  };
  if (!reasoningModel && sampling.topP !== undefined) {
    body.top_p = sampling.topP;
  }
  // OpenAI + many OpenAI-compatible gateways attach usage on the final SSE
  // chunk when this is set (non-stream responses always include usage).
  if (options.stream) {
    body.stream_options = { include_usage: true };
  }
  return JSON.stringify(body);
}

export async function openAiCompatibleComplete(options: {
  provider: string;
  /** Canonical provider id used for capability lookups (LLM-001). */
  providerId: ProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  reasoning?: ReasoningPreference | undefined;
  reasoningStyle?: ReasoningStyle | undefined;
  tools?: ToolDefinition[] | undefined;
  toolChoice?: ToolChoice | undefined;
  parallelToolCalls?: boolean | undefined;
}): Promise<OpenAiCompatibleResult> {
  const supportsVision = modelSupportsVision(options.providerId, options.model);
  const requestBody = buildChatBody({
    model: options.model,
    providerId: options.providerId,
    messages: options.messages,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    stream: false,
    reasoning: options.reasoning,
    reasoningStyle: options.reasoningStyle,
    supportsVision,
    tools: options.tools,
    toolChoice: options.toolChoice,
    parallelToolCalls: options.parallelToolCalls,
  });
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}/chat/completions`, {
      method: "POST",
      signal: options.signal ?? null,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${options.apiKey}`,
        ...options.headers,
      },
      body: requestBody,
      verbose: process.env.CLAI_VERBOSE === "true",
    } as any);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    const msg = error instanceof Error ? error.message : String(error);
    throw new ProviderError(
      `${options.provider} request could not be sent (${msg}). Check connectivity to ${options.baseUrl}.`,
    );
  }
  let data: {
    choices?: Array<{
      finish_reason?: string;
      message?: {
        content?: string | null;
        reasoning_content?: string;
        reasoning?: string;
        tool_calls?: Array<{
          id?: string;
          type?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
    usage?: unknown;
  };
  try {
    data = await readJson(response);
  } catch (error) {
    if (error instanceof ProviderError) {
      throw new ProviderError(
        `${options.provider} (model=${options.model}): ${error.message}`,
        error.status,
        error.body,
        error.retryAfterSeconds,
      );
    }
    throw error;
  }
  const choice = data.choices?.[0];
  const message = choice?.message;
  const toolCalls = parseOpenAiMessageToolCalls(message?.tool_calls);
  const text = message?.content ?? "";
  if (!text && toolCalls.length === 0) {
    throw new ProviderError(
      `${options.provider} returned no completion text (model=${options.model}). The response was empty — try /variants off, raise max_tokens, or pick another model with /model.`,
    );
  }
  // If the API returns reasoning separately, prepend it inside <think>
  // tags so the existing thinking parser can pick it up uniformly.
  const reasoning = message?.reasoning_content ?? message?.reasoning;
  const full =
    reasoning && reasoning.trim()
      ? `<think>${reasoning}</think>${text}`
      : text;
  const usage = parseOpenAiUsage(data.usage);
  return {
    text: full,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(choice?.finish_reason
      ? { finishReason: choice.finish_reason }
      : toolCalls.length
        ? { finishReason: "tool_calls" }
        : {}),
    ...(usage ? { usage } : {}),
  };
}

export async function openAiCompatibleStream(options: {
  provider: string;
  /** Canonical provider id used for capability lookups (LLM-001). */
  providerId: ProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  onToken: (token: string) => void;
  reasoning?: ReasoningPreference | undefined;
  reasoningStyle?: ReasoningStyle | undefined;
  tools?: ToolDefinition[] | undefined;
  toolChoice?: ToolChoice | undefined;
  parallelToolCalls?: boolean | undefined;
  /** Early native tool-call name/args progress (P2-3). */
  onToolCallDelta?:
    | ((delta: {
        index: number;
        id?: string;
        name?: string;
        argumentsBytes?: number;
      }) => void)
    | undefined;
  /** Abort a stream that produces no bytes for this long. Default 30s. */
  idleTimeoutMs?: number | undefined;
  
  initialIdleTimeoutMs?: number | undefined;
}): Promise<OpenAiCompatibleResult> {
  // Combine the caller's abort signal with an idle watchdog so a stuck
  // connection can't wedge the REPL forever. Thinking models get a much
  // longer first-byte budget and a longer mid-stream silence budget —
  // the old 30s default aborted healthy Bynara/OpenRouter streams that
  // were still "thinking" without tokens.
  const reasoningOn = Boolean(options.reasoning?.enabled);
  const idleTimeoutMs =
    options.idleTimeoutMs ??
    (reasoningOn
      ? THINKING_STREAM_IDLE_TIMEOUT_MS
      : DEFAULT_STREAM_IDLE_TIMEOUT_MS);
  const initialIdleTimeoutMs =
    options.initialIdleTimeoutMs ??
    (reasoningOn
      ? THINKING_STREAM_INITIAL_IDLE_TIMEOUT_MS
      : idleTimeoutMs);
  const idleController = new AbortController();
  let idleTimer: NodeJS.Timeout | undefined;
  let idleFired = false;
  
  let sawStreamProgress = false;
  let activeIdleTimeoutMs = initialIdleTimeoutMs;
  const resetIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    activeIdleTimeoutMs = sawStreamProgress ? idleTimeoutMs : initialIdleTimeoutMs;
    idleTimer = setTimeout(() => {
      idleFired = true;
      idleController.abort();
    }, activeIdleTimeoutMs);
  };
  resetIdleTimer();
  const onCallerAbort = (): void => idleController.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });

  const supportsVision = modelSupportsVision(options.providerId, options.model);
  const requestBody = buildChatBody({
    model: options.model,
    providerId: options.providerId,
    messages: options.messages,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    stream: true,
    reasoning: options.reasoning,
    reasoningStyle: options.reasoningStyle,
    supportsVision,
    tools: options.tools,
    toolChoice: options.toolChoice,
    parallelToolCalls: options.parallelToolCalls,
  });
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}/chat/completions`, {
      method: "POST",
      signal: idleController.signal,
      headers: {
        "content-type": "application/json",
    
        accept: "text/event-stream",
        authorization: `Bearer ${options.apiKey}`,
        ...options.headers,
      },
      body: requestBody,
      verbose: process.env.CLAI_VERBOSE === "true",
    } as any);
  } catch (error) {
    if (idleTimer) clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", onCallerAbort);
    if (idleFired) {
      throw new ProviderError(
        `${options.provider} request timed out before any response (${Math.round(activeIdleTimeoutMs / 1000)}s)`,
      );
    }
    throw error;
  }
  if (!response.ok) {
    if (idleTimer) clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", onCallerAbort);
    try {
      await readJson<unknown>(response);
    } catch (error) {
      if (error instanceof ProviderError) {
        throw new ProviderError(
          `${options.provider} (model=${options.model}): ${error.message}`,
          error.status,
          error.body,
          error.retryAfterSeconds,
        );
      }
      throw error;
    }
  }
  if (!response.body) {
    if (idleTimer) clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", onCallerAbort);
    throw new ProviderError(`${options.provider} returned no stream body`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (response.status === 202 || /\bapplication\/json\b/i.test(contentType)) {
    if (idleTimer) clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", onCallerAbort);
    const data = await readJson<{
      id?: string;
      requestId?: string;
      status?: string;
      usage?: unknown;
      choices?: Array<{
        finish_reason?: string;
        message?: {
          content?: string | null;
          reasoning_content?: string;
          reasoning?: string;
          tool_calls?: Array<{
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    }>(response);
    if (response.status === 202) {
      const requestId = data.requestId ?? data.id;
      throw new ProviderError(
        `${options.provider} returned a pending async response${requestId ? ` (${requestId})` : ""}; streaming did not start.`,
        response.status,
        JSON.stringify(data).slice(0, 1_000),
      );
    }
    const choice = data.choices?.[0];
    const message = choice?.message;
    const toolCalls = parseOpenAiMessageToolCalls(message?.tool_calls);
    const text = message?.content ?? "";
    const reasoning = message?.reasoning_content ?? message?.reasoning;
    const full =
      reasoning && reasoning.trim()
        ? `<think>${reasoning}</think>${text}`
        : text;
    const jsonUsage = parseOpenAiUsage(data.usage);
    if (full.trim() || toolCalls.length > 0) {
      if (full.trim()) options.onToken(full);
      return {
        text: full,
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(choice?.finish_reason
          ? { finishReason: choice.finish_reason }
          : toolCalls.length
            ? { finishReason: "tool_calls" }
            : {}),
        ...(jsonUsage ? { usage: jsonUsage } : {}),
      };
    }
    throw new ProviderError(
      `${options.provider} returned JSON instead of an SSE stream, but no completion text was present.`,
      response.status,
      JSON.stringify(data).slice(0, 1_000),
    );
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let full = "";
  let visible = "";
  let reasoningSeen = "";
  let inReasoning = false;
  let finishReason: string | undefined;
  let streamUsage: TokenUsage | undefined;
  const toolCallState = new Map<
    number,
    { id?: string; name?: string; arguments: string }
  >();

  const enterReasoning = (): void => {
    if (inReasoning) return;
    inReasoning = true;
    full += "<think>";
    options.onToken("<think>");
  };
  const exitReasoning = (): void => {
    if (!inReasoning) return;
    inReasoning = false;
    full += "</think>";
    options.onToken("</think>");
  };

  const cleanup = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", onCallerAbort);
    idleController.signal.removeEventListener("abort", cancelReaderOnAbort);
  };
  const cancelReaderOnAbort = (): void => {
    reader.cancel().catch(() => undefined);
  };
  idleController.signal.addEventListener("abort", cancelReaderOnAbort, {
    once: true,
  });
  const sseFrames = createSseFrameAssembler();

  try {
    while (true) {
      options.signal?.throwIfAborted();
      if (idleController.signal.aborted) {
        throw new Error("Stream aborted");
      }
      const { done, value } = await readWithAbort(reader, idleController.signal);
      options.signal?.throwIfAborted();
      if (idleController.signal.aborted) {
        throw new Error("Stream aborted");
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const payload = sseFrames.pushLine(line);
        if (payload === undefined) continue;
        if (payload === "[DONE]") {
          exitReasoning();
          cleanup();
          const toolCalls = finalizeOpenAiToolCalls(toolCallState);
          if (!visible.trim() && toolCalls.length === 0) {
            // Thinking models (Kimi/Moonshot via Mantle, etc.) often emit only
            // reasoning, sometimes with tool sentinels inside <think>. Returning
            // the full text lets the agent runner recover tool calls from
            // thinkContent instead of failing the whole stream as an error.
            if (reasoningSeen.trim()) {
              return {
                text: full,
                ...(finishReason ? { finishReason } : { finishReason: "stop" }),
                ...(streamUsage ? { usage: streamUsage } : {}),
              };
            }
            throw new ProviderError(
              `${options.provider} completed without a visible answer.`,
            );
          }
          return {
            text: full,
            ...(toolCalls.length ? { toolCalls } : {}),
            ...(finishReason
              ? { finishReason }
              : toolCalls.length
                ? { finishReason: "tool_calls" }
                : {}),
            ...(streamUsage ? { usage: streamUsage } : {}),
          };
        }
        let parsed: {
          error?: { message?: string; type?: string } | string;
          usage?: unknown;
          choices?: Array<{
            finish_reason?: string;
            delta?: {
              content?: string;
              reasoning_content?: string;
              reasoning?: string;
              role?: string;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
        };
        try {
          // LLM-011: only JSON.parse is allowed to fail silently here. The
          // delta handlers below (tool-arg size guard, UI callbacks) used to be
          // inside this try and had their errors swallowed as "keepalives".
          parsed = JSON.parse(payload) as typeof parsed;
        } catch {
          // Malformed keepalive / comment line.
          continue;
        }
        // LLM-011: gateways report mid-stream failures as an error frame; that
        // used to be dropped, so an upstream overload looked like a complete
        // (but truncated) answer.
        if (parsed.error) {
          const detail =
            typeof parsed.error === "string"
              ? parsed.error
              : (parsed.error.message ?? parsed.error.type ?? "unknown error");
          throw new ProviderError(
            `${options.provider} stream error: ${detail}`,
            undefined,
            payload.slice(0, 500),
          );
        }
        {
          const chunkUsage = parseOpenAiUsage(parsed.usage);
          if (chunkUsage) streamUsage = chunkUsage;
          const choice = parsed.choices?.[0];
          // Reset only for an actual completion event. Blank SSE heartbeats
          // and comments otherwise keep a frozen request alive forever.
          // Usage-only final chunks (stream_options.include_usage) also count.
          if (choice?.delta || choice?.finish_reason || chunkUsage) {
            sawStreamProgress = true;
            resetIdleTimer();
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const delta = choice?.delta;
          const reasoningToken = delta?.reasoning_content ?? delta?.reasoning;
          if (reasoningToken) {
            enterReasoning();
            reasoningSeen += reasoningToken;
            full += reasoningToken;
            options.onToken(reasoningToken);
          }
          const token = delta?.content;
          if (token) {
            if (inReasoning) exitReasoning();
            visible += token;
            full += token;
            options.onToken(token);
          }
          if (delta?.tool_calls?.length) {
            for (const tc of delta.tool_calls) {
              const accInfo = accumulateOpenAiToolCallDelta(toolCallState, tc);
              if (!options.onToolCallDelta) continue;
              const wire = accInfo.name;
              const canonical = wire
                ? (fromWireName(wire) ?? wire)
                : undefined;
              
              const largeArgTick =
                !accInfo.nameBecameKnown &&
                accInfo.argumentsBytes > 0 &&
                accInfo.argumentsBytes % 4096 <
                  (typeof tc.function?.arguments === "string"
                    ? tc.function.arguments.length
                    : 0);
              if (accInfo.nameBecameKnown || largeArgTick) {
                options.onToolCallDelta({
                  index: accInfo.index,
                  ...(accInfo.id !== undefined ? { id: accInfo.id } : {}),
                  ...(canonical !== undefined ? { name: canonical } : {}),
                  argumentsBytes: accInfo.argumentsBytes,
                });
              }
            }
          }
        }
      }
    }
    exitReasoning();
    cleanup();
    const toolCalls = finalizeOpenAiToolCalls(toolCallState);
    if (!visible.trim() && toolCalls.length === 0) {
      // See [DONE] branch — hand thinking-only streams to the runner so it can
      // salvage sentinel tool blocks (or nudge) instead of hard-failing.
      if (reasoningSeen.trim()) {
        return {
          text: full,
          ...(finishReason ? { finishReason } : { finishReason: "stop" }),
          ...(streamUsage ? { usage: streamUsage } : {}),
        };
      }
      throw new ProviderError(
        `${options.provider} completed without a visible answer.`,
      );
    }
    return {
      text: full,
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(finishReason
        ? { finishReason }
        : toolCalls.length
          ? { finishReason: "tool_calls" }
          : {}),
      ...(streamUsage ? { usage: streamUsage } : {}),
    };
  } catch (error) {
    if (idleFired) {
      throw new ProviderError(
        `${options.provider} stream stalled — no model output for ${Math.round(activeIdleTimeoutMs / 1000)}s. Try a smaller model or disable thinking with /variants off.`,
      );
    }
    throw error;
  } finally {
    // LLM-011: the success paths used to return without releasing the body, so
    // the socket stayed locked until GC — dozens of leaked connections per
    // long agent turn.
    cleanup();
    void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

export async function openAiCompatiblePing(
  baseUrl: string,
  apiKey: string,
  headers?: Record<string, string> | undefined,
): Promise<void> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...headers,
    },
    verbose: process.env.CLAI_VERBOSE === "true",
  } as any);
  await readJson<unknown>(response);
}
