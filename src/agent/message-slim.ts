/**
 * Cap in-memory / re-sent message bulk from native toolCalls.
 *
 * fs.write / writeMany put entire file bodies in tool-call args. Those were
 * stored verbatim in history and LoopGuard signatures, so a scaffold turn
 * could hold many multi-MB strings — memory climbed into the multi-GB range
 * and Macs heated under GC. Full file bodies remain on disk; tool results
 * still report paths/bytes.
 */

import { createHash } from "node:crypto";

/** Strings at or above this are replaced with a length+hash stub. */
export const SLIM_ARG_STRING_CHARS = 400;
/** Hard ceiling for a single string kept as-is in history (safety). */
export const SLIM_ARG_ABSOLUTE_MAX_CHARS = 8_000;
/** Max depth when walking args trees (writeMany files[]). */
const SLIM_MAX_DEPTH = 6;

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/**
 * Replace large string values with a compact stub so history/loop-guard
 * never retains full write payloads. Small strings and structure stay intact
 * so path-based identity still works for loop detection.
 */
export function slimValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    if (value.length < SLIM_ARG_STRING_CHARS) return value;
    const hash = shortHash(value);
    return `«${value.length} chars sha256=${hash}»`;
  }
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (depth >= SLIM_MAX_DEPTH) {
    if (Array.isArray(value)) return `[…${value.length} items]`;
    return "{…}";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => slimValue(entry, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = slimValue((value as Record<string, unknown>)[key], depth + 1);
  }
  return out;
}

export function slimToolArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const slimmed = slimValue(args);
  if (slimmed && typeof slimmed === "object" && !Array.isArray(slimmed)) {
    return slimmed as Record<string, unknown>;
  }
  return {};
}

/** Approximate UTF-16 code units for token budgeting (same basis as content). */
export function measureToolCallsChars(
  toolCalls:
    | readonly {
        readonly name?: string;
        readonly id?: string;
        readonly args?: Record<string, unknown>;
      }[]
    | undefined,
): number {
  if (!toolCalls?.length) return 0;
  let n = 0;
  for (const tc of toolCalls) {
    n += (tc.name?.length ?? 0) + (tc.id?.length ?? 0) + 8;
    if (tc.args) {
      try {
        n += JSON.stringify(tc.args).length;
      } catch {
        n += 64;
      }
    }
  }
  return n;
}
