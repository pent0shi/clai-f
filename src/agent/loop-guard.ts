import type { ToolCall } from "../types.js";
import { slimToolArgs } from "./message-slim.js";
import {
  completedOperationObservationDigest,
  completedOperationSignature,
  type CompletedOperation,
} from "./outcomes.js";

export interface ToolAttempt {
  step: number;
  callName: string;
  canonicalSignature: string;
  ok: boolean;
  exitCode?: number | undefined;
}

/** Bound attempt history so long thrash turns cannot retain thousands of sigs. */
const MAX_ATTEMPT_HISTORY = 400;

/**
 * Non-mutating tools that may legitimately need re-calling after context
 * compaction removes their earlier results.
 */
const READ_ONLY_TOOLS = new Set([
  "web.fetch",
  "http.fetch",
  "web.search",
  "dns.lookup",
  "whois.lookup",
  "fs.read",
  "fs.list",
  "fs.search",
  "sysinfo",
  "net.context",
  "tool.check",
  "wordlist.find",
  "image.ocr",
  "pdf.read",
]);

/**
 * Track tool attempts for failure reflection. Successful re-calls are always
 * allowed (no "already succeeded / use prior results" nagging — that caused
 * model thrash and false "tool failed" behavior).
 */
export interface LoopGuardOptions {
  /** @deprecated Retry authorization belongs in RetryContext passed to shouldBlock. */
  allowUnlimitedFailedRetries?: boolean;
  /** @deprecated Unchanged failed retries are blocked immediately. */
  failedRetryLimit?: number;
}

export interface RetryContext {
  /** A dependency changed since the failed attempt. */
  dependenciesChanged?: boolean;
  /** The execution environment changed since the failed attempt. */
  environmentChanged?: boolean;
  /** Stable live state for status probes, excluding elapsed time. */
  stateKey?: string | undefined;
  /** Structured justification for retrying without an external change. */
  retryReason?: {
    code: string;
    detail: string;
  };
}

export interface LoopDecision {
  block: boolean;
  kind?: "failed-retry" | "unchanged-success" | undefined;
  reason?: string | undefined;
}

export class LoopGuard {
  private attempts: ToolAttempt[] = [];
  private signatureCount = new Map<string, number>();
  private signatureSuccess = new Map<string, boolean>();
  /** Failed read-only signatures that already used their one free env-change retry. */
  private failedReadRetryUsed = new Set<string>();
  private successfulProbes = new Map<
    string,
    {
      digest: string;
      unchangedRepeats: number;
      stateKey?: string | undefined;
      compareAfterRestore: boolean;
      retryReason?: string | undefined;
    }
  >();
  private failedProbes = new Map<
    string,
    { stateKey?: string | undefined; retryReason?: string | undefined }
  >();
  private lastSuccessfulNonMetaStep = -1;

  constructor(_options: LoopGuardOptions = {}) {}

  restoreCompletedOperations(operations: readonly CompletedOperation[]): void {
    for (const operation of operations) {
      if (operation.ok === false) {
        this.failedProbes.set(operation.signature, {
          ...(operation.stateKey ? { stateKey: operation.stateKey } : {}),
        });
        continue;
      }
      if (!operation.observationDigest) continue;
      this.successfulProbes.set(operation.signature, {
        digest: operation.observationDigest,
        unchangedRepeats: operation.unchangedRepeats ?? 0,
        ...(operation.stateKey ? { stateKey: operation.stateKey } : {}),
        compareAfterRestore: true,
      });
    }
  }

  /**
   * Produce a canonical string for a (name, args) pair so that calls
   * with identical semantics match even if arg order differs or
   * command whitespace varies.
   *
   * Large string values (file contents) are fingerprinted — never kept
   * verbatim — so writeMany scaffolds cannot pin multi-MB strings in Maps.
   */
  canonicalize(name: string, args: Record<string, unknown>): string {
    const slimmed = slimToolArgs(args);
    // Normalize shell command whitespace after slim (commands stay full when short).
    if (
      (name === "shell.exec" || name === "shell.start") &&
      typeof slimmed.command === "string"
    ) {
      slimmed.command = slimmed.command.trim().replace(/\s+/g, " ");
    }
    return `${name}::${JSON.stringify(slimmed)}`;
  }

  recordAttempt(
    step: number,
    name: string,
    args: Record<string, unknown>,
    ok: boolean,
    exitCode?: number | undefined,
    output?: string | undefined,
    context?: RetryContext | undefined,
  ): void {
    const sig = this.canonicalize(name, args);
    this.attempts.push({
      step,
      callName: name,
      canonicalSignature: sig,
      ok,
      exitCode,
    });
    if (this.attempts.length > MAX_ATTEMPT_HISTORY) {
      this.attempts.splice(0, this.attempts.length - MAX_ATTEMPT_HISTORY);
    }
    this.signatureCount.set(sig, (this.signatureCount.get(sig) ?? 0) + 1);
    if (ok) {
      this.signatureSuccess.set(sig, true);
      if (name !== "task.update" && name !== "plan.create") {
        this.lastSuccessfulNonMetaStep = step;
      }
    } else {
      if (!this.signatureSuccess.has(sig)) this.signatureSuccess.set(sig, false);
    }

    const probeSignature = completedOperationSignature(name, args);
    if (ok && output !== undefined && probeSignature) {
      const digest = completedOperationObservationDigest(name, output);
      const prior = this.successfulProbes.get(probeSignature);
      const unchanged =
        prior?.digest === digest && prior.stateKey === context?.stateKey;
      this.successfulProbes.set(probeSignature, {
        digest,
        unchangedRepeats: unchanged ? (prior?.unchangedRepeats ?? 0) + 1 : 0,
        ...(context?.stateKey ? { stateKey: context.stateKey } : {}),
        compareAfterRestore: false,
        ...(prior?.retryReason ? { retryReason: prior.retryReason } : {}),
      });
    }

    if (probeSignature) {
      if (ok) {
        this.failedProbes.delete(probeSignature);
      } else {
        const priorFailure = this.failedProbes.get(probeSignature);
        this.failedProbes.set(probeSignature, {
          ...(context?.stateKey ? { stateKey: context.stateKey } : {}),
          ...(priorFailure?.retryReason
            ? { retryReason: priorFailure.retryReason }
            : {}),
        });
      }
    }

    if (ok && this.isPathMutatingTool(name)) {
      this.successfulProbes.clear();
      this.invalidateReadsAfterSuccess(name, args);
    }
  }

  private isPathMutatingTool(name: string): boolean {
    return (
      name === "fs.write" ||
      name === "fs.writeMany" ||
      name === "fs.edit" ||
      name === "fs.replaceLines" ||
      name === "fs.append" ||
      name === "fs.delete" ||
      name === "shell.exec" ||
      name === "shell.start"
    );
  }

  /** Drop list/read signatures that touch paths a successful tool may have created. */
  private invalidateReadsAfterSuccess(
    name: string,
    args: Record<string, unknown>,
  ): void {
    const paths: string[] = [];
    if (typeof args.path === "string") paths.push(args.path);
    if (name === "fs.writeMany" && Array.isArray(args.files)) {
      for (const f of args.files) {
        if (
          f &&
          typeof f === "object" &&
          typeof (f as { path?: string }).path === "string"
        ) {
          paths.push((f as { path: string }).path);
        }
      }
    }
    if (
      (name === "shell.exec" || name === "shell.start") &&
      typeof args.command === "string"
    ) {
      const cmd = args.command;
      for (const m of cmd.matchAll(
        /(?:mkdir\s+(?:-p\s+)?|cd\s+|create-[\w@./-]+\s+|vite@\S+\s+)(['"]?)([^\s;'"]+)\1/gi,
      )) {
        if (m[2] && m[2] !== ".") paths.push(m[2]);
      }
      if (typeof args.cwd === "string") paths.push(args.cwd);
    }
    if (paths.length === 0) return;
    for (const sig of [...this.signatureCount.keys()]) {
      if (!sig.startsWith("fs.read::") && !sig.startsWith("fs.list::")) continue;
      if (paths.some((p) => p.length > 1 && sig.includes(p))) {
        this.signatureCount.delete(sig);
        this.signatureSuccess.delete(sig);
        this.failedReadRetryUsed.delete(sig);
      }
    }
  }

  /**
   * Only blocks *failed* identical re-tries without changed context.
   * Successful re-calls always pass through with no warning — no
   * "already succeeded / use prior results" messaging.
   */
  shouldBlock(
    name: string,
    args: Record<string, unknown>,
    retryContext?: RetryContext,
  ): LoopDecision {
    if (name === "task.update" || name === "plan.create") {
      return { block: false };
    }

    const probeSignature = completedOperationSignature(name, args);
    const probe = probeSignature
      ? this.successfulProbes.get(probeSignature)
      : undefined;
    if (probe) {
      if (probe.compareAfterRestore) {
        probe.compareAfterRestore = false;
        return { block: false };
      }
      if (
        retryContext?.stateKey !== undefined &&
        retryContext.stateKey !== probe.stateKey
      ) {
        return { block: false };
      }
      const retryReason = retryContext?.retryReason;
      const reasonKey =
        retryReason?.code.trim() && retryReason.detail.trim()
          ? `${retryReason.code.trim()}\0${retryReason.detail.trim()}`
          : undefined;
      if (reasonKey && reasonKey !== probe.retryReason) {
        probe.retryReason = reasonKey;
        return { block: false };
      }
      return {
        block: true,
        kind: "unchanged-success",
        reason:
          `${name} already completed with identical arguments and no observed state change. ` +
          "Reuse the prior observation; choose a different action unless the job state, arguments, or retry reason changes.",
      };
    }

    const sig = this.canonicalize(name, args);
    const restoredFailure = probeSignature
      ? this.failedProbes.get(probeSignature)
      : undefined;
    if (restoredFailure) {
      if (
        retryContext?.dependenciesChanged === true ||
        retryContext?.environmentChanged === true ||
        (retryContext?.stateKey !== undefined &&
          retryContext.stateKey !== restoredFailure.stateKey)
      ) {
        return { block: false };
      }
      if (READ_ONLY_TOOLS.has(name) && !this.failedReadRetryUsed.has(sig)) {
        const lastFailStep = [...this.attempts]
          .reverse()
          .find((attempt) => attempt.canonicalSignature === sig && !attempt.ok)?.step;
        if (
          lastFailStep !== undefined &&
          this.lastSuccessfulNonMetaStep > lastFailStep
        ) {
          this.failedReadRetryUsed.add(sig);
          return { block: false };
        }
      }
      const retryReason = retryContext?.retryReason;
      const reasonKey =
        retryReason?.code.trim() && retryReason.detail.trim()
          ? `${retryReason.code.trim()}\0${retryReason.detail.trim()}`
          : undefined;
      if (reasonKey && reasonKey !== restoredFailure.retryReason) {
        restoredFailure.retryReason = reasonKey;
        return { block: false };
      }
      return {
        block: true,
        kind: "failed-retry",
        reason:
          `${name} previously failed with identical arguments, including in an interrupted turn. ` +
          "Change the command/args, fix the environment, or provide one new structured retry reason.",
      };
    }

    const count = this.signatureCount.get(sig) ?? 0;
    if (count === 0) return { block: false };

    // Prior success (or never failed): always allow free re-execution.
    if (this.signatureSuccess.get(sig) !== false) {
      return { block: false };
    }

    // Previously-failed signature: allow structured retry, or one free retry
    // for read-only tools after environment-changing successful work.
    const structuredReason = retryContext?.retryReason;
    const authorized =
      retryContext?.dependenciesChanged === true ||
      retryContext?.environmentChanged === true ||
      Boolean(
        structuredReason?.code.trim() && structuredReason.detail.trim(),
      );
    if (authorized) {
      return { block: false };
    }
    if (READ_ONLY_TOOLS.has(name) && !this.failedReadRetryUsed.has(sig)) {
      const lastFailStep = [...this.attempts]
        .reverse()
        .find((a) => a.canonicalSignature === sig && !a.ok)?.step;
      if (
        lastFailStep !== undefined &&
        this.lastSuccessfulNonMetaStep > lastFailStep
      ) {
        this.failedReadRetryUsed.add(sig);
        this.signatureCount.delete(sig);
        this.signatureSuccess.delete(sig);
        return { block: false };
      }
    }
    return {
      block: true,
      kind: "failed-retry",
      reason: `${name} previously failed with identical arguments. Change the command/args, fix the environment, or provide a structured retry reason.`,
    };
  }

  getAttemptCount(name: string, args: Record<string, unknown>): number {
    const sig = this.canonicalize(name, args);
    return this.signatureCount.get(sig) ?? 0;
  }

  /**
   * Check if recent calls show a pattern of repeated failures
   * (e.g., command not found → retry → not found → ...).
   */
  hasRepeatedFailures(threshold = 3): boolean {
    if (this.attempts.length < threshold) return false;
    const recent = this.attempts.slice(-threshold);
    return recent.every((a) => !a.ok);
  }

  /**
   * Count consecutive failures trailing the most recent attempts.
   * Stops at the first success (or the start of the history).
   */
  consecutiveFailureCount(): number {
    let count = 0;
    for (let i = this.attempts.length - 1; i >= 0; i--) {
      if (!this.attempts[i]!.ok) count++;
      else break;
    }
    return count;
  }

  /**
   * Returns a reflection prompt when recent failures suggest the agent may
   * be stuck, or null if everything looks fine.
   */
  getFailureReflection(): string | null {
    const consecutiveFailures = this.consecutiveFailureCount();
    if (consecutiveFailures < 3) return null;

    const recentFails = this.attempts.slice(-consecutiveFailures);
    const toolSummary = recentFails
      .map((a) => `  - ${a.callName}: ${a.canonicalSignature.slice(0, 120)}`)
      .slice(-5)
      .join("\n");

    const severity = consecutiveFailures >= 6 ? "CRITICAL" : "WARNING";

    return `⚠ APPROACH EVALUATION REQUIRED (${severity}) — ${consecutiveFailures} consecutive tool calls have FAILED.

Recent failures:
${toolSummary}

You MUST now pause and evaluate:
1. Are these failures all related to the SAME approach/method? If yes, this approach may not be viable.
2. Is there a DIFFERENT approach that could work? (different tool, different protocol, different technique)
3. Or is this a series of unrelated small issues that are being fixed incrementally?

DECIDE one of:
- CONTINUE: if you're making real progress and each failure teaches you something new
- SWITCH: describe the new approach before trying it
- STOP: if you've exhausted viable approaches — tell the user honestly what you tried and why it didn't work

Do NOT keep trying variations of the same failing approach without explicitly deciding to SWITCH or STOP first.`;
  }

  /**
   * Reset counters for read-only tools. Called after context compaction
   * so the model can re-fetch data whose results were compacted away.
   */
  resetReadOnly(): void {
    for (const sig of [...this.signatureCount.keys()]) {
      const name = sig.split("::")[0] ?? "";
      if (READ_ONLY_TOOLS.has(name)) {
        this.signatureCount.delete(sig);
        this.signatureSuccess.delete(sig);
      }
    }
    this.attempts = this.attempts.filter(
      (a) => !READ_ONLY_TOOLS.has(a.callName),
    );
  }

  get totalAttempts(): number {
    return this.attempts.length;
  }
}
