import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  redactSessionId,
  SessionTelemetry,
} from "../../src/interactive-session/telemetry.js";
import type { SessionOperation } from "../../src/interactive-session/types.js";

const SESSION_OPERATION_LIST: SessionOperation[] = [
  "start",
  "send",
  "read",
  "status",
  "list",
  "resize",
  "close",
];
import {
  STABLE_ERROR_CODES,
  sessionError,
  type StableErrorCode,
} from "../../src/interactive-session/types.js";

const SECRET = "hunter2-canary-value";

// Feature: interactive-terminal-sessions, Property 22: Stable errors are complete and non-secret
describe("Property 22: stable errors are complete and non-secret", () => {
  it("uses declared codes with complete, bounded, non-secret fields", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...STABLE_ERROR_CODES),
        fc.constantFrom(...SESSION_OPERATION_LIST),
        fc.boolean(),
        (code, operation, allocated) => {
          const error = sessionError({
            code,
            operation,
            message: `${SECRET} leaked into a message `.repeat(40),
            ...(allocated ? { sessionId: "its_abc", state: "running" as const } : {}),
            details: {
              // Only allowlisted keys survive, so raw payloads cannot ride along.
              omittedBytes: 12,
              ...({ command: `rm -rf ${SECRET}` } as Record<string, string>),
            },
          });
          expect(STABLE_ERROR_CODES).toContain(error.code);
          expect(error.operation).toBe(operation);
          expect(typeof error.retryable).toBe("boolean");
          expect(error.message.length).toBeLessThanOrEqual(401);
          expect(error.sessionId).toBe(allocated ? "its_abc" : undefined);
          expect(error.state).toBe(allocated ? "running" : undefined);
          expect(Object.keys(error.details ?? {})).toEqual(["omittedBytes"]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("marks every post-side-effect failure non-retryable", () => {
    const nonRetryable: StableErrorCode[] = [
      "INPUT_DELIVERY_UNKNOWN",
      "DEADLINE_EXCEEDED",
      "CANCELLED",
      "OUTPUT_GAP",
      "INPUT_REJECTED",
      "INPUT_CLOSED",
      "SESSION_CLOSING",
      "CLEANUP_FAILED",
    ];
    for (const code of nonRetryable) {
      const error = sessionError({ code, operation: "send", message: "x", retryable: true });
      expect(error.retryable).toBe(false);
    }
    expect(
      sessionError({ code: "LAUNCH_FAILED", operation: "start", message: "x" }).retryable,
    ).toBe(false);
    expect(
      sessionError({
        code: "LAUNCH_FAILED",
        operation: "start",
        message: "x",
        retryable: true,
      }).retryable,
    ).toBe(true);
    expect(sessionError({ code: "BACKPRESSURE", operation: "send", message: "x" }).retryable).toBe(
      true,
    );
  });
});

// Feature: interactive-terminal-sessions, Property 23: Telemetry is bounded metadata only
describe("Property 23: telemetry is bounded metadata only", () => {
  it("emits only bounded metadata and no raw ids or payloads", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SESSION_OPERATION_LIST),
        fc.integer({ min: 0, max: 10_000 }),
        (operation, durationMs) => {
          const events: Array<{ event: string; payload: unknown }> = [];
          const telemetry = new SessionTelemetry(async (event, payload) => {
            events.push({ event, payload });
          });
          telemetry.record({
            operation,
            sessionId: `its_${SECRET}`,
            durationMs,
            result: "ok",
            state: "running",
            transport: "pipe",
            inputBytes: 4,
            outputBytes: 9,
            queueDepth: 0,
            retryCount: 0,
          });
          expect(events).toHaveLength(1);
          const serialized = JSON.stringify(events[0]!.payload);
          expect(serialized).not.toContain(SECRET);
          const payload = events[0]!.payload as Record<string, unknown>;
          expect(payload.operation).toBe(operation);
          expect(payload.session).toBe(redactSessionId(`its_${SECRET}`));
          expect(payload.durationMs).toBe(Math.round(durationMs));
          expect(Object.keys(payload).sort()).toEqual(
            [
              "durationMs",
              "inputBytes",
              "operation",
              "outputBytes",
              "queueDepth",
              "result",
              "retryCount",
              "session",
              "state",
              "transport",
            ].sort(),
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("omits absent optional fields instead of emitting null", () => {
    const events: unknown[] = [];
    const telemetry = new SessionTelemetry(async (_event, payload) => {
      events.push(payload);
    });
    telemetry.record({ operation: "list", durationMs: 1, result: "ok" });
    expect(Object.keys(events[0] as Record<string, unknown>).sort()).toEqual([
      "durationMs",
      "operation",
      "result",
    ]);
  });
});
