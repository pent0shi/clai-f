import { existsSync } from "node:fs";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const probe = { execFileSyncCalls: 0 };

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      probe.execFileSyncCalls += 1;
      return actual.execFileSync(...args);
    },
  };
});

const { JobManager } = await import("../src/tools/jobs.js");

const dirs: string[] = [];
const managers: InstanceType<typeof JobManager>[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(): Promise<{
  dir: string;
  manager: InstanceType<typeof JobManager>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "clai-jobs-perf-"));
  dirs.push(dir);
  const manager = new JobManager(dir);
  managers.push(manager);
  return { dir, manager };
}

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await manager.cancelAll("session-perf").catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  probe.execFileSyncCalls = 0;
});

describe("job liveness probe cost", () => {
  it("probes a restored job at most once per interval regardless of subscribers", async () => {
    const { dir, manager } = await fixture();
    const started = await manager.startJob(
      `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
      { ownerSessionId: "session-perf" },
    );
    const id = /id=([a-f0-9]+)/.exec(started.output)?.[1];
    expect(id).toBeTruthy();
    await sleep(120);

    const restored = new JobManager(dir);
    managers.push(restored);
    expect(restored.getJob(id!)?.status).toBe("running");

    probe.execFileSyncCalls = 0;
    for (let call = 0; call < 60; call += 1) {
      restored.getRunningJobs("session-perf");
      restored.getRecentJobs(20, "session-perf");
    }
    // Linux reads /proc (zero forks); elsewhere the ps probe is cached and
    // throttled, so 120 state reads must not fork 120 times.
    expect(probe.execFileSyncCalls).toBeLessThanOrEqual(2);

    await restored.stopJob(id!, { graceMs: 200 });
  });
});

describe("job artifact retention", () => {
  it("sweeps orphaned artifact chunks older than retention on boot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clai-jobs-sweep-"));
    dirs.push(dir);
    const stale = join(dir, "2026-01-01T00-00-00-000Z-deadbeef.stdout.log");
    const staleChunk = `${stale}.1`;
    const fresh = join(dir, "2026-07-26T00-00-00-000Z-cafebabe.stderr.log");
    await writeFile(stale, "old output", { mode: 0o600 });
    await writeFile(staleChunk, "old rotation", { mode: 0o600 });
    await writeFile(fresh, "recent output", { mode: 0o600 });
    const old = new Date(Date.now() - 72 * 60 * 60 * 1000);
    await utimes(stale, old, old);
    await utimes(staleChunk, old, old);

    const manager = new JobManager(dir);
    managers.push(manager);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(staleChunk)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("deletes artifacts when the job row is dropped", async () => {
    const { manager } = await fixture();
    const started = await manager.startJob(
      `${JSON.stringify(process.execPath)} -e "console.log('done')"`,
      { ownerSessionId: "session-perf" },
    );
    const id = /id=([a-f0-9]+)/.exec(started.output)?.[1];
    expect(id).toBeTruthy();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && manager.getJob(id!)?.status === "running") {
      await sleep(25);
    }
    const job = manager.getJob(id!);
    const artifact = job?.stdoutArtifact;
    expect(artifact).toBeTruthy();
    expect(existsSync(artifact!)).toBe(true);

    for (const notification of manager.getPendingNotifications("session-perf")) {
      manager.acknowledge(notification.id, "session-perf");
    }
    job!.endedAt = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    manager.pruneTerminalJobs();

    expect(manager.getJob(id!)).toBeUndefined();
    expect(existsSync(artifact!)).toBe(false);
  });
});
