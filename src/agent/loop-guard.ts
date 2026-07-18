import type { ToolCall } from "../types.js";

export interface ToolAttempt {
  step: number;
  callName: string;
  canonicalSignature: string;
  ok: boolean;
  exitCode?: number | undefined;
}

/**
 * Non-mutating tools that may legitimately need re-calling after context
 * compaction removes their earlier results. These get a higher dedup
 * threshold (3 vs 2 for write tools) and their counters can be reset when
 * context is compacted.
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
 * Track and detect tool-call repetition patterns so the agent doesn't
 * waste steps in loops.
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
  /** Structured justification for retrying without an external change. */
  retryReason?: {
    code: string;
    detail: string;
  };
}

export class LoopGuard {
  private attempts: ToolAttempt[] = [];
  private signatureCount = new Map<string, number>();
  private signatureSuccess = new Map<string, boolean>();
  /** First successful output body per signature (for thrash-safe reuse). */
  private successOutputs = new Map<string, string>();
  /** Failed read-only signatures that already used their one free env-change retry. */
  private failedReadRetryUsed = new Set<string>();
  private lastSuccessfulNonMetaStep = -1;

  constructor(_options: LoopGuardOptions = {}) {}

  /**
   * Produce a canonical string for a (name, args) pair so that calls
   * with identical semantics match even if arg order differs or
   * command whitespace varies.
   */
  canonicalize(name: string, args: Record<string, unknown>): string {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(args).sort()) {
      let value = args[key];
      // Normalize command whitespace for shell.exec
      if (
        (name === "shell.exec" || name === "shell.start") &&
        key === "command" &&
        typeof value === "string"
      ) {
        value = value.trim().replace(/\s+/g, " ");
      }
      sorted[key] = value;
    }
    return `${name}::${JSON.stringify(sorted)}`;
  }

  recordAttempt(
    step: number,
    name: string,
    args: Record<string, unknown>,
    ok: boolean,
    exitCode?: number | undefined,
    output?: string | undefined,
  ): void {
    const sig = this.canonicalize(name, args);
    this.attempts.push({ step, callName: name, canonicalSignature: sig, ok, exitCode });
    this.signatureCount.set(sig, (this.signatureCount.get(sig) ?? 0) + 1);
    // Remember whether this exact call has EVER succeeded.
    if (ok) {
      this.signatureSuccess.set(sig, true);
      if (typeof output === "string" && output.length > 0 && !this.successOutputs.has(sig)) {
        // Cap cache size so identical re-calls stay cheap.
        this.successOutputs.set(sig, output.slice(0, 48_000));
      }
      if (name !== "task.update" && name !== "plan.create") {
        this.lastSuccessfulNonMetaStep = step;
      }
    } else {
      if (!this.signatureSuccess.has(sig)) this.signatureSuccess.set(sig, false);
    }

    // After successful *mutates* (not reads), allow re-list/re-read of those paths.
    // Never invalidate on fs.read/list themselves — that wiped the dedup counter
    // on every successful read and disabled loop detection.
    if (ok && this.isPathMutatingTool(name)) {
      this.invalidateReadsAfterSuccess(name, args);
    }
  }

  /** Prior successful body for this exact call, if any. */
  getCachedSuccessOutput(
    name: string,
    args: Record<string, unknown>,
  ): string | undefined {
    const sig = this.canonicalize(name, args);
    if (!this.signatureSuccess.get(sig)) return undefined;
    return this.successOutputs.get(sig);
  }

  hasSucceeded(name: string, args: Record<string, unknown>): boolean {
    return this.signatureSuccess.get(this.canonicalize(name, args)) === true;
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
        if (f && typeof f === "object" && typeof (f as { path?: string }).path === "string") {
          paths.push((f as { path: string }).path);
        }
      }
    }
    if (
      (name === "shell.exec" || name === "shell.start") &&
      typeof args.command === "string"
    ) {
      const cmd = args.command;
      // mkdir -p path, create-vite name, cd path
      for (const m of cmd.matchAll(
        /(?:mkdir\s+(?:-p\s+)?|cd\s+|create-[\w@./-]+\s+|vite@\S+\s+)(['"]?)([^\s;'"]+)\1/gi,
      )) {
        if (m[2] && m[2] !== ".") paths.push(m[2]);
      }
      if (typeof args.cwd === "string") paths.push(args.cwd);
    }
    if (paths.length === 0) {
      // Any successful shell still clears failed fs.list of unknown paths once
      // via the generic read-only retry path in shouldBlock.
      return;
    }
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
   * Check whether the proposed call should be blocked as a repeat.
   *
   * Returns `{ block: false }` if the call is fine, or
   * `{ block: false, reason: "..." }` for a warning (first repeat), or
   * `{ block: true, reason: "..." }` to force summary (second+ repeat).
   *
   * Failed read-only tools may retry once after any successful intervening
   * non-meta work (e.g. list missing dir → scaffold → list again). Failed
   * mutates still need structured retry context or a changed path.
   * Successful identical mutates are still deduped.
   */
  shouldBlock(
    name: string,
    args: Record<string, unknown>,
    retryContext?: RetryContext,
  ): { block: boolean; reason?: string | undefined } {
    if (name === "task.update" || name === "plan.create") {
      return { block: false };
    }
    const sig = this.canonicalize(name, args);
    const count = this.signatureCount.get(sig) ?? 0;

    if (count === 0) return { block: false };

    // Previously-failed signature: allow structured retry, or one free retry
    // for read-only tools after environment-changing successful work.
    if (this.signatureSuccess.get(sig) === false) {
      const structuredReason = retryContext?.retryReason;
      const authorized =
        retryContext?.dependenciesChanged === true ||
        retryContext?.environmentChanged === true ||
        Boolean(structuredReason?.code.trim() && structuredReason.detail.trim());
      if (authorized) {
        return {
          block: false,
          reason: `${name} retry authorized by changed context or structured rationale.`,
        };
      }
      if (READ_ONLY_TOOLS.has(name) && !this.failedReadRetryUsed.has(sig)) {
        // Permit one retry after any successful non-meta tool since the fail.
        const lastFailStep = [...this.attempts]
          .reverse()
          .find((a) => a.canonicalSignature === sig && !a.ok)?.step;
        if (
          lastFailStep !== undefined &&
          this.lastSuccessfulNonMetaStep > lastFailStep
        ) {
          this.failedReadRetryUsed.add(sig);
          // Reset counters so a successful retry is clean
          this.signatureCount.delete(sig);
          this.signatureSuccess.delete(sig);
          return {
            block: false,
            reason: `${name} retry allowed after successful work changed the environment.`,
          };
        }
      }
      return {
        block: true,
        reason: `${name} previously failed with identical arguments. Change dependencies/environment or provide a structured retry reason.`,
      };
    }

    // Mutating file tools deserve tool-appropriate wording. Telling a model
    // that just wrote a file to "use the results you already have" is
    // nonsensical and has caused models to assume the whole task is done.
    const isWrite =
      name === "fs.write" ||
      name === "fs.writeMany" ||
      name === "fs.edit" ||
      name === "fs.replaceLines" ||
      name === "fs.append";

    // Read-only tools get a higher threshold — they may need re-calling
    // after context compaction removes their earlier results.
    const threshold = READ_ONLY_TOOLS.has(name) ? 3 : 2;

    if (count < threshold) {
      return {
        block: false,
        reason: isWrite
          ? `${name} already wrote this exact path/content once. If that file is finished, move on to the NEXT file or step — do NOT rewrite it.`
          : name === "fs.read"
            ? `${name} already succeeded with these args. Use that prior output, or pass a different offset/limit for another range. After you edit the file, re-read is allowed automatically.`
            : `${name} has already been called with these arguments once and succeeded. Consider using the results you already have.`,
      };
    }

    // count >= threshold and at least one success: block
    return {
      block: true,
      reason: isWrite
        ? `${name} was already called ${count} time(s) with the identical path and content. That file is already written. Continue with the remaining files/steps or give your final answer.`
        : name === "fs.read"
          ? `${name} was already called ${count} time(s) with the same arguments. Use the prior read in context, or change offset/limit. After a mutating edit on this path, re-read is allowed.`
          : `${name} was already called ${count} time(s) with the same arguments. The data is already in your context — analyze what you have and move to the next step.`,
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
   *
   * Unlike hardcoded thresholds, this provides context for the MODEL to
   * decide whether to continue (lengthy but progressing approach) or
   * switch/stop (genuinely stuck approach).
   */
  getFailureReflection(): string | null {
    const consecutiveFailures = this.consecutiveFailureCount();
    if (consecutiveFailures < 3) return null;

    // Build context: what tools failed and what they were trying
    const recentFails = this.attempts.slice(-consecutiveFailures);
    const toolSummary = recentFails
      .map((a) => `  - ${a.callName}: ${a.canonicalSignature.slice(0, 120)}`)
      .slice(-5) // Show last 5 max
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

  /**
   * Get the total number of recorded attempts.
   */
  get totalAttempts(): number {
    return this.attempts.length;
  }
}
