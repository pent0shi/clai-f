/**
 * @deprecated Removed. Keyword-ranking "generic" reduction made models invent
 * empty/interrupted tool results (lines without CVE/port keywords were dropped).
 *
 * Noise control is now:
 * 1. Filter at the **command** (quiet flags, matchers, -mc/-fc for fuzzers).
 * 2. Long jobs → durable background artifacts + shell.tail.
 * 3. Model context → honest head+tail + full path on disk.
 *
 * This module remains only so old imports fail loudly in tests if revived.
 */
import type { Reducer, ReducerOutput } from "./types.js";

/** Identity only — never rank or omit by keyword. Prefer not calling this. */
export const genericReducer: Reducer = (raw): ReducerOutput => ({
  summary: raw,
});
