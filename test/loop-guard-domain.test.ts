import { describe, expect, it } from "vitest";
import { LoopGuard, type RetryContext } from "../src/agent/loop-guard.js";

describe("loop guard semantics", () => {
  it("blocks an unchanged failed retry immediately", () => {
    const guard = new LoopGuard();
    guard.recordAttempt(0, "shell.exec", { command: "missing" }, false, 127);
    expect(guard.shouldBlock("shell.exec", { command: "missing" })).toMatchObject({ block: true });
  });

  it.each<RetryContext>([
    { dependenciesChanged: true },
    { environmentChanged: true },
    { retryReason: { code: "TRANSIENT_LOCK", detail: "the lock holder has exited" } },
  ])("allows failed retry with changed context or structured rationale: %j", (context) => {
    const guard = new LoopGuard();
    guard.recordAttempt(0, "shell.exec", { command: "build" }, false);
    expect(guard.shouldBlock("shell.exec", { command: "build" }, context).block).toBe(false);
  });

  it("rejects an empty structured rationale", () => {
    const guard = new LoopGuard();
    guard.recordAttempt(0, "shell.exec", { command: "build" }, false);
    expect(guard.shouldBlock("shell.exec", { command: "build" }, { retryReason: { code: "", detail: "" } }).block).toBe(true);
  });

  it("canonicalizes command whitespace and never blocks successful re-reads", () => {
    const guard = new LoopGuard();
    guard.recordAttempt(1, "fs.read", { path: "a" }, true);
    guard.recordAttempt(2, "fs.read", { path: "a" }, true);
    guard.recordAttempt(3, "fs.read", { path: "a" }, true);
    const decision = guard.shouldBlock("fs.read", { path: "a" });
    expect(decision.block).toBe(false);
    expect(decision.reason).toBeUndefined();

    guard.recordAttempt(4, "shell.exec", { command: " npm   test " }, true);
    expect(guard.getAttemptCount("shell.exec", { command: "npm test" })).toBe(1);
  });
});
