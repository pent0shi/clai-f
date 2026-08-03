import { describe, expect, it } from "vitest";
import { LoopGuard } from "../src/agent/loop-guard.js";
import { completedOperationSignature } from "../src/agent/outcomes.js";

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

  it("blocks an unchanged successful call that produced no observation", () => {
    const guard = new LoopGuard();
    const args = { command: "true" };
    guard.recordAttempt(0, "shell.exec", args, true, 0, "");

    expect(guard.shouldBlock("shell.exec", args)).toMatchObject({
      block: true,
      kind: "unchanged-success",
      reason: expect.stringMatching(/empty result/i),
    });
  });

  it("allows an empty-result retry after a distinct successful action or one new reason", () => {
    const args = { command: "true" };
    const afterProgress = new LoopGuard();
    afterProgress.recordAttempt(0, "shell.exec", args, true, 0, "");
    afterProgress.recordAttempt(1, "shell.exec", { command: "printf ready" }, true, 0, "ready");
    expect(afterProgress.shouldBlock("shell.exec", args).block).toBe(false);

    const withReason = new LoopGuard();
    withReason.recordAttempt(0, "shell.exec", args, true, 0, "");
    const retry = {
      retryReason: { code: "service-ready", detail: "the dependency is now running" },
    };
    expect(withReason.shouldBlock("shell.exec", args, retry).block).toBe(false);
    expect(withReason.shouldBlock("shell.exec", args, retry).block).toBe(true);
  });

  it("suppresses an unchanged successful read without affecting mutations", () => {
    const guard = new LoopGuard();
    const args = { path: "/tmp/blog" };
    guard.recordAttempt(0, "fs.list", args, true, 0, "a\nb\n");

    expect(guard.shouldBlock("fs.list", args)).toMatchObject({
      block: true,
      kind: "unchanged-success",
    });
    expect(guard.shouldBlock("fs.write", { path: "/tmp/blog/c", content: "c" }).block).toBe(false);
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

  it("blocks a failed read-only probe restored after interruption", () => {
    const guard = new LoopGuard();
    const args = {
      command:
        'curl -s -o /dev/null -w "%{http_code}" "https://images.picsum.photos/id/866/800/400" 2>&1',
    };
    const signature = completedOperationSignature("shell.exec", args);
    expect(signature).toBeDefined();
    guard.restoreCompletedOperations([
      {
        signature: signature!,
        tool: "shell.exec",
        summary: "failed curl probe",
        observation: "000",
        ok: false,
        exitCode: 6,
        observedAt: new Date().toISOString(),
      },
    ]);

    expect(guard.shouldBlock("shell.exec", args)).toMatchObject({
      block: true,
      kind: "failed-retry",
    });
    expect(
      guard.shouldBlock("shell.exec", args, {
        retryReason: { code: "dns-fixed", detail: "resolver changed" },
      }).block,
    ).toBe(false);
    expect(
      guard.shouldBlock("shell.exec", args, {
        retryReason: { code: "dns-fixed", detail: "resolver changed" },
      }).block,
    ).toBe(true);
    expect(
      guard.shouldBlock("shell.exec", {
        command:
          'curl -sS -L -o /dev/null -w "%{http_code}" "https://picsum.photos/id/866/800/400"',
      }).block,
    ).toBe(false);
  });

  it("allows repeated sequences up to warn threshold without suppression", () => {
    const guard = new LoopGuard();
    const seq = [{ name: "shell.exec", args: { command: "node test.mjs" } }];

    for (let i = 0; i < 4; i++) {
      const decision = guard.observeActionSequence(seq);
      expect(decision.suppress).toBe(false);
      expect(decision.warn).toBe(false);
      guard.completeActionSequence(seq, true);
    }
  });

  it("warns at 5th repetition but does not suppress", () => {
    const guard = new LoopGuard();
    const seq = [{ name: "shell.exec", args: { command: "node test.mjs" } }];

    for (let i = 0; i < 5; i++) {
      guard.observeActionSequence(seq);
      guard.completeActionSequence(seq, true);
    }

    const decision = guard.observeActionSequence(seq);
    expect(decision.suppress).toBe(false);
    expect(decision.warn).toBe(true);
    expect(decision.warnMessage).toMatch(/loop\.reset/);
  });

  it("blocks at 10th repetition", () => {
    const guard = new LoopGuard();
    const seq = [{ name: "shell.exec", args: { command: "node test.mjs" } }];

    for (let i = 0; i < 10; i++) {
      guard.observeActionSequence(seq);
      guard.completeActionSequence(seq, true);
    }

    const decision = guard.observeActionSequence(seq);
    expect(decision.suppress).toBe(true);
  });

  it("resetAllSequenceCounts allows commands to run again after block threshold", () => {
    const guard = new LoopGuard();
    const seq = [{ name: "shell.exec", args: { command: "node test.mjs" } }];

    for (let i = 0; i < 10; i++) {
      guard.observeActionSequence(seq);
      guard.completeActionSequence(seq, true);
    }

    expect(guard.observeActionSequence(seq).suppress).toBe(true);
    guard.resetAllSequenceCounts();
    const after = guard.observeActionSequence(seq);
    expect(after.suppress).toBe(false);
    expect(after.warn).toBe(false);
  });

  it("does not suppress oscillation (A→B→A) below warn threshold", () => {
    const guard = new LoopGuard();
    const seqA = [{ name: "fs.read", args: { path: "a" } }];
    const seqB = [{ name: "fs.read", args: { path: "b" } }];

    guard.observeActionSequence(seqA);
    guard.completeActionSequence(seqA, true);
    guard.observeActionSequence(seqB);
    guard.completeActionSequence(seqB, true);

    const backToA = guard.observeActionSequence(seqA);
    expect(backToA.suppress).toBe(false);
    expect(backToA.warn).toBe(false);
  });

  it("warns on oscillation at warn threshold", () => {
    const guard = new LoopGuard();
    const seqA = [{ name: "fs.read", args: { path: "a" } }];
    const seqB = [{ name: "fs.read", args: { path: "b" } }];

    for (let i = 0; i < 5; i++) {
      guard.observeActionSequence(seqA);
      guard.completeActionSequence(seqA, true);
      guard.observeActionSequence(seqB);
      guard.completeActionSequence(seqB, true);
    }

    const decision = guard.observeActionSequence(seqA);
    expect(decision.suppress).toBe(false);
    expect(decision.warn).toBe(true);
    expect(decision.oscillation).toBe(true);
  });

  it("does not suppress a genuinely new sequence", () => {
    const guard = new LoopGuard();
    const seqA = [{ name: "fs.read", args: { path: "a" } }];
    const seqC = [{ name: "fs.read", args: { path: "c" } }];

    guard.observeActionSequence(seqA);
    guard.completeActionSequence(seqA, true);

    const fresh = guard.observeActionSequence(seqC);
    expect(fresh.suppress).toBe(false);
    expect(fresh.oscillation).toBe(false);
    expect(fresh.warn).toBe(false);
  });

  it("getSequenceRunCount tracks completed eligible sequences", () => {
    const guard = new LoopGuard();
    const seq = [{ name: "shell.exec", args: { command: "npm test" } }];

    expect(guard.getSequenceRunCount(seq)).toBe(0);
    guard.observeActionSequence(seq);
    guard.completeActionSequence(seq, true);
    expect(guard.getSequenceRunCount(seq)).toBe(1);
    guard.observeActionSequence(seq);
    guard.completeActionSequence(seq, true);
    expect(guard.getSequenceRunCount(seq)).toBe(2);
  });

  it("resetSequenceCount clears count for a specific sequence", () => {
    const guard = new LoopGuard();
    const seq = [{ name: "shell.exec", args: { command: "npm test" } }];

    for (let i = 0; i < 6; i++) {
      guard.observeActionSequence(seq);
      guard.completeActionSequence(seq, true);
    }
    expect(guard.getSequenceRunCount(seq)).toBe(6);
    expect(guard.observeActionSequence(seq).warn).toBe(true);

    guard.resetSequenceCount(seq);
    expect(guard.getSequenceRunCount(seq)).toBe(0);
    const after = guard.observeActionSequence(seq);
    expect(after.warn).toBe(false);
    expect(after.suppress).toBe(false);
  });
});
