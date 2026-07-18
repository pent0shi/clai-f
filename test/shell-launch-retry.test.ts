import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const spawnState = vi.hoisted(() => ({ calls: 0 }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      spawnState.calls += 1;
      if (spawnState.calls === 1) {
        const child = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          stderr: EventEmitter;
          pid?: number;
          kill: () => boolean;
        };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => false;
        queueMicrotask(() => {
          const error = Object.assign(
            new Error("spawn /bin/sh ENOENT"),
            {
              code: "ENOENT",
              syscall: "posix_spawn",
              path: "/bin/sh",
            },
          );
          child.emit("error", error);
        });
        return child;
      }
      return (actual.spawn as (...spawnArgs: unknown[]) => unknown)(...args);
    },
  };
});

import { shellExec } from "../src/tools/shell.js";

describe("shellExec transient launch recovery", () => {
  it("retries exactly once when ENOENT occurs before an existing shell starts", async () => {
    const result = await shellExec({
      command: "printf recovered",
      noArtifact: true,
      timeoutMs: 5_000,
    });

    expect(spawnState.calls).toBe(2);
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect(result.output).toContain(
      "Recovered automatically from one transient command-launch ENOENT.",
    );
    expect(result.output).toContain("recovered");
  });
});
