import type { TurnOutcomeStatus } from "../../agent/turn-outcome.js";
import type { TurnResult } from "./turn-controller.js";

export interface ContinuationDecision {
  readonly proceed: boolean;
  readonly reason?: string | undefined;
}

const PAUSING_OUTCOMES = new Set<TurnOutcomeStatus>([
  "partial",
  "blocked",
  "failed",
  "aborted",
  "paused_budget",
]);

function outcomeLabel(status: TurnOutcomeStatus): string {
  return status === "paused_budget" ? "paused for budget" : status;
}

/**
 * Single predicate deciding whether queued prompts may run after a turn.
 * Queued work usually assumes the previous turn achieved its goal, so anything
 * other than a genuine success pauses the queue and keeps the drafts intact.
 */
export function queueContinuationDecision(
  result: TurnResult,
): ContinuationDecision {
  if (result.status === "aborted") {
    return { proceed: false, reason: "the turn was cancelled" };
  }
  if (result.status === "error") {
    return { proceed: false, reason: `the turn failed: ${result.error.message}` };
  }
  const status = result.outcome?.status;
  if (!status || !PAUSING_OUTCOMES.has(status)) return { proceed: true };
  const detail = result.outcome?.reason ? ` — ${result.outcome.reason}` : "";
  return { proceed: false, reason: `the turn ended ${outcomeLabel(status)}${detail}` };
}
