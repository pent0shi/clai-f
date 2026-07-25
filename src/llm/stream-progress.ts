/**
 * LLM-003 — stream progress tagging.
 *
 * A retry is only transparent if nothing has been emitted yet. Once tokens have
 * reached the caller's `onToken` sink (which the agent runner feeds into a
 * single delta parser and a single assistant message), re-running the request
 * appends a second copy of the answer — duplicated prose and, worse, duplicated
 * or spliced tool-call JSON.
 *
 * Errors thrown after emission are tagged with the byte count so every retry
 * decision (key rotation, provider fallback, the runner's recovery ladder) can
 * refuse to retry transparently.
 */
const EMITTED_BYTES = Symbol.for("clai.stream.emittedBytes");

export function markStreamEmittedBytes<E>(error: E, bytes: number): E {
  if (bytes > 0 && typeof error === "object" && error !== null) {
    try {
      Object.defineProperty(error, EMITTED_BYTES, {
        value: bytes,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    } catch {
      // Frozen error objects cannot be tagged; treat as no progress.
    }
  }
  return error;
}

export function streamEmittedBytes(error: unknown): number {
  if (typeof error !== "object" || error === null) return 0;
  const value = (error as Record<symbol, unknown>)[EMITTED_BYTES];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** True when the failed attempt already delivered bytes to the caller. */
export function streamAlreadyEmitted(error: unknown): boolean {
  return streamEmittedBytes(error) > 0;
}
