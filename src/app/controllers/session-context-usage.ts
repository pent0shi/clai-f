// Context-usage projection for the session footer.
//
// A denominator is displayed only when the user explicitly sets a session
// model-window override. The default footer remains a concise current-context
// count; compaction policy is resolved independently by the agent runner.
import { estimateMessagesTokens } from "../../agent/context-manager.js";
import {
  applyUsageToSnapshot,
  snapshotFromEstimate,
  type ContextUsageSnapshot,
} from "../../llm/token-usage.js";
import type { ChatMessage, ProviderId, TokenUsage } from "../../types.js";

export interface ContextUsageTarget {
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
  /** Explicit provider/model window for this session, if the user set one. */
  readonly contextLimitTokens?: number | undefined;
}

// The footer denominator is the explicit model window, never a guessed window
// or compaction trigger. Zero means no session override was set.
export function contextUsageLimit(target: ContextUsageTarget): number {
  const limit = target.contextLimitTokens;
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : 0;
}

// Prefer the last API `prompt_tokens` as context fill (exact); otherwise
// estimate from current history so the footer always has a number.
export function resolveContextUsageSnapshot(
  target: ContextUsageTarget,
  history: readonly ChatMessage[],
  current: ContextUsageSnapshot | undefined,
): ContextUsageSnapshot | undefined {
  const contextLimit = contextUsageLimit(target);
  if (current?.exact && current.contextTokens > 0) {
    return { ...current, contextLimit };
  }
  const estimated = snapshotFromEstimate(
    history,
    target.model,
    target.provider,
    current,
  );
  return { ...estimated, contextLimit };
}

// Fold provider-reported usage into the snapshot against the request budget.
export function recordUsageSnapshot(
  target: ContextUsageTarget,
  current: ContextUsageSnapshot | undefined,
  usage: TokenUsage,
): ContextUsageSnapshot {
  return applyUsageToSnapshot(current, usage, contextUsageLimit(target));
}

// After /compact or auto-compact the exact prompt_tokens are stale: report the
// post-compaction size until the next API usage report.
export function compactedUsageSnapshot(
  target: ContextUsageTarget,
  current: ContextUsageSnapshot | undefined,
  history: readonly ChatMessage[],
  afterTokens?: number,
): ContextUsageSnapshot {
  const estimated =
    typeof afterTokens === "number" && afterTokens > 0
      ? afterTokens
      : estimateMessagesTokens(history as ChatMessage[]);
  return {
    contextTokens: estimated,
    contextLimit: contextUsageLimit(target),
    lastCompletionTokens: 0,
    sessionPromptTokens: current?.sessionPromptTokens ?? 0,
    sessionCompletionTokens: current?.sessionCompletionTokens ?? 0,
    exact: false,
  };
}

export function estimatedUsageSnapshot(
  target: ContextUsageTarget,
  current: ContextUsageSnapshot | undefined,
  estimatedTokens: number,
): ContextUsageSnapshot | undefined {
  if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) return current;
  if (current?.exact) return current;
  return {
    contextTokens: Math.floor(estimatedTokens),
    contextLimit: current?.contextLimit ?? contextUsageLimit(target),
    lastCompletionTokens: current?.lastCompletionTokens ?? 0,
    sessionPromptTokens: current?.sessionPromptTokens ?? 0,
    sessionCompletionTokens: current?.sessionCompletionTokens ?? 0,
    exact: false,
  };
}

export interface ContextProjection {
  contextUsage: ContextUsageSnapshot | undefined;
  contextChip: string | undefined;
}

// The estimate walks the whole transcript, so the projection is memoized
// against the inputs that can change it instead of recomputed per render.
export function createContextProjector(
  formatChip: (snapshot: ContextUsageSnapshot) => string,
): (
  target: ContextUsageTarget,
  history: readonly ChatMessage[],
  current: ContextUsageSnapshot | undefined,
) => ContextProjection {
  let cache: { key: string; value: ContextProjection } | undefined;
  return (target, history, current) => {
    const first = history[0];
    const last = history[history.length - 1];
    const key = [
      target.provider ?? "",
      target.model ?? "",
      target.contextLimitTokens ?? 0,
      history.length,
      first?.content.length ?? 0,
      last?.content.length ?? 0,
      current?.contextTokens ?? -1,
      current?.contextLimit ?? -1,
      current?.lastCompletionTokens ?? -1,
      current?.exact ? 1 : 0,
    ].join("|");
    if (cache?.key === key) return cache.value;
    const contextUsage = resolveContextUsageSnapshot(target, history, current);
    const value: ContextProjection = {
      contextUsage,
      contextChip: contextUsage ? formatChip(contextUsage) : undefined,
    };
    cache = { key, value };
    return value;
  };
}

export interface PartialUsageSnapshot {
  contextTokens: number;
  contextLimit?: number | undefined;
  lastCompletionTokens?: number | undefined;
  sessionPromptTokens?: number | undefined;
  sessionCompletionTokens?: number | undefined;
  exact: boolean;
}

// Prefer the exact snapshot saved during the live turn; older sessions without
// a usage payload fall back to an estimate at the call site.
export function restoredUsageSnapshot(
  target: ContextUsageTarget,
  usage: PartialUsageSnapshot | ContextUsageSnapshot | undefined,
): ContextUsageSnapshot | undefined {
  if (!usage || usage.contextTokens <= 0) return undefined;
  return {
    contextTokens: usage.contextTokens,
    // Persisted snapshots from older builds stored an auto-compact trigger
    // here. Only a live explicit session override may become a denominator.
    contextLimit: contextUsageLimit(target),
    lastCompletionTokens: usage.lastCompletionTokens ?? 0,
    sessionPromptTokens: usage.sessionPromptTokens ?? 0,
    sessionCompletionTokens: usage.sessionCompletionTokens ?? 0,
    exact: usage.exact === true,
  };
}
