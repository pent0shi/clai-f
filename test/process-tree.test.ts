import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnCalls: Array<{ command: string; args: readonly string[] }> = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args?: readonly string[], ...rest: unknown[]) => {
      spawnCalls.push({ command, args: args ?? [] });
      return (actual.spawn as unknown as (...a: unknown[]) => unknown)(
        command,
        args as never,
        ...rest,
      );
    },
  };
});

const { terminateProcessTree, processAlive } = await import(
  "../src/os/process-tree.js"
);
const { JobManager } = await import("../src/tools/jobs.js");

const dirs: string[] = [];
const managers: InstanceType<typeof JobManager>[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  spawnCalls.length = 0;
  for (const manager of managers.splice(0)) {
    await manager.cancelAll("tree-session").catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("process tree termination", () => {
  it("uses taskkill /T on Windows instead of signalling one pid", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      spawnCalls.length = 0;
      const outcome = terminateProcessTree(process.pid, { signal: "SIGKILL" });
      expect(outcome).toBe("sent");
      const call = spawnCalls.find((entry) => entry.command === "taskkill");
      expect(call?.args).toEqual(["/PID", String(process.pid), "/T", "/F"]);
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });

  it("requests a graceful tree kill before forcing on Windows", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      spawnCalls.length = 0;
      terminateProcessTree(process.pid, { signal: "SIGTERM" });
      const call = spawnCalls.find((entry) => entry.command === "taskkill");
      expect(call?.args).toEqual(["/PID", String(process.pid), "/T"]);
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });

  it.skipIf(process.platform === "win32")(
    "kills grandchildren when a background job is stopped",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "clai-tree-"));
      dirs.push(dir);
      const manager = new JobManager(dir);
      managers.push(manager);

      const grandchild = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        "console.log('GRANDCHILD ' + process.pid); setInterval(() => {}, 1000)",
      )}`;
      const started = await manager.startJob(grandchild, {
        ownerSessionId: "tree-session",
      });
      const id = /id=([a-f0-9]+)/.exec(started.output)?.[1];
      expect(id).toBeTruthy();

      let grandchildPid: number | undefined;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && grandchildPid === undefined) {
        const tail = await manager.tailJob(id!, { stream: "stdout", bytes: 200 });
        const match = /GRANDCHILD (\d+)/.exec(tail.output);
        if (match) grandchildPid = Number(match[1]);
        else await sleep(40);
      }
      expect(grandchildPid).toBeTruthy();

      const stopped = await manager.stopJob(id!, { graceMs: 500 });
      expect(stopped.ok).toBe(true);

      const gone = Date.now() + 3_000;
      while (Date.now() < gone && processAlive(grandchildPid)) await sleep(40);
      expect(processAlive(grandchildPid)).toBe(false);
    },
  );
});
