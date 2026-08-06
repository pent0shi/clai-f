import { describe, expect, it } from "vitest";
import { LoopGuard, type RetryContext } from "../src/agent/loop-guard.js";

describe("loop guard semantics", () => {
  it("allows one unchanged failed retry before blocking the same failure", () => {
    const guard = new LoopGuard();
    const args = { command: "missing" };
    guard.recordAttempt(0, "shell.exec", args, false, 127, "missing");
    expect(guard.shouldBlock("shell.exec", args).block).toBe(false);
    guard.recordAttempt(1, "shell.exec", args, false, 127, "missing");
    expect(guard.shouldBlock("shell.exec", args)).toMatchObject({ block: true });
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

  it("rejects an empty structured rationale after the same failure repeats", () => {
    const guard = new LoopGuard();
    const args = { command: "build" };
    guard.recordAttempt(0, "shell.exec", args, false, 1, "failed");
    guard.recordAttempt(1, "shell.exec", args, false, 1, "failed");
    expect(guard.shouldBlock("shell.exec", args, { retryReason: { code: "", detail: "" } }).block).toBe(true);
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

  it("warns before suppressing a fourth unchanged observable replay", () => {
    const guard = new LoopGuard();
    const seq = [{ name: "shell.exec", args: { command: "node police-test.mjs" } }];

    expect(guard.observeActionSequence(seq).suppress).toBe(false);
    guard.completeActionSequence(seq, true, "same");
    expect(guard.observeActionSequence(seq).suppress).toBe(false);
    guard.completeActionSequence(seq, true, "same");
    expect(guard.observeActionSequence(seq)).toMatchObject({
      suppress: false,
      warn: true,
    });
    guard.completeActionSequence(seq, true, "same");
    expect(guard.observeActionSequence(seq)).toMatchObject({
      suppress: true,
      terminal: false,
    });
  });

  it("escalates only when the model ignores repeated suppression evidence", () => {
    const guard = new LoopGuard();
    const seq = [{ name: "shell.exec", args: { command: "node police-test.mjs" } }];

    guard.observeActionSequence(seq);
    guard.completeActionSequence(seq, true, "same");
    expect(guard.observeActionSequence(seq).suppress).toBe(false);
    guard.completeActionSequence(seq, true, "same");
    expect(guard.observeActionSequence(seq).warn).toBe(true);
    guard.completeActionSequence(seq, true, "same");
    expect(guard.observeActionSequence(seq).terminal).toBe(false);
    expect(guard.observeActionSequence(seq).terminal).toBe(false);
    expect(guard.observeActionSequence(seq)).toMatchObject({
      suppress: true,
      terminal: true,
    });
  });

  it("resetAllSequenceCounts unblocks after suppression", () => {
    const guard = new LoopGuard();
    const seq = [{ name: "shell.exec", args: { command: "node police-test.mjs" } }];
    guard.observeActionSequence(seq);
    guard.completeActionSequence(seq, true, "same");
    expect(guard.observeActionSequence(seq).suppress).toBe(false);
    guard.completeActionSequence(seq, true, "same");
    expect(guard.observeActionSequence(seq).warn).toBe(true);
    guard.completeActionSequence(seq, true, "same");
    expect(guard.observeActionSequence(seq).suppress).toBe(true);
    guard.resetAllSequenceCounts();
    expect(guard.observeActionSequence(seq).suppress).toBe(false);
  });
});
