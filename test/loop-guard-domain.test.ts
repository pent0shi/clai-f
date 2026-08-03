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

  it("graduated sequence guard: no suppress below warn threshold", () => {
    const guard = new LoopGuard();
    const seq = [{ name: "shell.exec", args: { command: "node police-test.mjs" } }];

    for (let i = 0; i < 4; i++) {
      const d = guard.observeActionSequence(seq);
      expect(d.suppress).toBe(false);
      expect(d.warn).toBe(false);
      guard.completeActionSequence(seq, true);
    }
  });

  it("graduated sequence guard: warns at threshold, blocks at hard limit", () => {
    const guard = new LoopGuard();
    const seq = [{ name: "shell.exec", args: { command: "node police-test.mjs" } }];

    for (let i = 0; i < 5; i++) {
      guard.observeActionSequence(seq);
      guard.completeActionSequence(seq, true);
    }
    const warn = guard.observeActionSequence(seq);
    expect(warn.suppress).toBe(false);
    expect(warn.warn).toBe(true);
    guard.completeActionSequence(seq, true);

    for (let i = 6; i < 10; i++) {
      guard.observeActionSequence(seq);
      guard.completeActionSequence(seq, true);
    }
    const block = guard.observeActionSequence(seq);
    expect(block.suppress).toBe(true);
  });

  it("resetAllSequenceCounts unblocks after hard limit", () => {
    const guard = new LoopGuard();
    const seq = [{ name: "shell.exec", args: { command: "node police-test.mjs" } }];
    for (let i = 0; i < 10; i++) {
      guard.observeActionSequence(seq);
      guard.completeActionSequence(seq, true);
    }
    expect(guard.observeActionSequence(seq).suppress).toBe(true);
    guard.resetAllSequenceCounts();
    expect(guard.observeActionSequence(seq).suppress).toBe(false);
  });
});
