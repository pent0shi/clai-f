import { describe, expect, it } from "vitest";
import { buildDurableEnvelope } from "../src/agent/durable-envelope.js";
import {
  buildContinueOrientation,
  previousTurnUnfinished,
  shouldInjectContinueOrientation,
} from "../src/agent/continue-orient.js";
import { previousTurnSignal } from "../src/app/controllers/turn-continuation.js";
import { createTurnOutcome } from "../src/agent/turn-outcome.js";
import { asTurnId } from "../src/app/events/app-event.js";

describe("compaction continuity: background work survives", () => {
  it("carries live and finished jobs in the durable envelope", () => {
    const envelope = buildDurableEnvelope({
      liveJobs: [
        {
          id: "job1",
          status: "running",
          command: "nmap -sV 10.0.0.5",
          taskId: "t2",
          artifact: "/tmp/clai/job1.stdout.log",
        },
      ],
      finishedJobs: [
        { id: "job0", status: "exited", command: "npm run build" },
      ],
    });

    expect(envelope).toBeDefined();
    expect(envelope).toContain("Live background jobs");
    expect(envelope).toContain("job1");
    expect(envelope).toContain("nmap -sV 10.0.0.5");
    expect(envelope).toContain("task=t2");
    expect(envelope).toContain("Finished background jobs");
    expect(envelope).toContain("npm run build");
  });

  it("stays empty when there is no canonical state", () => {
    expect(buildDurableEnvelope({})).toBeUndefined();
  });
});

describe("resume after a stopped or failed turn", () => {
  const turnId = asTurnId("turn-prev");

  it("maps every non-success turn result to an unfinished signal", () => {
    expect(previousTurnSignal({ status: "aborted", turnId })).toEqual({
      status: "aborted",
    });
    const errorSignal = previousTurnSignal({
      status: "error",
      turnId,
      error: new Error("stream reset"),
    });
    expect(errorSignal).toMatchObject({ status: "error", reason: "stream reset" });
    expect(previousTurnUnfinished(errorSignal)).toBe(true);

    const partial = previousTurnSignal({
      status: "completed",
      turnId,
      outcome: createTurnOutcome({
        status: "partial",
        answer: "half done",
        steps: 3,
        remainingCriteria: ["run the tests"],
      }),
      finalAnswer: "half done",
    });
    expect(previousTurnUnfinished(partial)).toBe(true);

    const success = previousTurnSignal({
      status: "completed",
      turnId,
      outcome: createTurnOutcome({
        status: "succeeded",
        answer: "done",
        steps: 1,
        remainingCriteria: [],
      }),
      finalAnswer: "done",
    });
    expect(previousTurnUnfinished(success)).toBe(false);
  });

  it("re-attaches on any follow-up after an aborted turn", () => {
    const input = {
      prompt: "add the missing validation to the parser module",
      history: [
        { role: "user" as const, content: "start the refactor" },
        { role: "assistant" as const, content: "working" },
      ],
      previousTurn: { status: "aborted" as const },
    };
    expect(shouldInjectContinueOrientation(input)).toBe(true);
    const brief = buildContinueOrientation(input);
    expect(brief).toContain("previous turn ended aborted");
    expect(brief).toContain("Do not repeat completed steps");
  });

  it("does not re-attach when the user explicitly starts over", () => {
    expect(
      shouldInjectContinueOrientation({
        prompt: "start over from scratch with a new plan for the API",
        history: [
          { role: "user", content: "old work" },
          { role: "assistant", content: "old answer" },
        ],
        previousTurn: { status: "failed" },
      }),
    ).toBe(false);
  });

  it("does not re-attach after a successful turn", () => {
    expect(
      shouldInjectContinueOrientation({
        prompt: "now add a README section about configuration",
        history: [
          { role: "user", content: "done work" },
          { role: "assistant", content: "finished" },
        ],
        previousTurn: { status: "succeeded" },
      }),
    ).toBe(false);
  });
});
