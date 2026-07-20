import type {
  CompletionRequest,
  CompletionResult,
  ProviderId,
} from "../types.js";
import { getConfig, providerCategory } from "../store/config.js";
import {
  getProviderKeys,
  getProviderSecret,
  markProviderKeySuccess,
} from "../store/keys.js";
import { anthropicProvider } from "./anthropic.js";
import { geminiProvider } from "./gemini.js";
import { groqProvider } from "./groq.js";
import { ProviderError } from "./http.js";
import {
  attemptsPerKey,
  buildKeyAttemptPlan,
  formatKeyEventStatus,
  isImmediateKeySwitchError,
  isKeyCircleStopError,
  isKeyRotatableError,
  isQuotaKeyError,
  type ProviderKeyEvent,
} from "./key-rotation.js";
import { nvidiaProvider } from "./nvidia.js";
import { agentrouterProvider } from "./agentrouter.js";
import { kimchiProvider } from "./kimchi.js";
import { bynaraProvider } from "./bynara.js";
import { mantleProvider } from "./aws-mantle.js";
import { ollamaProvider } from "./ollama.js";
import { openaiProvider } from "./openai.js";
import { openrouterProvider } from "./openrouter.js";
import { qwenCloudProvider } from "./qwen-cloud.js";
import type { LlmProvider, ProviderAuth } from "./provider.js";
import { maskSecretTail } from "./provider.js";
import {
  isToolsUnsupportedError,
  markTextOnlyModel,
} from "./tool-protocol.js";

const MAX_RETRIES = 6;
// Wait at most this long overall per attempt (up to 2 minutes total wait budget).
const MAX_RETRY_WAIT_MS = 120_000;

/** Toast replace-key so key rotation never stacks notifications. */
export const API_KEY_TOAST_KEY = "api-key-rotation";

export type ProviderKeyEventHandler = (event: ProviderKeyEvent) => void;

export interface StreamWithProviderOptions {
  readonly onStatus?: ((message: string) => void) | undefined;
  readonly onKeyEvent?: ProviderKeyEventHandler | undefined;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout;
    let cleanup = (): void => {};
    const abort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error("Aborted"));
    };
    cleanup = (): void => {
      signal?.removeEventListener("abort", abort);
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function isRateLimited(error: unknown): boolean {
  return error instanceof ProviderError && error.status === 429;
}

function isTransientNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const msg = message.toLowerCase();
  return (
    msg.includes("socket connection was closed unexpectedly") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("fetch failed") ||
    msg.includes("network error") ||
    msg.includes("timeout") ||
    msg.includes("unexpected end of file") ||
    msg.includes("premature close")
  );
}

function isRetriableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Mid-stream stalls used to be non-retriable (to avoid infinite hangs).
  // One quick retry on the same provider recovers flaky thinking pauses
  // without waiting forever — MAX_RETRIES still bounds the loop.
  if (/stream stalled|request timed out before any response/i.test(message)) {
    return true;
  }
  if (isRateLimited(error)) return true;
  if (error instanceof ProviderError) {
    const status = error.status ?? 0;
    if (status >= 500 && status <= 504) {
      return true;
    }
  }
  return isTransientNetworkError(error);
}

function retryWaitMs(error: unknown, attempt: number): number {
  if (error instanceof ProviderError && error.retryAfterSeconds !== undefined) {
    return Math.ceil(error.retryAfterSeconds * 1000);
  }
  // Exponential backoff: 2s, 6s, 18s, 54s, etc.
  return Math.pow(3, attempt) * 2_000;
}

function networkRetryWaitMs(attempt: number): number {
  return Math.pow(2, attempt) * 1_000;
}

function failureReason(error: unknown): string {
  if (isRateLimited(error)) return "rate limited";
  if (isQuotaKeyError(error)) {
    const status =
      error instanceof ProviderError && error.status ? ` (${error.status})` : "";
    return `insufficient credits${status}`;
  }
  if (error instanceof ProviderError && error.status) {
    if (error.status === 401 || error.status === 403) {
      return `auth failed (${error.status})`;
    }
    return `server error (${error.status})`;
  }
  return "connection glitch";
}

/**
 * User-facing classification of provider failures (auth, capacity, disconnect,
 * empty admission, context limit). Used by the fallback table and tests.
 */
export function formatProviderFailureForUser(error: unknown): string {
  if (error instanceof ProviderError) {
    // Keep the provider's own message in the transcript. The classification
    // below is useful guidance, but hiding an upstream 429/body detail makes
    // it needlessly hard to tell OpenAI and Gemini failures apart.
    const exactError = error.message.replace(/\s+/g, " ").trim();
    const withExactError = (guidance: string): string =>
      exactError ? `${guidance}\nExact provider error: ${exactError}` : guidance;
    const status = error.status ?? 0;
    if (status === 429) {
      return withExactError(
        "Model is rate limited (429). Try another provider/model or switch to a paid plan.",
      );
    }
    if (status === 401 || status === 403) {
      return withExactError(
        `Authentication/authorization failed (${status}). Check the API key with \`clai providers\` or set the provider env var.`,
      );
    }
    if (status === 402) {
      return withExactError(
        "Insufficient credits / payment required (402). Try another API key for this provider, top up the account, or switch provider.",
      );
    }
    if (status === 404) {
      return withExactError(
        "Model or endpoint not found (404). Run `/model list` or pick another model.",
      );
    }
    if (status === 413) {
      return withExactError(
        "Request exceeded the provider input limit (413). Wait for auto-compact, run `/compact`, or continue with a smaller turn.",
      );
    }
    if (status === 422) {
      return withExactError(
        "Provider rejected the request body (422). Model name or parameters may be incompatible — try another model.",
      );
    }
    if (status === 503 || status === 502 || status === 504) {
      return withExactError(
        `Upstream provider unavailable (${status}). Retry shortly or switch provider/model; free-tier models are often capacity-constrained.`,
      );
    }
    if (status >= 500 && status < 600) {
      return withExactError(
        `Upstream provider error (${status}). Retry or switch with \`/provider\` / \`/model\`.`,
      );
    }
  }
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim();
  if (!message) {
    return "Provider returned an empty failure (no tokens billed). Model may be unavailable, overloaded, or rejected before admission — try another model.";
  }
  if (
    /socket connection was closed|econnreset|premature close|unexpected end of file/i.test(
      message,
    )
  ) {
    return `${message} — connection dropped mid-request (common on free/unstable routes). Retry or switch model; long contexts increase disconnect risk.`;
  }
  if (/stream stalled|request timed out before any response/i.test(message)) {
    return `${message} — no tokens arrived in time. Free models and large contexts fail more often; retry or use a more reliable model.`;
  }
  if (/no completion text|response was empty|empty response|returned no text/i.test(message)) {
    return `${message} — provider accepted the request but returned no content. Retry once; if it persists, switch model.`;
  }
  if (/fetch failed|network error|etimedout|enotfound|econnrefused/i.test(message)) {
    return `${message} — network/DNS failure reaching the provider. Check connectivity and provider base URL.`;
  }
  return message;
}

function summarizeProviderError(error: unknown): string {
  return formatProviderFailureForUser(error);
}

interface ProviderFailure {
  provider: ProviderId;
  message: string;
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function formatFailures(failures: ProviderFailure[]): string {
  if (failures.length === 0) return "";
  // Keep the first visible error self-contained. Some terminal renderers
  // truncate multiline notices, which previously left users with only
  // “No provider could stream the request.” and hid the useful provider body.
  return ` — ${failures
    .map((failure) => `${failure.provider}: ${escapeTableCell(failure.message)}`)
    .join("; ")}`;
}

/**
 * After all keys for a provider are exhausted, decide whether to try the next
 * *provider* in the fallback chain. Auth/rate-limit stop cross-provider when
 * only one key existed historically; with multi-key we already rotated keys.
 */
function shouldStopProviderFallback(error: unknown): boolean {
  if (error instanceof ProviderError) {
    return [401, 403, 404, 422, 429].includes(error.status ?? 0);
  }
  const message = error instanceof Error ? error.message : String(error);
  return /no completion text|response was empty|empty response|returned no text/i.test(message);
}

export const providers: Record<ProviderId, LlmProvider> = {
  groq: groqProvider,
  gemini: geminiProvider,
  openrouter: openrouterProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  nvidia: nvidiaProvider,
  agentrouter: agentrouterProvider,
  kimchi: kimchiProvider,
  "aws-mantle": mantleProvider,
  ollama: ollamaProvider,
  bynara: bynaraProvider,
  "qwen-cloud": qwenCloudProvider,
};

const fallbackOrder: ProviderId[] = [
  "nvidia",
  "groq",
  "gemini",
  "openrouter",
  "agentrouter",
  "kimchi",
  "bynara",
  "openai",
  "anthropic",
  "aws-mantle",
  "ollama",
  "qwen-cloud",
];


export function buildFallbackChain(
  requested: ProviderId,
  freeOnly: boolean,
  enabled = false,
): ProviderId[] {
  if (!enabled) return [requested];
  const filtered = freeOnly
    ? fallbackOrder.filter(
        (provider) =>
          provider === requested || providerCategory[provider] !== "paid-cloud",
      )
    : fallbackOrder;
  return [requested, ...filtered.filter((provider) => provider !== requested)];
}

export function getProvider(provider: ProviderId): LlmProvider {
  return providers[provider];
}

export async function providerAuth(
  provider: ProviderId,
): Promise<ProviderAuth> {
  const secret = await getProviderSecret(provider);
  if (provider === "ollama") {
    return { baseUrl: secret.value };
  }
  return { apiKey: secret.value };
}

function authForSlot(
  providerId: ProviderId,
  value: string | undefined,
): ProviderAuth {
  if (providerId === "ollama") {
    return { baseUrl: value };
  }
  return { apiKey: value };
}

type EmitKey = (event: ProviderKeyEvent) => void;

function makeKeyEmitter(
  onStatus?: (message: string) => void,
  onKeyEvent?: ProviderKeyEventHandler,
): EmitKey {
  return (event) => {
    onKeyEvent?.(event);
    // Quiet sticky start: never status-spam "using …" on every model step.
    // Surface only retries (composer countdown), switches (toast + status), exhausted.
    if (event.type === "using") return;
    const line = formatKeyEventStatus(event);
    if (event.type === "retry" || event.type === "switch" || event.type === "exhausted") {
      onStatus?.(line);
    }
  };
}

async function tryCompleteOnce(
  provider: LlmProvider,
  providerId: ProviderId,
  request: CompletionRequest,
  model: string,
  auth: ProviderAuth,
): Promise<CompletionResult> {
  const activeRequest = { ...request, provider: providerId, model };
  try {
    return await provider.complete(activeRequest, auth);
  } catch (toolError) {
    if (activeRequest.tools?.length && isToolsUnsupportedError(toolError)) {
      markTextOnlyModel(providerId, model);
      const textRequest = {
        ...activeRequest,
        tools: undefined,
        toolChoice: undefined,
        parallelToolCalls: undefined,
      };
      return await provider.complete(textRequest, auth);
    }
    throw toolError;
  }
}

async function tryStreamOnce(
  provider: LlmProvider,
  providerId: ProviderId,
  request: CompletionRequest,
  model: string,
  auth: ProviderAuth,
  onToken: (token: string) => void,
  onStatus?: (message: string) => void,
): Promise<CompletionResult> {
  const activeRequest = { ...request, provider: providerId, model };
  try {
    if (provider.stream) {
      return await provider.stream(activeRequest, auth, onToken);
    }
    const result = await provider.complete(activeRequest, auth);
    onToken(result.text);
    return result;
  } catch (toolError) {
    if (activeRequest.tools?.length && isToolsUnsupportedError(toolError)) {
      markTextOnlyModel(providerId, model);
      onStatus?.(
        `ℹ ${providerId}/${model} does not support native tools — falling back to text protocol`,
      );
      const textRequest = {
        ...activeRequest,
        tools: undefined,
        toolChoice: undefined,
        parallelToolCalls: undefined,
      };
      if (provider.stream) {
        return await provider.stream(textRequest, auth, onToken);
      }
      const result = await provider.complete(textRequest, auth);
      onToken(result.text);
      return result;
    }
    throw toolError;
  }
}

/**
 * Run complete/stream against all keys for one provider with circular rotation.
 * Returns result on success; throws ProviderError-like aggregate on hard stop;
 * returns `{ exhausted: true, lastError }` when the key circle is done.
 */
async function runWithKeyRotation<T>(opts: {
  providerId: ProviderId;
  provider: LlmProvider;
  request: CompletionRequest;
  model: string;
  emitKey: EmitKey;
  mode: "complete" | "stream";
  onToken?: ((token: string) => void) | undefined;
  onStatus?: ((message: string) => void) | undefined;
}): Promise<T> {
  const { providerId, provider, request, model, emitKey } = opts;
  const multi = await getProviderKeys(providerId);
  const slots = multi.keys;
  if (slots.length === 0) {
    throw new Error("no API key configured");
  }

  const plan = buildKeyAttemptPlan(slots.length, multi.activeIndex);
  const multiKey = slots.length > 1;
  // Single key: time-increasing retries (MAX_RETRIES+1 attempts).
  // Multi key: 2 attempts per key (initial + one retry), then next key.
  const maxPerKey = attemptsPerKey(slots.length, MAX_RETRIES + 1);
  let lastError: unknown;

  for (let planIdx = 0; planIdx < plan.length; planIdx++) {
    const keyIndex = plan[planIdx]!;
    const slot = slots[keyIndex]!;
    const auth = authForSlot(providerId, slot.value);
    const tail = maskSecretTail(slot.value);

    // Announce only when rotating after a failure — never re-toast the sticky
    // key on every agent step ("using [2/4]" spam).
    if (planIdx > 0) {
      emitKey({
        type: "switch",
        provider: providerId,
        maskedTail: tail,
        keyIndex,
        keyCount: slots.length,
        ...(lastError ? { reason: failureReason(lastError) } : {}),
      });
    }

    for (let attempt = 0; attempt < maxPerKey; attempt++) {
      request.signal?.throwIfAborted();
      try {
        let result: CompletionResult;
        if (opts.mode === "stream") {
          result = await tryStreamOnce(
            provider,
            providerId,
            request,
            model,
            auth,
            opts.onToken ?? (() => {}),
            opts.onStatus,
          );
        } else {
          result = await tryCompleteOnce(provider, providerId, request, model, auth);
        }
        // Sticky success only for stored multi-key (not env-only synthetic).
        if (multi.source !== "env" && multi.source !== "local") {
          void markProviderKeySuccess(providerId, keyIndex).catch(() => {});
        }
        return result as T;
      } catch (error) {
        lastError = error;

        // 404/422: other keys for the same model will not help.
        if (isKeyCircleStopError(error)) {
          throw error;
        }

        // Auth / quota (402 credits): never sleep on the same key — switch now.
        if (isImmediateKeySwitchError(error)) {
          if (multiKey) {
            // Always advance (or exit plan after last key) so every key is tried.
            break;
          }
          // Single key — surface immediately (no pointless multi-second backoff).
          throw error;
        }

        const rotatable = isKeyRotatableError(error, isRetriableError);
        if (!rotatable) {
          // e.g. 413 — bubble so outer provider fallback can try another provider.
          throw error;
        }

        const canRetrySame = attempt + 1 < maxPerKey;
        if (canRetrySame) {
          const wait = isRateLimited(error)
            ? retryWaitMs(error, attempt)
            : networkRetryWaitMs(attempt);
          if (wait > MAX_RETRY_WAIT_MS) {
            // Don't burn the whole multi-key circle on one impossible wait —
            // move to the next key when multi; single-key still exhausts.
            if (multiKey) break;
            throw error;
          }
          emitKey({
            type: "retry",
            provider: providerId,
            maskedTail: tail,
            reason: failureReason(error),
            waitMs: wait,
            keyIndex,
            keyCount: slots.length,
          });
          await sleep(wait, request.signal);
          continue;
        }
        // Exhausted attempts for this key → next in circle (if any).
        break;
      }
    }
  }

  // Single-key rate-limit exhaustion: preserve historical UX string.
  if (!multiKey && lastError && isRateLimited(lastError)) {
    opts.onStatus?.(
      `⏳ ${providerId} rate limited; staying on selected provider.`,
    );
  } else if (multiKey) {
    emitKey({
      type: "exhausted",
      provider: providerId,
      maskedTail: maskSecretTail(slots[plan[0]!]!.value),
      keyCount: slots.length,
      reason: lastError ? failureReason(lastError) : undefined,
    });
  }

  const err = lastError ?? new Error("all API keys failed");
  throw err;
}

export async function completeWithProvider(
  request: CompletionRequest,
  options?: StreamWithProviderOptions,
): Promise<CompletionResult> {
  const config = getConfig();
  const requested = request.provider ?? config.defaultProvider;
  const providerImpl = providers[requested];
  const isDefaultModel = !request.model || request.model === providerImpl.defaultModel;
  const fallbackEnabled =
    config.providerFallback && (isDefaultModel || request.allowModelFallback === true);
  const order = buildFallbackChain(
    requested,
    config.freeOnly,
    fallbackEnabled,
  );
  const failures: ProviderFailure[] = [];
  const emitKey = makeKeyEmitter(options?.onStatus, options?.onKeyEvent);

  for (const providerId of order) {
    request.signal?.throwIfAborted();
    const provider = providers[providerId];
    const multi = await getProviderKeys(providerId);
    const hasAuth =
      providerId === "ollama"
        ? multi.keys.length > 0
        : multi.keys.length > 0;
    if (!hasAuth) {
      failures.push({ provider: providerId, message: "no API key configured" });
      continue;
    }

    const model =
      providerId === requested
        ? (request.model ?? provider.defaultModel)
        : provider.defaultModel;

    try {
      return await runWithKeyRotation<CompletionResult>({
        providerId,
        provider,
        request,
        model,
        emitKey,
        mode: "complete",
        ...(options?.onStatus ? { onStatus: options.onStatus } : {}),
      });
    } catch (error) {
      failures.push({
        provider: providerId,
        message: summarizeProviderError(error),
      });
      if (isKeyCircleStopError(error) || shouldStopProviderFallback(error)) {
        throw new Error(
          `No provider could complete the request.${formatFailures(failures)}`,
        );
      }
      // Continue to next provider in chain when fallback is enabled (e.g. 413).
    }
  }

  throw new Error(
    `No provider could complete the request.${formatFailures(failures)}`,
  );
}

export async function streamWithProvider(
  request: CompletionRequest,
  onToken: (token: string) => void,
  onStatusOrOptions?: ((message: string) => void) | StreamWithProviderOptions,
): Promise<CompletionResult> {
  const options: StreamWithProviderOptions =
    typeof onStatusOrOptions === "function"
      ? { onStatus: onStatusOrOptions }
      : onStatusOrOptions ?? {};

  const config = getConfig();
  const requested = request.provider ?? config.defaultProvider;
  const providerImpl = providers[requested];
  const isDefaultModel = !request.model || request.model === providerImpl.defaultModel;
  const fallbackEnabled =
    config.providerFallback && (isDefaultModel || request.allowModelFallback === true);
  const order = buildFallbackChain(
    requested,
    config.freeOnly,
    fallbackEnabled,
  );
  const failures: ProviderFailure[] = [];
  const emitStatus = options.onStatus ?? ((message) => onToken(message));
  const emitKey = makeKeyEmitter(emitStatus, options.onKeyEvent);

  for (const providerId of order) {
    request.signal?.throwIfAborted();
    const provider = providers[providerId];
    const multi = await getProviderKeys(providerId);
    if (multi.keys.length === 0) {
      failures.push({ provider: providerId, message: "no API key configured" });
      continue;
    }

    const model =
      providerId === requested
        ? (request.model ?? provider.defaultModel)
        : provider.defaultModel;

    try {
      return await runWithKeyRotation<CompletionResult>({
        providerId,
        provider,
        request,
        model,
        emitKey,
        mode: "stream",
        onToken,
        onStatus: emitStatus,
      });
    } catch (error) {
      failures.push({
        provider: providerId,
        message: summarizeProviderError(error),
      });
      if (isKeyCircleStopError(error) || shouldStopProviderFallback(error)) {
        throw new Error(
          `No provider could stream the request.${formatFailures(failures)}`,
        );
      }
      // Continue to next provider when fallback is enabled (e.g. 413).
    }
  }

  throw new Error(
    `No provider could stream the request.${formatFailures(failures)}`,
  );
}

export async function pingProvider(
  providerId: ProviderId,
  secretOverride?: string,
): Promise<void> {
  const provider = providers[providerId];
  const auth =
    providerId === "ollama"
      ? { baseUrl: secretOverride ?? (await providerAuth(providerId)).baseUrl }
      : { apiKey: secretOverride ?? (await providerAuth(providerId)).apiKey };
  await provider.ping(auth);
}
