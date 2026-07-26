/**
 * Context-usage projection for the session footer.
 *
 * The denominator shown to the user is the request budget that governs the next
 * request (auto-compaction trigger), not the raw model window, so the footer
 * agrees with the moment compaction actually fires.
 */
import { requestBudgetDenominator } from "../../agent/request-budget.js";
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
}

/** Effective request budget used as the footer denominator. */
export function contextUsageLimit(target: ContextUsageTarget): number {
  return requestBudgetDenominator(target.provider, target.model);
}

/**
 * Prefer the last API `prompt_tokens` as context fill (exact); otherwise
 * estimate from current history so the footer always has a number.
 */
export function resolveContextUsageSnapshot(
  target: ContextUsageTarget,
  history: readonly ChatMessage[],
  current: ContextUsageSnapshot | undefined,
): ContextUsageSnapshot | undefined {
  const contextLimit = contextUsageLimit(target);
  if (current?.exact && current.contextTokens > 0) {
    return { ...current, contextLimit };
  }
  if (history.length === 0 && !current) return undefined;
  const estimated = snapshotFromEstimate(
    history,
    target.model,
    target.provider,
    current,
  );
  return { ...estimated, contextLimit };
}

/** Fold provider-reported usage into the snapshot against the request budget. */
export function recordUsageSnapshot(
  target: ContextUsageTarget,
  current: ContextUsageSnapshot | undefined,
  usage: TokenUsage,
): ContextUsageSnapshot {
  return applyUsageToSnapshot(current, usage, contextUsageLimit(target));
}

/**
 * After /compact or auto-compact the exact prompt_tokens are stale: report the
 * post-compaction size until the next API usage report.
 */
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
