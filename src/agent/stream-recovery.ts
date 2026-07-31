/**
 * Robust recovery for provider stream/complete failures.
 *
 * Goal: the agent should try *working approaches* before it gives up on a
 * turn. A single flaky free-tier model (empty admissions, connection glitches,
 * capacity 5xx, rate limits) must not kill the turn on the first error. Instead
 * we classify the failure and pick a bounded, escalating strategy — back off,
 * compact the context, drop thinking, or let the router fall back to another
 * provider/model — and only surrender in the worst case (every approach for
 * that failure class exhausted, or the overall recovery budget spent).
 *
 * These helpers are pure so the escalation ladder and the "give up only in the
 * worst case" guarantee are unit-testable without a live provider.
 */

import { ProviderError, STREAM_STALL_MARKER } from "../llm/http.js";
import { isEmptyCompletionError } from "../llm/router.js";

export type StreamFailureKind =
  | "aborted"
  | "empty"
  | "context-overflow"
  | "rate-limit"
  | "server"
  /** Transport died: the socket dropped or never delivered a byte. */
  | "network"
  /**
   * The connection stayed healthy but the model stopped producing output —
   * almost always a runtime buffering one very large `tool_calls` argument
   * string. Distinct from `network` because the request was accepted and the
   * work was done: retrying the identical request on the identical route
   * replays the whole generation and stalls again the same way.
   */
  | "stall"
  | "auth"
  | "not-found"
  | "unknown";

export interface StreamRecoveryState {
  empty: number;
  rateLimit: number;
  server: number;
  network: number;
  stall: number;
  context: number;
  /** auth / not-found / unknown share one "structural" bucket. */
  structural: number;
  progressed: number;
  total: number;
}

export interface StreamRecoveryLimits {
  readonly maxEmpty: number;
  readonly maxRateLimit: number;
  readonly maxServer: number;
  readonly maxNetwork: number;
  readonly maxStall: number;
  readonly maxContext: number;
  readonly maxStructural: number;
  readonly maxProgressed: number;
  /** Hard cap across every failure class so a turn can never loop forever. */
  readonly maxTotal: number;
  /** Upper bound on any single backoff so the total wait budget stays sane. */
  readonly maxDelayMs: number;
}

export const DEFAULT_STREAM_RECOVERY_LIMITS: StreamRecoveryLimits = {
  maxEmpty: 4,
  maxRateLimit: 3,
  maxServer: 3,
  maxNetwork: 3,
  // A stall costs a full generation per attempt, so the budget is tight and
  // each attempt changes something (smaller writes, then another route).
  maxStall: 2,
  maxContext: 2,
  maxStructural: 1,
  maxProgressed: 6,
  maxTotal: 16,
  maxDelayMs: 30_000,
};

export interface StreamRecoveryPlan {
  /** retry = try again with the strategy below; give-up = rethrow (worst case). */
  readonly action: "retry" | "give-up";
  readonly kind: StreamFailureKind;
  /** Backoff before the retry (0 = immediate). */
  readonly delayMs: number;
  /** Force a compaction pass before retrying (context pressure / empty tail). */
  readonly forceCompact: boolean;
  /** Retry with thinking disabled (thinking-only / reasoning-heavy stalls). */
  readonly disableThinking: boolean;
  /** Let the router fall back to another provider/model on the retry. */
  readonly allowModelFallback: boolean;
  /** Try alternates before replaying the selected route (stall recovery only). */
  readonly preferModelFallback?: boolean | undefined;
  /** Optional trailing user nudge (empty-admission recovery). */
  readonly nudge?: string | undefined;
  /** Human-facing one-liner; only set on the FIRST retry of a class (low noise). */
  readonly notice?: string | undefined;
}

const EMPTY_NUDGE =
  "Your previous response was empty. Continue the task now: emit your next tool call, " +
  "or give your final answer if every required step is already complete and verified. " +
  "Do not reply with an empty message.";

const STALL_NUDGE =
  "The previous attempt stopped while the provider was buffering a large tool-call payload; the incomplete call was discarded. " +
  "Keep each call small from here on: write or edit at most ~150 lines per call. For a new large file, use one initial " +
  "fs.write followed by sequential fs.append calls; for an existing file, use several bounded fs.edit / fs.replaceLines calls. " +
  "Continue from the preserved progress without restarting the task or repeating prior prose.";

function errorStatus(error: unknown): number {
  if (error instanceof ProviderError) return error.status ?? 0;
  if (error && typeof error === "object" && "status" in error) {
    const s = (error as { status?: unknown }).status;
    return typeof s === "number" ? s : 0;
  }
  return 0;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error ?? ""))
    .toLowerCase();
}

/**
 * Map a raw stream/complete failure to a recovery class.
 *
 * Works on both raw {@link ProviderError}s and the router's wrapped
 * "No provider could stream the request. — <provider>: <body>" strings, so it
 * behaves the same whether the failure bubbles from a single provider or the
 * whole fallback chain. When several providers failed for different reasons the
 * most *actionable* class wins (compact > back off > nudge).
 */
export function classifyStreamFailure(error: unknown): StreamFailureKind {
  const status = errorStatus(error);
  const msg = errorText(error);

  if (/\babort(ed)?\b|operation was aborted|the operation was cancelled/.test(msg)) {
    return "aborted";
  }

  // Context pressure is always safe to act on (compaction), so it wins first.
  if (
    status === 413 ||
    /\b413\b|input limit|context length|context window|maximum context|too large|reduce the length|exceeded the provider input|prompt is too long|token limit/.test(
      msg,
    )
  ) {
    return "context-overflow";
  }

  if (
    status === 429 ||
    /\b429\b|rate limit|rate-limited|too many requests|retry after|quota exceeded/.test(
      msg,
    )
  ) {
    return "rate-limit";
  }

  if (
    (status >= 500 && status <= 599) ||
    /\b50[0-4]\b|upstream provider (unavailable|error)|server error \(5|bad gateway|service unavailable|gateway timeout|overloaded/.test(
      msg,
    )
  ) {
    return "server";
  }

  // A stall on a live connection must be checked BEFORE the network patterns:
  // its message also contains "stream stalled", but the transport was fine and
  // the fix is different (shrink the tool call / change route, not just retry).
  if (new RegExp(STREAM_STALL_MARKER, "i").test(msg)) return "stall";

  if (
    /connection glitch|socket connection was closed|econnreset|etimedout|econnrefused|enotfound|fetch failed|network error|premature close|stream stalled|transport timeout|unexpected end of file|request timed out|connection dropped|timed out before any response/.test(
      msg,
    )
  ) {
    return "network";
  }

  // Empty admission (no visible text, no tool calls). Cheap to retry / nudge.
  if (isEmptyCompletionError(error)) return "empty";

  if (
    status === 401 ||
    status === 403 ||
    /\b401\b|\b403\b|unauthorized|authentication\/authorization failed|invalid api key|forbidden/.test(
      msg,
    )
  ) {
    return "auth";
  }

  if (
    status === 404 ||
    status === 422 ||
    /\b404\b|\b422\b|not found|rejected the request body/.test(msg)
  ) {
    return "not-found";
  }

  return "unknown";
}

export function createStreamRecoveryState(): StreamRecoveryState {
  return {
    empty: 0,
    rateLimit: 0,
    server: 0,
    network: 0,
    stall: 0,
    context: 0,
    structural: 0,
    progressed: 0,
    total: 0,
  };
}

export function resetStreamRecoveryState(state: StreamRecoveryState): void {
  state.empty = 0;
  state.rateLimit = 0;
  state.server = 0;
  state.network = 0;
  state.stall = 0;
  state.context = 0;
  state.structural = 0;
  state.progressed = 0;
  state.total = 0;
}

/** Record that one recovery attempt for `kind` was taken. Mutates `state`. */
export function recordRecoveryAttempt(
  state: StreamRecoveryState,
  kind: StreamFailureKind,
  progressed = false,
): void {
  state.total += 1;
  if (progressed) {
    state.progressed += 1;
    return;
  }
  switch (kind) {
    case "empty":
      state.empty += 1;
      break;
    case "rate-limit":
      state.rateLimit += 1;
      break;
    case "server":
      state.server += 1;
      break;
    case "network":
      state.network += 1;
      break;
    case "stall":
      state.stall += 1;
      break;
    case "context-overflow":
      state.context += 1;
      break;
    default:
      state.structural += 1;
      break;
  }
}

function pick(delays: readonly number[], attempt: number, max: number): number {
  return Math.min(delays[attempt] ?? delays[delays.length - 1] ?? 0, max);
}

/**
 * Decide the next recovery action for a stream failure.
 *
 * `state` holds the attempts already made for each class *this failure episode*
 * (reset on any successful stream). The planner never mutates it — the caller
 * records the attempt via {@link recordRecoveryAttempt} once it commits to the
 * retry — so the plan stays a pure function of (error, state, limits).
 */
export function planStreamRecovery(input: {
  error?: unknown;
  kind?: StreamFailureKind;
  state: StreamRecoveryState;
  limits?: StreamRecoveryLimits;
  progressed?: boolean | undefined;
}): StreamRecoveryPlan {
  const limits = input.limits ?? DEFAULT_STREAM_RECOVERY_LIMITS;
  const kind = input.kind ?? classifyStreamFailure(input.error);
  const { state } = input;
  const progressed = input.progressed === true;
  const attempt = (used: number, limit: number): number =>
    progressed ? Math.min(used, Math.max(0, limit - 1)) : used;

  const giveUp: StreamRecoveryPlan = {
    action: "give-up",
    kind,
    delayMs: 0,
    forceCompact: false,
    disableThinking: false,
    allowModelFallback: false,
  };

  // User cancelled, or we have spent the whole recovery budget: stop now.
  if (kind === "aborted") return giveUp;
  if (state.total >= limits.maxTotal) return giveUp;
  if (progressed && state.progressed >= limits.maxProgressed) return giveUp;

  const cap = limits.maxDelayMs;

  switch (kind) {
    case "empty": {
      const n = attempt(state.empty, limits.maxEmpty);
      if (n >= limits.maxEmpty) return giveUp;
      return {
        action: "retry",
        kind,
        delayMs: pick([500, 1000, 1500, 2000], n, cap),
        // Escalate: nudge → drop thinking → compact + try another provider.
        disableThinking: n >= 1,
        forceCompact: n >= 2,
        allowModelFallback: n >= 2,
        nudge: EMPTY_NUDGE,
        notice:
          n === 0
            ? "model returned an empty response — retrying with a nudge"
            : undefined,
      };
    }
    case "rate-limit": {
      const n = attempt(state.rateLimit, limits.maxRateLimit);
      if (n >= limits.maxRateLimit) return giveUp;
      const delayMs = pick([8_000, 20_000, 30_000], n, cap);
      return {
        action: "retry",
        kind,
        delayMs,
        forceCompact: false,
        disableThinking: false,
        allowModelFallback: true,
        notice:
          n === 0
            ? `provider rate limited — backing off ${Math.ceil(delayMs / 1000)}s and trying alternates`
            : undefined,
      };
    }
    case "server": {
      const n = attempt(state.server, limits.maxServer);
      if (n >= limits.maxServer) return giveUp;
      return {
        action: "retry",
        kind,
        delayMs: pick([3_000, 8_000, 15_000], n, cap),
        forceCompact: false,
        disableThinking: false,
        allowModelFallback: true,
        notice:
          n === 0
            ? "upstream provider error — backing off and trying alternates"
            : undefined,
      };
    }
    case "network": {
      const n = attempt(state.network, limits.maxNetwork);
      if (n >= limits.maxNetwork) return giveUp;
      return {
        action: "retry",
        kind,
        delayMs: pick([2_000, 5_000, 10_000], n, cap),
        forceCompact: false,
        disableThinking: false,
        // If the same route keeps dropping, let the router try another one.
        allowModelFallback: n >= 1,
        notice: n === 0 ? "connection dropped — retrying" : undefined,
      };
    }
    case "stall": {
      const n = attempt(state.stall, limits.maxStall);
      if (n >= limits.maxStall) return giveUp;
      return {
        action: "retry",
        kind,
        // The transport is healthy, so there is nothing to wait out. Retry
        // promptly and spend the budget on changing the request instead.
        delayMs: pick([1_000, 3_000], n, cap),
        forceCompact: false,
        // Thinking multiplies the silent window before a tool call appears.
        disableThinking: n >= 1,
        // The same route will buffer the same way. Prefer a configured
        // alternate first, but keep the selected route as the final fallback.
        allowModelFallback: true,
        preferModelFallback: true,
        nudge: STALL_NUDGE,
        notice:
          n === 0
            ? "provider stopped streaming mid-response — retrying with smaller tool calls"
            : undefined,
      };
    }
    case "context-overflow": {
      const n = attempt(state.context, limits.maxContext);
      if (n >= limits.maxContext) return giveUp;
      return {
        action: "retry",
        kind,
        delayMs: pick([500, 500], n, cap),
        forceCompact: true,
        disableThinking: false,
        allowModelFallback: n >= 1,
        notice:
          n === 0
            ? "request exceeded the context window — compacting and retrying"
            : undefined,
      };
    }
    case "auth":
    case "not-found":
    default: {
      // Retrying the same provider/model will not help; give the router one
      // shot at alternate providers/models, then surrender.
      const n = attempt(state.structural, limits.maxStructural);
      if (n >= limits.maxStructural) return giveUp;
      const notice =
        kind === "auth"
          ? "provider auth failed — trying alternate providers"
          : kind === "not-found"
            ? "model/endpoint unavailable — trying alternate providers"
            : "provider request failed — retrying once with alternates";
      return {
        action: "retry",
        kind,
        delayMs: Math.min(kind === "unknown" ? 2_000 : 1_000, cap),
        forceCompact: false,
        disableThinking: false,
        allowModelFallback: true,
        notice,
      };
    }
  }
}
