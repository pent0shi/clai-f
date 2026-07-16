export type TurnOutcomeStatus =
  | "succeeded"
  | "partial"
  | "blocked"
  | "failed"
  | "aborted"
  | "paused_budget";

export interface TurnOutcome {
  readonly schemaVersion: 1;
  readonly status: TurnOutcomeStatus;
  readonly answer: string;
  readonly steps: number;
  readonly remainingCriteria: readonly string[];
  readonly reason?: string | undefined;
}

export function createTurnOutcome(input: Omit<TurnOutcome, "schemaVersion">): TurnOutcome {
  if (input.status === "succeeded" && input.remainingCriteria.length > 0) {
    throw new Error("a succeeded turn cannot have remaining criteria");
  }
  return { schemaVersion: 1, ...input };
}

export function renderTurnOutcome(outcome: TurnOutcome): string {
  if (outcome.status === "succeeded" || outcome.status === "aborted") return outcome.answer;
  const status = outcome.status === "paused_budget" ? "paused" : outcome.status;
  const remaining = outcome.remainingCriteria.length
    ? `\n\nRemaining:\n${outcome.remainingCriteria.map((item) => `- ${item}`).join("\n")}`
    : "";
  const reason = outcome.reason ? `\n\nReason: ${outcome.reason}` : "";
  return `${outcome.answer}${outcome.answer ? "\n\n" : ""}Status: ${status}${reason}${remaining}`;
}
