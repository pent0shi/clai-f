import { describe, expect, it } from "vitest";
import type { AgentPort } from "../../src/app/ports/agent-port.js";
import type { PersistencePort } from "../../src/app/ports/persistence-port.js";
import { SessionController } from "../../src/app/controllers/session-controller.js";
import { createTurnOutcome, type TurnOutcome } from "../../src/agent/turn-outcome.js";
import { queueContinuationDecision } from "../../src/app/controllers/turn-continuation.js";
import { asTurnId } from "../../src/app/events/app-event.js";

function fakePersistence(): PersistencePort {
  return {
    async saveSession() {},
    async loadPlan() {
      return undefined;
    },
    async savePlan() {},
    async deletePlan() {},
  };
}

const outcome = (
  status: TurnOutcome["status"],
  remaining: string[] = [],
): TurnOutcome =>
  createTurnOutcome({
    status,
    answer: "answer",
    steps: 2,
    remainingCriteria: remaining,
  });

describe("queue continuation predicate (LIFE-006)", () => {
  it("continues only for a genuinely successful turn", () => {
    const turnId = asTurnId("turn-1");
    expect(
      queueContinuationDecision({
        status: "completed",
        turnId,
        outcome: outcome("succeeded"),
        finalAnswer: "answer",
      }).proceed,
    ).toBe(true);
    for (const status of [
      "partial",
      "blocked",
      "failed",
      "aborted",
      "paused_budget",
    ] as const) {
      const decision = queueContinuationDecision({
        status: "completed",
        turnId,
        outcome: outcome(status, ["verify the fix"]),
        finalAnswer: "answer",
      });
      expect(decision.proceed).toBe(false);
      expect(decision.reason).toBeTruthy();
    }
    expect(queueContinuationDecision({ status: "aborted", turnId }).proceed).toBe(
      false,
    );
    expect(
      queueContinuationDecision({
        status: "error",
        turnId,
        error: new Error("boom"),
      }).proceed,
    ).toBe(false);
  });

  it("keeps queued prompts and notifies when a turn is blocked", async () => {
    const seen: string[] = [];
    const agent: AgentPort = {
      async runTurn(request) {
        seen.push(request.prompt);
        return createTurnOutcome({
          status: "blocked",
          answer: "needs credentials",
          steps: 1,
          remainingCriteria: ["obtain credentials"],
          reason: "missing credentials",
        });
      },
    };
    const notices: string[] = [];
    const session = new SessionController({
      agent,
      persistence: fakePersistence(),
      sessionId: "sess-continuation",
      emit: (event) => {
        if (event.type === "notice") notices.push(String(event.payload.text));
      },
    });

    await session.submit("first step");
    session.enqueue("second step");
    await session.continueQueue();

    expect(seen).toEqual(["first step"]);
    // The draft is kept for the user instead of running on a false prerequisite.
    expect(session.queued()).toEqual(["second step"]);
    await session.continueQueue();
    expect(seen).toEqual(["first step"]);
    expect(notices.join(" ")).toMatch(/paused/i);
  });
});
