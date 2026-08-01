import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BoundedArtifactWriter } from "../../src/interactive-session/artifact-writer.js";
import { CleanupCoordinator } from "../../src/interactive-session/cleanup.js";
import { INTERACTIVE_SESSION_DEFAULTS } from "../../src/interactive-session/config.js";
import { OutputStore } from "../../src/interactive-session/output-store.js";
import {
  RecoveryJournal,
  hashOwner,
  type JournalRecord,
} from "../../src/interactive-session/recovery-journal.js";
import { SessionRegistry } from "../../src/interactive-session/registry.js";
import { systemClock } from "../../src/interactive-session/runtime.js";
import { SessionRuntime } from "../../src/interactive-session/session-runtime.js";
import {
  startPtyTransport,
  type PtyProcessLike,
} from "../../src/interactive-session/transport-node-pty.js";
import type { SessionTransport } from "../../src/interactive-session/transport.js";
import type {
  ArtifactReceipt,
  InteractiveSessionRecord,
  TerminationReason,
} from "../../src/interactive-session/types.js";
import { FakeTransport, MemorySink } from "./helpers.js";

const tempDirectories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "clai-cleanup-recovery-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class ControlledTransport extends FakeTransport {
  onTerminate: (kind: "graceful" | "forceful") => void = () => undefined;

  constructor(pid = 4242, processGroupId?: number) {
    super({ pid, processGroupId });
  }

  override async requestTreeTermination(
    kind: "graceful" | "forceful",
  ): Promise<"sent"> {
    this.terminations.push(kind);
    this.onTerminate(kind);
    return "sent";
  }
}

interface ArtifactDouble {
  readonly writer: BoundedArtifactWriter;
  readonly closeCalls: () => number;
}

function artifactDouble(options: {
  onClose?: () => void;
  failClose?: boolean;
} = {}): ArtifactDouble {
  let closes = 0;
  const receipt: ArtifactReceipt = {
    path: "/opaque/artifact.log",
    bytes: 0,
    droppedBytes: 0,
    redacted: true,
    chunks: [],
    sha256: "",
  };
  const writer = {
    path: receipt.path,
    async close() {
      closes += 1;
      options.onClose?.();
      if (options.failClose) throw new Error("injected persistence failure");
    },
    receipt: () => receipt,
  } as unknown as BoundedArtifactWriter;
  return { writer, closeCalls: () => closes };
}

function cleanupHarness(options: {
  alive?: boolean;
  comparison?: "match" | "mismatch" | "gone" | "unknown";
  descendants?: boolean;
  groupAlive?: boolean;
  processGroupId?: number;
  gracefulCloseMs?: number;
  artifact?: ArtifactDouble;
} = {}) {
  const registry = new SessionRegistry();
  const record: InteractiveSessionRecord = {
    id: "its_cleanup_test",
    ownerId: "owner",
    state: "running",
    transport: "pipe",
    startedAt: 1,
    lastActivityAt: 1,
    artifact: {
      path: "/opaque/artifact.log",
      bytes: 0,
      droppedBytes: 0,
      redacted: true,
      chunks: [],
      sha256: "",
    },
    earliestCursor: 0,
    latestCursor: 0,
    inputClosed: false,
  };
  registry.insert(record);

  const sink = new MemorySink();
  const output = new OutputStore({
    memoryWindowBytes: 65_536,
    pageBytes: 1_024,
    redactionOverlapBytes: 256,
    sink,
  });
  const transport = new ControlledTransport(4242, options.processGroupId);
  const artifact = options.artifact ?? artifactDouble();
  const runtime = new SessionRuntime({
    record,
    transport,
    output,
    artifact: artifact.writer,
    config: {
      ...INTERACTIVE_SESSION_DEFAULTS,
      gracefulCloseMs: options.gracefulCloseMs ?? 0,
    },
    clock: systemClock,
    idleTimeoutMs: undefined,
    lifetimeTimeoutMs: undefined,
    onTimeout: () => undefined,
  });

  let alive = options.alive ?? true;
  let groupAlive = options.groupAlive ?? false;
  let finalized = 0;
  let listenersReleased = 0;
  let journalRemovals = 0;
  runtime.track(() => {
    listenersReleased += 1;
  });
  const coordinator = new CleanupCoordinator({
    registry,
    journal: {
      remove: () => {
        journalRemovals += 1;
      },
    } as RecoveryJournal,
    onFinalized: () => {
      finalized += 1;
    },
    process: {
      isAlive: () => alive,
      isProcessGroupAlive: () => groupAlive,
      compareIdentity: () => options.comparison ?? "match",
      hasLiveDescendants: async () => options.descendants ?? false,
    },
  });

  return {
    artifact,
    coordinator,
    output,
    record,
    runtime,
    sink,
    transport,
    setAlive(value: boolean) {
      alive = value;
    },
    setGroupAlive(value: boolean) {
      groupAlive = value;
    },
    counts: () => ({ finalized, listenersReleased, journalRemovals }),
  };
}

function journalRecord(
  id: string,
  pid: number | undefined,
  launchConfirmed = true,
): JournalRecord {
  return {
    id,
    ownerHash: hashOwner("conversation-secret"),
    pid,
    processGroupId: pid,
    identity: pid === undefined ? undefined : `identity-${pid}`,
    platform: process.platform,
    startedAt: 123,
    artifactPath: `/opaque/${id}.log`,
    launchConfirmed,
  };
}

describe("cleanup integration", () => {
  it("performs deterministic graceful cleanup and drains final output before close", async () => {
    let harness: ReturnType<typeof cleanupHarness>;
    const artifact = artifactDouble({
      onClose: () => {
        expect(Buffer.from(harness.sink.bytes()).toString("utf8")).toBe("secret-");
      },
    });
    harness = cleanupHarness({ artifact, gracefulCloseMs: 100 });
    harness.output.registerExactSecret("secret-value");
    harness.output.ingest("stdout", Buffer.from("secret-"), 1);
    expect(harness.sink.bytes()).toHaveLength(0);
    harness.transport.onTerminate = (kind) => {
      if (kind === "graceful") harness.setAlive(false);
    };

    const result = await harness.coordinator.close(
      harness.runtime,
      "explicit-close",
      500,
    );

    expect(harness.transport.terminations).toEqual(["graceful"]);
    expect(result.cleanupVerified).toBe(true);
    expect(result.error).toBeUndefined();
    expect(harness.record.latestCursor).toBe(7);
    expect(artifact.closeCalls()).toBe(1);
  });

  it("escalates once to force and reports a verified survivor as CLEANUP_FAILED", async () => {
    const escalated = cleanupHarness({ gracefulCloseMs: 0 });
    escalated.transport.onTerminate = (kind) => {
      if (kind === "forceful") escalated.setAlive(false);
    };
    const success = await escalated.coordinator.close(
      escalated.runtime,
      "explicit-close",
      500,
    );
    expect(escalated.transport.terminations).toEqual(["graceful", "forceful"]);
    expect(success.cleanupVerified).toBe(true);

    const survivor = cleanupHarness({ alive: true, comparison: "match" });
    const failure = await survivor.coordinator.close(
      survivor.runtime,
      "explicit-close",
      0,
    );
    expect(survivor.transport.terminations).toEqual(["graceful", "forceful"]);
    expect(failure.state).toBe("failed");
    expect(failure.cleanupVerified).toBe(false);
    expect(failure.error?.code).toBe("CLEANUP_FAILED");
    expect(JSON.stringify(failure.error)).not.toContain("command");
  });

  it.each([
    ["mismatch", true],
    ["unknown", false],
  ] as const)("does not signal on identity %s", async (comparison, verified) => {
    const harness = cleanupHarness({ alive: true, comparison });
    const result = await harness.coordinator.close(
      harness.runtime,
      "explicit-close",
      0,
    );
    expect(harness.transport.terminations).toEqual([]);
    expect(result.cleanupVerified).toBe(verified);
    expect(result.error?.code).toBe(
      comparison === "unknown" ? "CLEANUP_FAILED" : undefined,
    );
  });

  it("signals and verifies a live launch group after its root has exited", async () => {
    const harness = cleanupHarness({
      alive: false,
      groupAlive: true,
      processGroupId: 4242,
    });
    harness.transport.onTerminate = () => {
      harness.setGroupAlive(false);
    };

    const result = await harness.coordinator.close(
      harness.runtime,
      "explicit-close",
      500,
    );

    expect(harness.transport.terminations).toEqual(["graceful"]);
    expect(result.cleanupVerified).toBe(true);
  });

  it("returns PERSIST_FAILED but still releases and finalizes every resource once", async () => {
    const artifact = artifactDouble({ failClose: true });
    const harness = cleanupHarness({ alive: false, artifact });
    const reasons: TerminationReason[] = [
      "explicit-close",
      "cancelled",
      "idle-timeout",
      "lifetime-timeout",
      "conversation-teardown",
      "app-shutdown",
      "process-exit",
    ];
    const results = await Promise.all(
      reasons.map((reason) => harness.coordinator.close(harness.runtime, reason, 100)),
    );
    const repeated = await harness.coordinator.close(
      harness.runtime,
      "app-shutdown",
      100,
    );

    expect(results.every((result) => result === results[0])).toBe(true);
    expect(repeated).toBe(results[0]);
    expect(results[0]?.error?.code).toBe("PERSIST_FAILED");
    expect(harness.transport.disposed).toBe(1);
    expect(artifact.closeCalls()).toBe(1);
    expect(harness.runtime.disposed).toBe(true);
    expect(harness.counts()).toEqual({
      finalized: 1,
      listenersReleased: 1,
      journalRemovals: 1,
    });
  });
  it("releases a native PTY allocated before launch confirmation", async () => {
    let kills = 0;
    const pty: PtyProcessLike = {
      pid: 0,
      onData: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
      write: () => undefined,
      resize: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      kill: () => {
        kills += 1;
      },
    };

    await expect(
      startPtyTransport(
        {
          command: "ignored",
          cwd: process.cwd(),
          dimensions: { columns: 80, rows: 24 },
        },
        { module: { spawn: () => pty }, shell: "/bin/sh" },
      ),
    ).rejects.toMatchObject({ code: "PTY_SPAWN_FAILED" });
    expect(kills).toBe(1);
  });

  it("keeps PTY output emitted after exit until its drain quiesces", async () => {
    let onData: ((data: string | Buffer) => void) | undefined;
    let onExit: ((event: { exitCode: number; signal?: number | undefined }) => void) | undefined;
    const pty: PtyProcessLike = {
      pid: 4321,
      onData: (listener) => {
        onData = listener;
        return { dispose: () => undefined };
      },
      onExit: (listener) => {
        onExit = listener;
        return { dispose: () => undefined };
      },
      write: () => undefined,
      resize: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      kill: () => undefined,
    };
    const launched = await startPtyTransport(
      {
        command: "ignored",
        cwd: process.cwd(),
        dimensions: { columns: 80, rows: 24 },
      },
      { module: { spawn: () => pty }, shell: "/bin/sh" },
    );
    const output: string[] = [];
    launched.transport.onOutput((event) => output.push(Buffer.from(event.bytes).toString("utf8")));
    onExit?.({ exitCode: 0 });
    onData?.("final bytes");
    await launched.transport.waitForOutputDrain?.();
    expect(output).toEqual(["final bytes"]);
  });
});

describe("recovery journal integration", () => {
  it("reconciles all five outcomes and signals only an identity match", () => {
    const directory = tempDirectory();
    const comparisons = new Map<number, "match" | "mismatch" | "gone" | "unknown">([
      [11, "match"],
      [12, "gone"],
      [13, "mismatch"],
      [14, "unknown"],
    ]);
    const signalled: Array<{ pid: number; signal: NodeJS.Signals; group?: number }> = [];
    const journal = new RecoveryJournal(directory, {
      compareIdentity: (pid) => comparisons.get(pid ?? -1) ?? "unknown",
      terminateTree: (pid, options) => {
        signalled.push({
          pid,
          signal: options.signal,
          ...(options.processGroupId !== undefined
            ? { group: options.processGroupId }
            : {}),
        });
        return "sent";
      },
    });
    for (const record of [
      journalRecord("terminated", 11),
      journalRecord("gone", 12),
      journalRecord("mismatch", 13),
      journalRecord("unverified", 14),
      journalRecord("launch-failed", undefined, false),
    ]) {
      journal.upsert(record);
    }

    expect(journal.reconcile()).toEqual([
      { id: "terminated", outcome: "terminated" },
      { id: "gone", outcome: "gone" },
      { id: "mismatch", outcome: "identity-mismatch" },
      { id: "unverified", outcome: "unverified" },
      { id: "launch-failed", outcome: "unverified" },
    ]);
    expect(signalled).toEqual([{ pid: 11, signal: "SIGKILL", group: 11 }]);
    expect(journal.load()).toEqual([
      journalRecord("unverified", 14),
      journalRecord("launch-failed", undefined, false),
    ]);
  });

  it("persists only cleanup evidence with owner-only permissions", () => {
    const directory = tempDirectory();
    const journal = new RecoveryJournal(directory);
    journal.upsert(journalRecord("opaque-session", 21));

    const path = join(directory, "registry-v1.json");
    const content = readFileSync(path, "utf8");
    const parsed = JSON.parse(content) as { sessions: Array<Record<string, unknown>> };
    expect(Object.keys(parsed.sessions[0] ?? {}).sort()).toEqual(
      [
        "artifactPath",
        "id",
        "identity",
        "launchConfirmed",
        "ownerHash",
        "pid",
        "platform",
        "processGroupId",
        "startedAt",
      ].sort(),
    );
    for (const secret of [
      "conversation-secret",
      "raw-command-secret",
      "raw-input-secret",
      "raw-output-secret",
      "environment-secret",
    ]) {
      expect(content).not.toContain(secret);
    }
    if (process.platform !== "win32") {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it("does not throw or leave a readable record when persistence fails", () => {
    const root = tempDirectory();
    const blocker = join(root, "not-a-directory");
    writeFileSync(blocker, "block");
    const journal = new RecoveryJournal(join(blocker, "journal"));

    expect(() => journal.upsert(journalRecord("not-persisted", 31))).not.toThrow();
    expect(journal.load()).toEqual([]);
    expect(() => journal.remove("not-persisted")).not.toThrow();
  });
});
