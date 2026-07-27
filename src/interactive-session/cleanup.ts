/**
 * Identity-safe, single-winner teardown.
 *
 * Every termination trigger — explicit close, process exit, owner cancellation,
 * idle/lifetime timeout, conversation teardown, application shutdown — funnels
 * through `FinalizeOnce`, so exactly one execution owns the terminal transition
 * and repeated Close returns the recorded result without signalling again.
 */

import {
  processIdentityTracker,
  type ProcessIdentityComparison,
} from "../os/process-identity.js";
import { hasLiveDescendants, processAlive } from "../os/process-tree.js";
import type { RecoveryJournal } from "./recovery-journal.js";
import type { SessionRegistry } from "./registry.js";
import type { SessionRuntime } from "./session-runtime.js";
import {
  artifactReference,
  isTerminalState,
  sessionError,
  type CloseResult,
  type SessionState,
  type StableError,
  type TerminationReason,
} from "./types.js";

const POLL_INTERVAL_MS = 50;

export interface CleanupDeps {
  readonly registry: SessionRegistry;
  readonly journal: RecoveryJournal;
  readonly onFinalized?: ((runtime: SessionRuntime) => void) | undefined;
  readonly process?: Partial<CleanupProcessDeps> | undefined;
}

export interface CleanupProcessDeps {
  readonly isAlive: (pid: number | undefined) => boolean;
  readonly compareIdentity: (
    pid: number | undefined,
    identity: string | undefined,
  ) => ProcessIdentityComparison;
  readonly hasLiveDescendants: (pid: number) => Promise<boolean>;
}

const defaultProcessDeps: CleanupProcessDeps = {
  isAlive: processAlive,
  compareIdentity: (pid, identity) => processIdentityTracker.compare(pid, identity),
  hasLiveDescendants,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Terminal state chosen by the cleanup owner from its winning reason. */
function terminalStateFor(
  reason: TerminationReason,
  processExited: boolean,
  cleanupFailed: boolean,
): SessionState {
  if (cleanupFailed) return "failed";
  if (reason === "process-exit" || processExited) return "exited";
  if (reason === "launch-failure") return "failed";
  return "closed";
}

export class CleanupCoordinator {
  private readonly process: CleanupProcessDeps;

  constructor(private readonly deps: CleanupDeps) {
    this.process = { ...defaultProcessDeps, ...deps.process };
  }

  /** Idempotent: later callers join the first execution's promise. */
  close(
    runtime: SessionRuntime,
    reason: TerminationReason,
    deadlineMs: number,
  ): Promise<CloseResult> {
    if (isTerminalState(runtime.record.state) && runtime.finalize.started) {
      return runtime.finalize.join()!;
    }
    return runtime.finalize.run(reason, () => this.execute(runtime, reason, deadlineMs));
  }

  private async execute(
    runtime: SessionRuntime,
    reason: TerminationReason,
    deadlineMs: number,
  ): Promise<CloseResult> {
    const record = runtime.record;
    const started = Date.now();
    const remaining = (): number => Math.max(0, deadlineMs - (Date.now() - started));

    // Commit `closing` before any termination action so later input is rejected.
    this.deps.registry.transition(record, "closing", { terminationReason: reason });

    runtime.input.rejectAll({ status: "not-delivered", deliveredBytes: 0 });

    let error: StableError | undefined;
    let cleanupVerified = true;

    if (!runtime.processExited && this.process.isAlive(runtime.transport.pid)) {
      const identity = this.process.compareIdentity(
        runtime.transport.pid,
        runtime.transport.identity,
      );
      if (identity === "match") {
        await runtime.transport.requestTreeTermination("graceful");
        const graceMs = Math.min(runtime.config.gracefulCloseMs, remaining());
        await this.waitForExit(runtime, graceMs);
        if (!runtime.processExited && this.process.isAlive(runtime.transport.pid)) {
          await runtime.transport.requestTreeTermination("forceful");
          await this.waitForExit(runtime, remaining());
        }
      } else if (identity === "unknown") {
        // Ownership is unproven, so signalling could hit a recycled pid.
        cleanupVerified = false;
      }
      // `mismatch` and `gone` mean this pid is no longer ours: nothing to signal.
    }

    await this.waitForOutputDrain(runtime, remaining());

    // Final captured output must reach the store before resources close.
    runtime.output.finish();
    runtime.syncCursors();
    try {
      await runtime.artifact.close();
    } catch {
      error ??= sessionError({
        code: "PERSIST_FAILED",
        operation: "close",
        sessionId: record.id,
        message: "Session output artifact could not be flushed during cleanup.",
        details: { artifactPath: runtime.artifact.path },
      });
    }

    const survivors = await this.verifyAbsence(runtime, remaining());
    if (survivors) {
      cleanupVerified = false;
      error ??= sessionError({
        code: "CLEANUP_FAILED",
        operation: "close",
        sessionId: record.id,
        message:
          "A descendant of this interactive session was still alive after the close deadline.",
        details: { survivingDescendants: 1, elapsedMs: Date.now() - started },
      });
    }

    runtime.timers.clearAll();
    runtime.releaseListeners();
    await runtime.transport.dispose();
    runtime.output.dispose();
    runtime.disposed = true;
    this.deps.journal.remove(record.id);

    record.artifact = runtime.artifact.receipt();
    const state = terminalStateFor(reason, runtime.processExited, error !== undefined);
    this.deps.registry.transition(record, state, {
      terminationReason: reason,
      ...(record.processOutcome ? { processOutcome: record.processOutcome } : {}),
      cleanupVerified,
      now: Date.now(),
    });
    this.deps.onFinalized?.(runtime);

    return {
      operation: "close",
      sessionId: record.id,
      state: record.state,
      ...(record.terminationReason ? { terminationReason: record.terminationReason } : {}),
      ...(record.processOutcome ? { processOutcome: record.processOutcome } : {}),
      cleanupVerified,
      artifact: artifactReference(record.artifact),
      ...(error ? { error } : {}),
    };
  }

  private async waitForOutputDrain(runtime: SessionRuntime, budgetMs: number): Promise<void> {
    const wait = runtime.transport.waitForOutputDrain;
    if (!wait || budgetMs <= 0) return;
    await Promise.race([wait.call(runtime.transport), delay(budgetMs)]).catch(() => undefined);
  }

  private async waitForExit(runtime: SessionRuntime, budgetMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, budgetMs);
    while (Date.now() < deadline) {
      if (runtime.processExited || !this.process.isAlive(runtime.transport.pid)) return;
      await delay(POLL_INTERVAL_MS);
    }
  }

  /** True when a verified descendant or the root is still alive. */
  private async verifyAbsence(
    runtime: SessionRuntime,
    budgetMs: number,
  ): Promise<boolean> {
    const pid = runtime.transport.pid;
    if (pid <= 0) return false;
    if (this.process.isAlive(pid)) {
      const identity = this.process.compareIdentity(pid, runtime.transport.identity);
      // A mismatch means the pid was recycled: our process is gone.
      if (identity === "match") return true;
    }
    if (budgetMs <= 0) return false;
    return await this.process.hasLiveDescendants(pid);
  }
}
