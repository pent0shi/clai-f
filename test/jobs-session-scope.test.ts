import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobManager, type BackgroundJob } from "../src/tools/jobs.js";
import { formatToolContext } from "../src/agent/tool-output-formatting.js";

const dirs: string[] = [];
const managers: JobManager[] = [];

async function fixture(): Promise<{ dir: string; manager: JobManager }> {
  const dir = await mkdtemp(join(tmpdir(), "clai-jobs-session-"));
  dirs.push(dir);
  const manager = new JobManager(dir);
  managers.push(manager);
  return { dir, manager };
}

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    for (const job of manager.getRunningJobs()) {
      await manager.stopJob(job.id, { graceMs: 200 });
    }
  }
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function emptyArtifact(path = "") {
  return {
    path,
    chunks: [] as string[],
    bytes: 0,
    droppedBytes: 0,
    redacted: false,
    sha256: "",
  };
}

function ephemeralToolTrack(
  id: string,
  sessionId: string,
  commandDisplay: string,
): BackgroundJob {
  return {
    id,
    command: commandDisplay,
    commandDisplay,
    cwd: "/tmp",
    status: "running",
    startedAt: new Date().toISOString(),
    artifactPath: "",
    stdoutArtifact: "",
    stderrArtifact: "",
    artifacts: { stdout: emptyArtifact(), stderr: emptyArtifact() },
    redactionProfile: "provider-secrets-v1",
    ownerSessionId: sessionId,
    kind: "ephemeral",
  };
}

describe("session-scoped jobs", () => {
  it("listJobs never shows ephemeral tool-stall rows", async () => {
    const { manager } = await fixture();
    manager.registerJob(
      "ephem01",
      ephemeralToolTrack("ephem01", "sess-a", "shell.jobs {}"),
    );
    manager.registerJob(
      "ephem02",
      ephemeralToolTrack("ephem02", "sess-a", "fs.list /tmp"),
    );
    const listed = manager.listJobs("sess-a");
    expect(listed.ok).toBe(true);
    expect(listed.output).toMatch(/No background jobs/);
    expect(listed.output).not.toContain("shell.jobs");
    expect(listed.output).not.toContain("fs.list");
  });

  it("listJobs filters to the current session durable jobs only", async () => {
    const { manager } = await fixture();
    const a = await manager.startJob(
      `${JSON.stringify(process.execPath)} -e "console.log('a'); setTimeout(()=>{}, 2000)"`,
      { ownerSessionId: "session-alpha" },
    );
    const b = await manager.startJob(
      `${JSON.stringify(process.execPath)} -e "console.log('b'); setTimeout(()=>{}, 2000)"`,
      { ownerSessionId: "session-beta" },
    );
    const idA = a.backgroundJob?.id;
    const idB = b.backgroundJob?.id;
    expect(idA && idB).toBeTruthy();

    const listA = manager.listJobs("session-alpha");
    expect(listA.output).toContain(idA!);
    expect(listA.output).not.toContain(idB!);
    expect(listA.output).toMatch(/session session-/i);

    const listB = manager.listJobs("session-beta");
    expect(listB.output).toContain(idB!);
    expect(listB.output).not.toContain(idA!);

    await manager.stopJob(idA!, { graceMs: 300 });
    await manager.stopJob(idB!, { graceMs: 300 });
  });

  it("drops finished ephemeral rows and does not persist them", async () => {
    const { dir, manager } = await fixture();
    manager.registerJob(
      "track1",
      ephemeralToolTrack("track1", "s1", "sysinfo {}"),
    );
    expect(manager.getJob("track1")).toBeTruthy();
    manager.updateJobStatus("track1", "exited", 0);
    expect(manager.getJob("track1")).toBeUndefined();
    const registry = await readFile(join(dir, "registry-v1.json"), "utf8").catch(
      () => "[]",
    );
    expect(registry).not.toContain("sysinfo");
    expect(registry).not.toContain("track1");
  });

  it("formatToolContext keeps full shell.jobs body (no generic reduce omit)", () => {
    const lines = Array.from(
      { length: 12 },
      (_, i) =>
        `[abc${i}] exited health=terminal exit=0 ${i}s  npm run build`,
    );
    const body = [
      "Session background jobs (12 total, session deadbeef…):",
      ...lines,
      "None currently running.",
    ].join("\n");
    const ctx = formatToolContext(
      { name: "shell.jobs", args: {} },
      { ok: true, output: body, exitCode: 0 },
    );
    expect(ctx).toContain("Session background jobs");
    expect(ctx).toContain("npm run build");
    expect(ctx).not.toMatch(/Reduced output/i);
    expect(ctx).not.toMatch(/lines omitted/i);
  });

  it("formatToolContext keeps sysinfo JSON intact", () => {
    const body = JSON.stringify(
      { platform: "darwin", cwd: "/Users/me/Desktop/blog" },
      null,
      2,
    );
    const ctx = formatToolContext(
      { name: "sysinfo", args: {} },
      { ok: true, output: body, exitCode: 0 },
    );
    expect(ctx).toContain("darwin");
    expect(ctx).toContain("Desktop/blog");
    expect(ctx).not.toMatch(/Reduced output/i);
  });
});
