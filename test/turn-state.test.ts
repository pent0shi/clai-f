import { describe, expect, it } from "vitest";
import { canTransitionTurn, createTurnState, isTerminalTurnState, transitionTurn, type TurnState } from "../src/agent/turn-state.js";

const states: TurnState[] = ["understanding", "exploring", "acting", "verifying", "succeeded", "partial", "blocked", "failed", "aborted", "paused_budget"];
const legal: Record<TurnState, TurnState[]> = {
  understanding: ["exploring", "acting", "blocked", "failed", "aborted", "paused_budget"],
  exploring: ["understanding", "acting", "verifying", "blocked", "failed", "aborted", "paused_budget"],
  acting: ["exploring", "verifying", "blocked", "failed", "aborted", "paused_budget"],
  verifying: ["exploring", "acting", "succeeded", "partial", "blocked", "failed", "aborted", "paused_budget"],
  paused_budget: ["understanding", "exploring", "acting", "verifying", "aborted"],
  succeeded: [], partial: [], blocked: [], failed: [], aborted: [],
};

describe("turn state machine", () => {
  it("uses the requested initial lifecycle vocabulary", () => {
    expect(createTurnState()).toEqual({ schemaVersion: 1, state: "understanding", revision: 0 });
  });

  it("exhaustively implements only the legal transition table", () => {
    for (const from of states) for (const to of states) {
      expect(canTransitionTurn(from, to), `${from} -> ${to}`).toBe(legal[from].includes(to));
    }
  });

  it("supports acting recovery through exploration and increments revisions", () => {
    const acting = transitionTurn(createTurnState(), "acting");
    const recovery = transitionTurn(acting, "exploring", "action failed; revise hypothesis");
    expect(recovery).toMatchObject({ state: "exploring", revision: 2, reason: "action failed; revise hypothesis" });
  });

  it("makes outcomes terminal while keeping budget pauses resumable", () => {
    for (const terminal of ["succeeded", "partial", "blocked", "failed", "aborted"] as const) expect(isTerminalTurnState(terminal)).toBe(true);
    const paused = transitionTurn(transitionTurn(createTurnState(), "acting"), "paused_budget");
    expect(isTerminalTurnState(paused.state)).toBe(false);
    expect(transitionTurn(paused, "exploring").state).toBe("exploring");
    expect(() => transitionTurn(createTurnState(), "succeeded")).toThrow(/illegal/);
  });
});
