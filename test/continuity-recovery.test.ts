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
import { compactionAttemptKey } from "../src/agent/compaction-attempt.js";
import { createOutcome, recordToolEvidence } from "../src/agent/outcomes.js";

describe("compaction retry identity", () => {
  const base = {
    provider: "anthropic",
    model: "claude",
    dialect: "native",
    triggerTokens: 80_000,
    schemaHash: "schema",
  };

  it("changes for same-length transcript edits and provider-visible metadata", () => {
    const key = compactionAttemptKey({
      ...base,
      messages: [{ role: "user", content: "read alpha" }],
    });
    expect(
      compactionAttemptKey({
        ...base,
        messages: [{ role: "user", content: "read bravo" }],
      }),
    ).not.toBe(key);
    expect(
      compactionAttemptKey({
        ...base,
        messages: [
          {
            role: "user",
            content: "read alpha",
            images: [{ mediaType: "image/png", dataBase64: "AAAA" }],
          },
        ],
      }),
    ).not.toBe(key);
    expect(
      compactionAttemptKey({
        ...base,
        messages: [
          {
            role: "assistant",
            content: "read alpha",
            toolCalls: [{ id: "1", name: "fs.read", args: { path: "a" } }],
          },
        ],
      }),
    ).not.toBe(key);
  });

  it("is stable for omitted fields and reordered tool argument keys", () => {
    const message = (args: Record<string, unknown>) => ({
      role: "assistant" as const,
      content: "",
      toolCalls: [{ id: "1", name: "shell.exec", args }],
    });
    expect(
      compactionAttemptKey({ ...base, messages: [message({ b: 2, a: 1 })] }),
    ).toBe(
      compactionAttemptKey({ ...base, messages: [message({ a: 1, b: 2 })] }),
    );
    expect(
      compactionAttemptKey({
        ...base,
        messages: [{ role: "user", content: "same", name: undefined }],
      }),
    ).toBe(
      compactionAttemptKey({
        ...base,
        messages: [{ role: "user", content: "same" }],
      }),
    );
  });

  it("changes when the canonical durable envelope changes", () => {
    const messages = [{ role: "user" as const, content: "continue" }];
    expect(
      compactionAttemptKey({
        ...base,
        messages,
        durableEnvelope: "Live background jobs: [a] running",
      }),
    ).not.toBe(
      compactionAttemptKey({
        ...base,
        messages,
        durableEnvelope: "Finished background jobs: [a] exited",
      }),
    );
  });
});

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

  it("carries completed read-only operation evidence across compaction", () => {
    const outcome = createOutcome({
      sessionId: "ops",
      userIntent: "inspect service",
      kind: "answer",
      criteria: [{ id: "answer", statement: "answer", required: true, domain: "general" }],
    });
    const state = {
      schemaVersion: 1 as const,
      outcome,
      evidence: [],
      failedHypotheses: [],
      completedOperations: [],
    };
    recordToolEvidence(state, {
      tool: "shell.tail",
      callId: "tail-1",
      ok: true,
      output: "scan finished with one host",
      artifact: "/tmp/scan.log",
      args: { id: "job-1", offset: 120 },
    });
    const envelope = buildDurableEnvelope({ outcome: state });
    expect(envelope).toContain("Completed read-only operations");
    expect(envelope).toContain("shell.tail");
    expect(envelope).toContain("scan finished with one host");
    expect(envelope).toContain("do not repeat identical calls");
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
