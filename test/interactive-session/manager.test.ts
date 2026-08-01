import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  InteractiveSessionManager,
  type ConfirmPreview,
} from "../../src/interactive-session/manager.js";
import { RecoveryJournal } from "../../src/interactive-session/recovery-journal.js";
import { SessionTelemetry } from "../../src/interactive-session/telemetry.js";
import { LaunchFailure } from "../../src/interactive-session/transport.js";
import type { SessionTransportFactory } from "../../src/interactive-session/transport.js";
import {
  SessionErrorException,
  type StableError,
} from "../../src/interactive-session/types.js";
import { systemClock, type Clock } from "../../src/interactive-session/runtime.js";
import { FakeTransport, FakeTransportFactory, tempArtifactDir } from "./helpers.js";

const OWNER = "conv-1";
const approve: ConfirmPreview = async () => true;
const decline: ConfirmPreview = async () => false;

let dirs: string[] = [];

function silentTelemetry(): SessionTelemetry {
  return new SessionTelemetry(async () => undefined);
}

interface Harness {
  readonly manager: InteractiveSessionManager;
  readonly factory: FakeTransportFactory;
  readonly clock: Clock;
}

function harness(
  options: {
    ptyAvailable?: boolean;
    ptyFailsToStart?: boolean;
    transports?: SessionTransportFactory;
    config?: Record<string, unknown>;
    clock?: Clock;
  } = {},
): Harness {
  const dir = tempArtifactDir();
  dirs.push(dir);
  const factory = new FakeTransportFactory({
    ptyAvailable: options.ptyAvailable ?? false,
    ptyFailsToStart: options.ptyFailsToStart ?? false,
  });
  // Real timers by default; the quiet/deadline suite injects a fake clock.
  const clock = options.clock ?? systemClock;
  const manager = new InteractiveSessionManager({
    transports: options.transports ?? factory,
    clock,
    artifactBaseDir: dir,
    journal: new RecoveryJournal(join(dir, "journal")),
    telemetry: silentTelemetry(),
    config: options.config ?? {},
  });
  return { manager, factory, clock };
}

function stableOf(error: unknown): StableError {
  if (error instanceof SessionErrorException) return error.stable;
  throw error;
}

async function expectStable(
  run: () => Promise<unknown>,
  code: StableError["code"],
): Promise<StableError> {
  try {
    await run();
  } catch (error) {
    const stable = stableOf(error);
    expect(stable.code).toBe(code);
    return stable;
  }
  throw new Error(`expected ${code} but the operation succeeded`);
}

beforeEach(() => {
  dirs = [];
});

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// Feature: interactive-terminal-sessions, Property 1: Start receipt and transport selection are coherent
describe("Property 1: start receipt and transport selection are coherent", () => {
  it("selects the transport its mode allows and launches at most once", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("required" as const, "preferred" as const, "pipe" as const),
        fc.boolean(),
        async (terminalMode, ptyAvailable) => {
          const { manager, factory } = harness({ ptyAvailable });
          if (terminalMode === "required" && !ptyAvailable) {
            const error = await expectStable(
              () => manager.start({ ownerId: OWNER, command: "cmd", terminalMode, confirm: approve }),
              "PTY_UNAVAILABLE",
            );
            expect(error.retryable).toBe(false);
            expect(factory.launches).toBe(0);
            return;
          }
          const result = await manager.start({
            ownerId: OWNER,
            command: "cmd",
            terminalMode,
            confirm: approve,
          });
          expect(factory.launches).toBe(1);
          const expected = terminalMode === "pipe" || !ptyAvailable ? "pipe" : "pty";
          expect(result.transport).toBe(expected);
          expect(result.dimensions !== undefined).toBe(expected === "pty");
          expect(result.degradedReason).toBe(
            terminalMode === "preferred" && !ptyAvailable ? "PTY_UNAVAILABLE" : undefined,
          );
          expect(result.sessionId.startsWith("its_")).toBe(true);
          expect(result.state).toBe("running");
          expect(result.cursor).toBe(0);
          expect(result.artifact.path.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("falls back through pipe exactly once when a preferred PTY is unavailable", async () => {
    const { manager, factory } = harness({ ptyAvailable: false });
    const result = await manager.start({ ownerId: OWNER, command: "cmd", confirm: approve });
    expect(result.transport).toBe("pipe");
    expect(factory.ptyStarts).toHaveLength(0);
    expect(factory.pipeStarts).toHaveLength(1);
  });

  it("rejects out-of-range dimensions before any launch", async () => {
    const { manager, factory } = harness({ ptyAvailable: true });
    await expectStable(
      () =>
        manager.start({ ownerId: OWNER, command: "cmd", columns: 1, rows: 24, confirm: approve }),
      "INVALID_REQUEST",
    );
    expect(factory.launches).toBe(0);
  });

  it("requires an owner id and never falls back to a shared owner", async () => {
    const { manager } = harness();
    await expectStable(
      () => manager.start({ ownerId: "", command: "cmd", confirm: approve }),
      "INVALID_REQUEST",
    );
  });
});

describe("start policy and limits", () => {
  it("persists launch identity before a transport factory resolves", async () => {
    const dir = tempArtifactDir();
    dirs.push(dir);
    const journal = new RecoveryJournal(join(dir, "journal"));
    let durableBeforeReturn = false;
    const transport = new FakeTransport({ pid: 4567, processGroupId: 4567 });
    const factory: SessionTransportFactory = {
      capability: async () => ({ available: false, platform: process.platform, reason: "test" }),
      startPipe: async (request) => {
        request.onLaunchIdentity?.({
          pid: transport.pid,
          processGroupId: transport.processGroupId,
          identity: transport.identity,
        });
        durableBeforeReturn = journal.load().some((record) => record.pid === transport.pid);
        return { transport };
      },
      startPty: async () => {
        throw new Error("unexpected PTY launch");
      },
    };
    const manager = new InteractiveSessionManager({
      transports: factory,
      artifactBaseDir: dir,
      journal,
      telemetry: silentTelemetry(),
    });

    await manager.start({ ownerId: OWNER, command: "cmd", confirm: approve });

    expect(durableBeforeReturn).toBe(true);
  });

  it("blocks a destructive command without allocating a process", async () => {
    const { manager, factory } = harness();
    await expectStable(
      () => manager.start({ ownerId: OWNER, command: "rm -rf /", confirm: approve }),
      "INPUT_REJECTED",
    );
    expect(factory.launches).toBe(0);
  });

  it("refuses to start a confirm-level command that was not confirmed", async () => {
    const { manager, factory } = harness();
    await expectStable(
      () => manager.start({ ownerId: OWNER, command: "sed -i s/a/b/ f", confirm: decline }),
      "INPUT_REJECTED",
    );
    expect(factory.launches).toBe(0);
  });

  it("enforces the live session limit without spawning", async () => {
    const { manager, factory } = harness({ config: { liveSessionLimit: 2 } });
    await manager.start({ ownerId: OWNER, command: "a", confirm: approve });
    await manager.start({ ownerId: OWNER, command: "b", confirm: approve });
    const error = await expectStable(
      () => manager.start({ ownerId: OWNER, command: "c", confirm: approve }),
      "LIMIT_REACHED",
    );
    expect(error.details?.limit).toBe(2);
    expect(factory.launches).toBe(2);
    // Another conversation has its own budget.
    await manager.start({ ownerId: "conv-2", command: "d", confirm: approve });
    expect(factory.launches).toBe(3);
  });

  it("rejects an out-of-range configuration before reserving a slot", () => {
    expect(() => harness({ config: { quietIntervalMs: 1 } })).toThrow(SessionErrorException);
  });
});

// Feature: interactive-terminal-sessions, Property 20: Automatic retries stop at the side-effect boundary
describe("Property 20: automatic retries stop at the side-effect boundary", () => {
  function retryFactory(failures: LaunchFailure[]): {
    factory: SessionTransportFactory;
    attempts: () => number;
  } {
    const inner = new FakeTransportFactory({ ptyAvailable: false });
    let attempts = 0;
    return {
      attempts: () => attempts,
      factory: {
        capability: (platform) => inner.capability(platform),
        startPipe: async (request) => {
          const failure = failures[attempts];
          attempts += 1;
          if (failure) throw failure;
          return await inner.startPipe(request);
        },
        startPty: async (request) => {
          attempts += 1;
          return await inner.startPty(request);
        },
      },
    };
  }

  it("retries once for a proven pre-spawn transient failure", async () => {
    const { factory, attempts } = retryFactory([
      new LaunchFailure("ENOENT", "transient", false, true),
    ]);
    const { manager } = harness({ transports: factory });
    const result = await manager.start({ ownerId: OWNER, command: "cmd", confirm: approve });
    expect(attempts()).toBe(2);
    expect(result.retriedLaunch).toBe(true);
  });

  it("never retries twice, and never after spawn confirmation", async () => {
    const { factory, attempts } = retryFactory([
      new LaunchFailure("ENOENT", "transient", false, true),
      new LaunchFailure("ENOENT", "transient", false, true),
    ]);
    const { manager } = harness({ transports: factory });
    const error = await expectStable(
      () => manager.start({ ownerId: OWNER, command: "cmd", confirm: approve }),
      "LAUNCH_FAILED",
    );
    expect(attempts()).toBe(2);
    expect(error.retryable).toBe(false);

    const confirmed = retryFactory([new LaunchFailure("EIO", "after spawn", true, true)]);
    const second = harness({ transports: confirmed.factory });
    await expectStable(
      () => second.manager.start({ ownerId: OWNER, command: "cmd", confirm: approve }),
      "LAUNCH_FAILED",
    );
    expect(confirmed.attempts()).toBe(1);
  });
});

// Feature: interactive-terminal-sessions, Property 4: Accepted input is FIFO and at-most-once
describe("Property 4: accepted input is FIFO and at-most-once", () => {
  it("writes 120 concurrent sends in ascending sequence order, once each", async () => {
    const { manager, factory } = harness();
    const started = await manager.start({ ownerId: OWNER, command: "cmd", confirm: approve });
    const transport = factory.last();
    const count = 120;
    const results = await Promise.all(
      Array.from({ length: count }, (_unused, index) =>
        manager.send({
          ownerId: OWNER,
          id: started.sessionId,
          input: { kind: "text", text: `y${index}`, submit: "enter" },
          quietMs: 25,
          deadlineMs: 5_000,
          confirm: approve,
        }),
      ),
    );
    const sequences = results.map((result) => result.inputSequence).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: count }, (_unused, index) => index + 1));
    // Writes land in ascending sequence order and each payload appears once.
    const expectedOrder = results
      .map((result, index) => ({ sequence: result.inputSequence, text: `y${index}\n` }))
      .sort((a, b) => a.sequence - b.sequence)
      .map((entry) => entry.text);
    expect(transport.writes).toEqual(expectedOrder);
    expect(new Set(transport.writes).size).toBe(count);
  });

  it("appends exactly one transport newline for enter and nothing for none", async () => {
    for (const kind of ["pipe", "pty"] as const) {
      const { manager, factory } = harness({ ptyAvailable: kind === "pty" });
      const started = await manager.start({
        ownerId: OWNER,
        command: "cmd",
        terminalMode: kind === "pty" ? "required" : "pipe",
        confirm: approve,
      });
      const transport = factory.last();
      await manager.send({
        ownerId: OWNER,
        id: started.sessionId,
        input: { kind: "text", text: "y", submit: "enter" },
        quietMs: 25,
        confirm: approve,
      });
      await manager.send({
        ownerId: OWNER,
        id: started.sessionId,
        input: { kind: "text", text: "y", submit: "none" },
        quietMs: 25,
        confirm: approve,
      });
      expect(transport.writes).toEqual([kind === "pty" ? "y\r" : "y\n", "y"]);
    }
  });

  it("does not retry an ambiguous write and reports it as non-retryable", async () => {
    const { manager } = harness();
    const started = await manager.start({ ownerId: OWNER, command: "cmd", confirm: approve });
    const factoryTransport = (manager as unknown as { runtimes: Map<string, { transport: { write: unknown } }> })
      .runtimes.get(started.sessionId)!.transport;
    let calls = 0;
    (factoryTransport as { write: (bytes: Uint8Array) => Promise<unknown> }).write = async (
      bytes,
    ) => {
      calls += 1;
      return { status: "unknown", deliveredBytes: bytes.length };
    };
    const result = await manager.send({
      ownerId: OWNER,
      id: started.sessionId,
      input: { kind: "text", text: "y", submit: "enter" },
      quietMs: 25,
      confirm: approve,
    });
    expect(calls).toBe(1);
    expect(result.delivery).toBe("unknown");
    expect(result.error?.code).toBe("INPUT_DELIVERY_UNKNOWN");
    expect(result.error?.retryable).toBe(false);
  });
});

// Feature: interactive-terminal-sessions, Property 5: EOF and backpressure acceptance are atomic
describe("Property 5: EOF and backpressure acceptance are atomic", () => {
  it("closes input once and rejects all later input", async () => {
    const { manager, factory } = harness();
    const started = await manager.start({ ownerId: OWNER, command: "cmd", confirm: approve });
    await manager.send({
      ownerId: OWNER,
      id: started.sessionId,
      input: { kind: "eof" },
      quietMs: 25,
    });
    expect(factory.last().inputClosed).toBe(1);
    const error = await expectStable(
      () =>
        manager.send({
          ownerId: OWNER,
          id: started.sessionId,
          input: { kind: "text", text: "y", submit: "enter" },
          quietMs: 25,
          confirm: approve,
        }),
      "INPUT_CLOSED",
    );
    expect(error.retryable).toBe(false);
    expect(factory.last().writes).toHaveLength(0);
  });

  it("rejects an over-limit action without consuming a sequence number", async () => {
    const { manager, factory } = harness({ config: { queuedInputBytes: 1_024 } });
    const started = await manager.start({ ownerId: OWNER, command: "cmd", confirm: approve });
    const error = await expectStable(
      () =>
        manager.send({
          ownerId: OWNER,
          id: started.sessionId,
          input: { kind: "text", text: "z".repeat(2_000), submit: "none" },
          quietMs: 25,
          confirm: approve,
        }),
      "BACKPRESSURE",
    );
    expect(error.details?.limitBytes).toBe(1_024);
    expect(factory.last().writes).toHaveLength(0);
    const accepted = await manager.send({
      ownerId: OWNER,
      id: started.sessionId,
      input: { kind: "text", text: "ok", submit: "enter" },
      quietMs: 25,
      confirm: approve,
    });
    // The rejected action never burned sequence 1.
    expect(accepted.inputSequence).toBe(1);
  });
});

// Feature: interactive-terminal-sessions, Property 12: Resize cannot revive or mutate an incompatible session
describe("Property 12: resize cannot revive or mutate an incompatible session", () => {
  it("resizes a running pty and refuses a pipe session", async () => {
    const pty = harness({ ptyAvailable: true });
    const started = await pty.manager.start({
      ownerId: OWNER,
      command: "cmd",
      terminalMode: "required",
      confirm: approve,
    });
    const result = await pty.manager.resize({
      ownerId: OWNER,
      id: started.sessionId,
      columns: 120,
      rows: 40,
    });
    expect(result.dimensions).toEqual({ columns: 120, rows: 40 });
    expect(pty.factory.last().resizes).toEqual([{ columns: 120, rows: 40 }]);

    const pipe = harness();
    const pipeSession = await pipe.manager.start({
      ownerId: OWNER,
      command: "cmd",
      confirm: approve,
    });
    await expectStable(
      () =>
        pipe.manager.resize({
          ownerId: OWNER,
          id: pipeSession.sessionId,
          columns: 100,
          rows: 30,
        }),
      "UNSUPPORTED_OPERATION",
    );
    expect(pipe.manager.status({ ownerId: OWNER, id: pipeSession.sessionId }).session.state).toBe(
      "running",
    );
  });

  it("never revives a closed session through resize", async () => {
    const { manager } = harness({ ptyAvailable: true });
    const started = await manager.start({
      ownerId: OWNER,
      command: "cmd",
      terminalMode: "required",
      confirm: approve,
    });
    await manager.close({ ownerId: OWNER, id: started.sessionId });
    await expectStable(
      () => manager.resize({ ownerId: OWNER, id: started.sessionId, columns: 90, rows: 30 }),
      "SESSION_NOT_RUNNING",
    );
    expect(manager.status({ ownerId: OWNER, id: started.sessionId }).session.state).toBe("closed");
  });
});

// Feature: interactive-terminal-sessions, Property 17: Sessions isolate mutable I/O state
describe("Property 17: sessions isolate mutable I/O state", () => {
  it("keeps queues, cursors, and terminal outcomes independent", async () => {
    const { manager, factory } = harness();
    const a = await manager.start({ ownerId: OWNER, command: "a", confirm: approve });
    const b = await manager.start({ ownerId: OWNER, command: "b", confirm: approve });
    const [transportA, transportB] = factory.transports;
    transportA!.emit("from-a");
    const sendB = await manager.send({
      ownerId: OWNER,
      id: b.sessionId,
      input: { kind: "text", text: "hi", submit: "enter" },
      quietMs: 25,
      confirm: approve,
    });
    expect(sendB.inputSequence).toBe(1);
    expect(transportA!.writes).toHaveLength(0);
    await manager.close({ ownerId: OWNER, id: a.sessionId });
    expect(manager.status({ ownerId: OWNER, id: a.sessionId }).session.state).toBe("closed");
    expect(manager.status({ ownerId: OWNER, id: b.sessionId }).session.state).toBe("running");
    const readB = await manager.read({ ownerId: OWNER, id: b.sessionId, cursor: 0 });
    expect(readB.page?.events.map((event) => event.content).join("")).not.toContain("from-a");
    void transportB;
  });
});
