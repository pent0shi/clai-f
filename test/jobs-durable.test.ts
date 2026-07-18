import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobManager } from "../src/tools/jobs.js";

const dirs: string[] = [];
const managers: JobManager[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(): Promise<{ dir: string; manager: JobManager }> {
  const dir = await mkdtemp(join(tmpdir(), "clai-jobs-"));
  dirs.push(dir);
  const manager = new JobManager(dir);
  managers.push(manager);
  return { dir, manager };
}

async function waitForStatus(manager: JobManager, id: string, statuses: string[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (statuses.includes(manager.getJob(id)?.status ?? "")) return;
    await sleep(25);
  }
  throw new Error(`job ${id} did not reach ${statuses.join("/")}`);
}

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    for (const job of manager.getRunningJobs()) await manager.stopJob(job.id, { graceMs: 200 });
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("durable background jobs", () => {
  it("rediscovers, offset-tails, and process-group stops a live job after restart", async () => {
    const { dir, manager } = await fixture();
    const secret = "sk-super-secret-value";
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`console.log('${secret}'); setInterval(() => console.log('tick'), 40)`)}`;
    const started = await manager.startJob(command, { ownerSessionId: "session-1" });
    const id = /id=([a-f0-9]+)/.exec(started.output)?.[1];
    expect(id).toBeTruthy();
    await sleep(150);

    const restarted = new JobManager(dir);
    managers.push(restarted);
    const recovered = restarted.getJob(id!);
    expect(recovered).toMatchObject({ status: "running", ownerSessionId: "session-1" });
    expect(recovered?.processGroupId).toBe(recovered?.pid);

    const first = await restarted.tailJob(id!, { stream: "stdout", offset: 0, bytes: 80 });
    const nextOffset = Number(/nextOffset=(\d+)/.exec(first.output)?.[1]);
    const second = await restarted.tailJob(id!, { stream: "stdout", offset: nextOffset, bytes: 80 });
    expect(first.output).not.toContain(secret);
    expect(`${first.output}\n${second.output}`).toContain("sk-••••••");
    expect(nextOffset).toBeGreaterThan(0);

    const stopped = await restarted.stopJob(id!, { graceMs: 500 });
    expect(stopped).toMatchObject({ ok: true });
    expect(stopped.output).toMatch(/termination verified/);
    expect(restarted.getJob(id!)?.status).toBe("killed");

    const registry = await readFile(join(dir, "registry-v1.json"), "utf8");
    expect(registry).not.toContain(secret);
    expect(registry).toContain('"status": "killed"');
  });

  it("records nonzero exits as failed with the actual exit code", async () => {
    const { manager } = await fixture();
    const started = await manager.startJob(`${JSON.stringify(process.execPath)} -e "process.exit(7)"`);
    const id = /id=([a-f0-9]+)/.exec(started.output)?.[1];
    expect(id).toBeTruthy();
    await waitForStatus(manager, id!, ["failed"]);
    expect(manager.getJob(id!)).toMatchObject({ status: "failed", exitCode: 7 });
    const tail = await manager.tailJob(id!);
    expect(tail.output).toContain(`[${id}] failed exit=7`);
    expect(tail.backgroundJob).toMatchObject({ status: "failed", exitCode: 7 });
  });

  it("labels launch success separately from later application failure", async () => {
    const { manager } = await fixture();
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => process.exit(7), 80)")}`;
    const started = await manager.startJob(command);

    expect(started.ok).toBe(true);
    expect(started.output).toContain("OS process launch confirmed");
    expect(started.output).toContain("does not prove application readiness");
    expect(started.output).toContain("shell.tail");

    const id = started.backgroundJob?.id;
    expect(id).toBeTruthy();
    await waitForStatus(manager, id!, ["failed"]);
    expect(manager.getJob(id!)).toMatchObject({ status: "failed", exitCode: 7 });
  });

  it("forwards sensitive stdin once without persisting it and accepts artifact aliases", async () => {
    const { dir, manager } = await fixture();
    const secret = "modal-password-never-persist";
    const script =
      "let data=''; process.stdin.on('data', c => data += c); " +
      "process.stdin.on('end', () => { console.log(data.trim() === 'modal-password-never-persist' ? 'accepted' : 'rejected'); process.exit(data.trim() === 'modal-password-never-persist' ? 0 : 9); });";
    const started = await manager.startJob({
      command: process.execPath,
      argv: ["-e", script],
      stdinText: `${secret}\n`,
      display: "privileged-fixture",
    });
    const id = started.backgroundJob?.id;
    expect(id).toBeTruthy();
    await waitForStatus(manager, id!, ["exited", "failed"]);
    expect(manager.getJob(id!)).toMatchObject({ status: "exited", exitCode: 0 });

    const aliasTail = await manager.tailJob(started.outputPath!);
    expect(aliasTail.ok).toBe(true);
    expect(aliasTail.backgroundJob?.id).toBe(id);
    expect(aliasTail.output).toContain("accepted");

    const registry = await readFile(join(dir, "registry-v1.json"), "utf8");
    const stdout = await readFile(started.outputPath!, "utf8");
    expect(`${started.output}\n${registry}\n${stdout}`).not.toContain(secret);
    expect(started.output).toContain(`shell.tail {"id":"${id}"}`);
  });

  it("marks unverifiable persisted running records lost instead of trusting a reused pid", async () => {
    const { dir, manager } = await fixture();
    const started = await manager.startJob(`${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`);
    const id = /id=([a-f0-9]+)/.exec(started.output)?.[1]!;
    await sleep(80);
    const registryPath = join(dir, "registry-v1.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    registry.jobs.find((job: { id: string }) => job.id === id).processIdentity = "wrong-identity";
    await import("node:fs/promises").then(({ writeFile }) => writeFile(registryPath, JSON.stringify(registry)));

    const restarted = new JobManager(dir);
    managers.push(restarted);
    expect(restarted.getJob(id)?.status).toBe("lost");
    await manager.stopJob(id, { graceMs: 200 });
  });
});


describe("durable job safety edges", () => {
  it("redacts a secret split across process output chunks", async () => {
    const { manager } = await fixture();
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('sk-super-'); setTimeout(() => { process.stdout.write('secret-value\\n'); }, 25)")}`;
    const started = await manager.startJob(command);
    const id = started.backgroundJob?.id;
    expect(id).toBeTruthy();
    await waitForStatus(manager, id!, ["exited"]);
    const tailed = await manager.tailJob(id!, { stream: "stdout", offset: 0, bytes: 4096 });
    expect(tailed.output).not.toContain("sk-super-secret-value");
    expect(tailed.output).toContain("sk-••••••");
  });

  it("refuses to start a durable action after authorization expiry", async () => {
    const { manager } = await fixture();
    const result = await manager.startJob("echo should-not-run", {
      authorization: { target: "example.com", expiresAt: "2000-01-01T00:00:00.000Z" },
    });
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(manager.getRecentJobs()).toHaveLength(0);
  });

  it("waits for OS spawn confirmation and returns actionable launch failures", async () => {
    const { dir, manager } = await fixture();
    const missingExecutable = join(dir, "definitely-missing-command");
    const result = await manager.startJob({
      command: missingExecutable,
      argv: [],
      display: "missing-command-fixture",
    });

    expect(result).toMatchObject({ ok: false, exitCode: 127 });
    expect(result.output).toContain("Background command launch error [ENOENT]");
    expect(result.output).toContain(`target=${JSON.stringify(missingExecutable)}`);
    expect(result.output).toContain(`cwd=${JSON.stringify(process.cwd())}`);
    expect(result.output).toContain("The command did not start");
    expect(result.backgroundJob).toMatchObject({ status: "failed", exitCode: 127 });
    expect(manager.getJob(result.backgroundJob!.id)).toMatchObject({
      status: "failed",
      exitCode: 127,
    });
  });

  it("rejects an invalid cwd before creating a phantom background job", async () => {
    const { dir, manager } = await fixture();
    const missingCwd = join(dir, "missing-cwd");
    const result = await manager.startJob("echo never-runs", { cwd: missingCwd });

    expect(result).toMatchObject({ ok: false, exitCode: 127 });
    expect(result.output).toContain("Background command launch error [INVALID_CWD]");
    expect(result.output).toContain(`cwd=${JSON.stringify(missingCwd)}`);
    expect(result.output).toContain("The command did not start");
    expect(manager.getRecentJobs()).toHaveLength(0);
  });

  it("reports a public shell string that exits 127 immediately as failed", async () => {
    const { manager } = await fixture();
    const result = await manager.startJob("definitely-missing-clai-command");

    expect(result).toMatchObject({ ok: false, exitCode: 127 });
    expect(result.output).toContain("failed immediately");
    expect(result.output).toContain("do not retry unchanged");
    expect(result.backgroundJob).toMatchObject({ status: "failed", exitCode: 127 });
  });

  it("never claims a launched process did not start when final persistence fails", async () => {
    const { manager } = await fixture();
    const internal = manager as unknown as { persist: () => Promise<void> };
    const realPersist = internal.persist.bind(manager);
    let persistCalls = 0;
    internal.persist = async () => {
      persistCalls += 1;
      if (persistCalls === 2) throw new Error("simulated registry write failure");
      await realPersist();
    };

    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`;
    const result = await manager.startJob(command);
    internal.persist = realPersist;

    expect(result.ok).toBe(true);
    expect(result.output).toContain("launched as pid=");
    expect(result.output).toContain("simulated registry write failure");
    expect(result.output).toContain("do not launch a duplicate");
    expect(result.output).not.toContain("The command did not start");
    expect(result.backgroundJob).toMatchObject({ status: "running" });
    await manager.stopJob(result.backgroundJob!.id, { graceMs: 300 });
  });
});
