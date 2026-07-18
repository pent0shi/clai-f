import { describe, expect, it } from "vitest";
import { LoopGuard } from "../src/agent/loop-guard.js";

describe("LoopGuard success cache", () => {
  it("stores and returns prior successful output for identical args", () => {
    const guard = new LoopGuard();
    const args = { path: "/tmp/blog" };
    guard.recordAttempt(1, "fs.list", args, true, 0, "file a\nfile b\n");
    expect(guard.hasSucceeded("fs.list", args)).toBe(true);
    expect(guard.getCachedSuccessOutput("fs.list", args)).toContain("file a");
    expect(guard.getCachedSuccessOutput("fs.list", { path: "/other" })).toBe(
      undefined,
    );
  });

  it("does not cache failed attempts as success", () => {
    const guard = new LoopGuard();
    const args = { command: "false" };
    guard.recordAttempt(1, "shell.exec", args, false, 1, "error");
    expect(guard.hasSucceeded("shell.exec", args)).toBe(false);
    expect(guard.getCachedSuccessOutput("shell.exec", args)).toBeUndefined();
  });
});
