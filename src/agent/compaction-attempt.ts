import { createHash } from "node:crypto";
import type { ChatMessage } from "../types.js";

/**
 * Failed compaction must not be retried on every iteration: the transcript has
 * not changed, so the same provider call would fail the same way while burning
 * cost, latency and rate limit. An attempt is identified by everything that can
 * change its outcome; a repeat is only allowed after a cooldown or a real state
 * change.
 */
export const COMPACTION_RETRY_COOLDOWN_MS = 60_000;

export interface CompactionAttemptKeyInput {
  readonly messages: readonly ChatMessage[];
  readonly provider: string;
  readonly model: string;
  readonly dialect: string;
  readonly triggerTokens: number;
  readonly schemaHash: string;
}

export function compactionAttemptKey(input: CompactionAttemptKeyInput): string {
  const transcript = createHash("sha256");
  transcript.update(String(input.messages.length));
  for (const message of input.messages) {
    transcript.update("\0");
    transcript.update(message.role);
    transcript.update("\0");
    transcript.update(String(message.content?.length ?? 0));
  }
  return createHash("sha256")
    .update(
      [
        transcript.digest("hex"),
        input.provider,
        input.model,
        input.dialect,
        String(input.triggerTokens),
        input.schemaHash,
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 32);
}

/** Tracks attempts that failed so an unchanged retry is suppressed. */
export class CompactionAttemptLedger {
  private readonly failures = new Map<string, number>();

  constructor(
    private readonly cooldownMs: number = COMPACTION_RETRY_COOLDOWN_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when this exact attempt failed recently and must not be repeated. */
  isSuppressed(key: string): boolean {
    const failedAt = this.failures.get(key);
    if (failedAt === undefined) return false;
    if (this.now() - failedAt < this.cooldownMs) return true;
    this.failures.delete(key);
    return false;
  }

  recordFailure(key: string): void {
    this.failures.set(key, this.now());
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }

  clear(): void {
    this.failures.clear();
  }
}
