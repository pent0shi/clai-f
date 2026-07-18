import { describe, expect, it } from "vitest";
import { LoopGuard } from "../src/agent/loop-guard.js";

describe("LoopGuard", () => {
  it("does not block the first call", () => {
    const guard = new LoopGuard();
    const result = guard.shouldBlock("shell.exec", { command: "whoami" });
    expect(result.block).toBe(false);
    expect(result.reason).toBe(undefined);
  });

  it("never warns or blocks successful identical re-calls", () => {
    const guard = new LoopGuard();
    guard.recordAttempt(0, "shell.exec", { command: "whoami" }, true);
    const once = guard.shouldBlock("shell.exec", { command: "whoami" });
    expect(once.block).toBe(false);
    expect(once.reason).toBeUndefined();

    guard.recordAttempt(1, "shell.exec", { command: "whoami" }, true);
    guard.recordAttempt(2, "shell.exec", { command: "whoami" }, true);
    const thrice = guard.shouldBlock("shell.exec", { command: "whoami" });
    expect(thrice.block).toBe(false);
    expect(thrice.reason).toBeUndefined();
  });

  it("never nags successful fs.list / tool.check repeats", () => {
    const guard = new LoopGuard();
    const args = { path: "/tmp/blog" };
    guard.recordAttempt(0, "fs.list", args, true, 0, "a\nb\n");
    for (let i = 0; i < 5; i++) {
      const r = guard.shouldBlock("fs.list", args);
      expect(r.block).toBe(false);
      expect(r.reason).toBeUndefined();
      guard.recordAttempt(i + 1, "fs.list", args, true, 0, "a\nb\n");
    }
  });

  it("treats whitespace-normalized commands as equivalent for failure tracking", () => {
    const guard = new LoopGuard();
    guard.recordAttempt(0, "shell.exec", { command: "  ls   -la  " }, false);
    const result = guard.shouldBlock("shell.exec", { command: "ls -la" });
    expect(result.block).toBe(true);
  });

  it("does not confuse different arguments", () => {
    const guard = new LoopGuard();
    guard.recordAttempt(0, "shell.exec", { command: "whoami" }, false);
    const result = guard.shouldBlock("shell.exec", { command: "hostname" });
    expect(result.block).toBe(false);
  });

  it("tracks attempt count correctly", () => {
    const guard = new LoopGuard();
    expect(guard.getAttemptCount("shell.exec", { command: "ls" })).toBe(0);
    guard.recordAttempt(0, "shell.exec", { command: "ls" }, true);
    expect(guard.getAttemptCount("shell.exec", { command: "ls" })).toBe(1);
    guard.recordAttempt(1, "shell.exec", { command: "ls" }, true);
    expect(guard.getAttemptCount("shell.exec", { command: "ls" })).toBe(2);
  });

  it("detects repeated failures", () => {
    const guard = new LoopGuard();
    guard.recordAttempt(0, "shell.exec", { command: "foo" }, false);
    guard.recordAttempt(1, "shell.exec", { command: "bar" }, false);
    guard.recordAttempt(2, "shell.exec", { command: "baz" }, false);
    expect(guard.hasRepeatedFailures(3)).toBe(true);
    expect(guard.hasRepeatedFailures(4)).toBe(false);
  });

  it("sorts args keys for consistent canonicalization", () => {
    const guard = new LoopGuard();
    const sig1 = guard.canonicalize("test", { b: 2, a: 1 });
    const sig2 = guard.canonicalize("test", { a: 1, b: 2 });
    expect(sig1).toBe(sig2);
  });

  it("blocks identical failed mutates without structured retry context", () => {
    const guard = new LoopGuard();
    const args = { path: "src/App.jsx", content: "x" };
    guard.recordAttempt(0, "fs.write", args, false);
    expect(guard.shouldBlock("fs.write", args).block).toBe(true);
    expect(
      guard.shouldBlock("fs.write", args, {
        dependenciesChanged: true,
      }).block,
    ).toBe(false);
  });

  it("does not block or warn for task.update or plan.create", () => {
    const guard = new LoopGuard();
    const args = { taskId: "1", state: "in_progress" };
    guard.recordAttempt(0, "task.update", args, true);
    guard.recordAttempt(1, "task.update", args, true);
    guard.recordAttempt(2, "task.update", args, true);
    const result = guard.shouldBlock("task.update", args);
    expect(result.block).toBe(false);
    expect(result.reason).toBeUndefined();

    const planArgs = { tasks: [] };
    guard.recordAttempt(0, "plan.create", planArgs, true);
    guard.recordAttempt(1, "plan.create", planArgs, true);
    const planResult = guard.shouldBlock("plan.create", planArgs);
    expect(planResult.block).toBe(false);
    expect(planResult.reason).toBeUndefined();
  });

  it("allows one fs.list retry after successful scaffold work", () => {
    const guard = new LoopGuard();
    const listArgs = { path: "/Users/me/Desktop/blogging-app" };
    guard.recordAttempt(0, "fs.list", listArgs, false);
    expect(guard.shouldBlock("fs.list", listArgs).block).toBe(true);
    guard.recordAttempt(
      1,
      "shell.exec",
      {
        command:
          'mkdir -p "/Users/me/Desktop/blogging-app" && npm create vite@latest .',
      },
      true,
    );
    const retry = guard.shouldBlock("fs.list", listArgs);
    expect(retry.block).toBe(false);
  });
});
