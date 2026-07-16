export type TurnState =
  | "understanding"
  | "exploring"
  | "acting"
  | "verifying"
  | "succeeded"
  | "partial"
  | "blocked"
  | "failed"
  | "aborted"
  | "paused_budget";

export interface TurnStateSnapshot {
  readonly schemaVersion: 1;
  readonly state: TurnState;
  readonly revision: number;
  readonly reason?: string | undefined;
}

const LEGAL_TRANSITIONS: Readonly<Record<TurnState, readonly TurnState[]>> = {
  understanding: ["exploring", "acting", "blocked", "failed", "aborted", "paused_budget"],
  exploring: ["understanding", "acting", "verifying", "blocked", "failed", "aborted", "paused_budget"],
  acting: ["exploring", "verifying", "blocked", "failed", "aborted", "paused_budget"],
  verifying: ["exploring", "acting", "succeeded", "partial", "blocked", "failed", "aborted", "paused_budget"],
  paused_budget: ["understanding", "exploring", "acting", "verifying", "aborted"],
  succeeded: [],
  partial: [],
  blocked: [],
  failed: [],
  aborted: [],
};

export function createTurnState(initial: TurnState = "understanding"): TurnStateSnapshot {
  return { schemaVersion: 1, state: initial, revision: 0 };
}

export function canTransitionTurn(from: TurnState, to: TurnState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function transitionTurn(
  snapshot: TurnStateSnapshot,
  to: TurnState,
  reason?: string,
): TurnStateSnapshot {
  if (!canTransitionTurn(snapshot.state, to)) {
    throw new Error(`illegal turn transition: ${snapshot.state} -> ${to}`);
  }
  return { schemaVersion: 1, state: to, revision: snapshot.revision + 1, reason };
}

export function isTerminalTurnState(state: TurnState): boolean {
  return LEGAL_TRANSITIONS[state].length === 0;
}
