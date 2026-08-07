// Incremental tool-surface stripping for streaming assistant text.
// Re-stripping the whole message on every delta is O(n^2). Here each delta scans
// only the new chunk (plus a two-char overlap), prose that can no longer contain
// a marker is flushed into an immutable prefix, and the expensive strip regexes
// run only while the tail actually holds a tool surface.

import { stripToolCallSurfaces } from "./strip-tool-surfaces.js";

export interface StripStream {
  // Display text for the flushed prefix (already stripped).
  readonly stableText: string;
  // Raw, still-rescannable tail.
  readonly rawTail: string;
  // Full display text: stableText + strip(rawTail).
  readonly text: string;
  // True while rawTail provably needs no stripping or whitespace collapse.
  readonly clean: boolean;
}

export const EMPTY_STRIP_STREAM: StripStream = {
  stableText: "",
  rawTail: "",
  text: "",
  clean: true,
};

const TAIL_FLUSH_CHARS = 4_096;

// Characters that can begin any tool surface handled by stripToolCallSurfaces,
// plus the whitespace runs it collapses.
const DIRTY = /[`<]|tool_call\s*\(|invoke_tool\s*\(|[ \t]\n|\n\n\n/;

// Longest lookbehind needed so a pattern split across chunks is still seen.
const OVERLAP = 2;

function flushBoundary(text: string, limit: number): number {
  const newline = text.lastIndexOf("\n", limit);
  if (newline >= 0) {
    let end = newline + 1;
    while (end < text.length && text[end] === "\n") end += 1;
    if (end < text.length) return end;
  }
  let cut = limit + 1;
  while (cut > 0 && (text[cut - 1] === " " || text[cut - 1] === "\t")) cut -= 1;
  return cut > 0 && cut < text.length ? cut : -1;
}

// Complete tool surfaces are gone for good, so everything up to the end of the
// last one can be stripped once and flushed; the remaining prose returns to the
// cheap append path instead of being rescanned forever.
const COMPLETE_SURFACE =
  /```(?:tool|json\s*tool)\b[^\n]*\n[\s\S]*?```|<tool_call\b[^>]*>[\s\S]*?<\/tool_call>|<[|｜]+DSML[|｜]+tool_calls\b[^>]*>[\s\S]*?<\/[|｜]+DSML[|｜]+tool_calls>/g;

function settleCompletedSurfaces(
  stableText: string,
  rawTail: string,
): { stableText: string; rawTail: string } | undefined {
  COMPLETE_SURFACE.lastIndex = 0;
  let end = -1;
  for (;;) {
    const match = COMPLETE_SURFACE.exec(rawTail);
    if (!match) break;
    end = match.index + match[0].length;
  }
  if (end < 0) return undefined;
  const strippedPrefix = stripToolCallSurfaces(rawTail.slice(0, end));
  // Trailing whitespace stays in the tail: a later chunk can still form a run
  // that the one-shot strip would collapse across this seam.
  let keep = strippedPrefix.length;
  while (keep > 0 && /\s/.test(strippedPrefix[keep - 1]!)) keep -= 1;
  const remainder = strippedPrefix.slice(keep) + rawTail.slice(end);
  if (DIRTY.test(remainder)) return undefined;
  return {
    stableText: stableText + strippedPrefix.slice(0, keep),
    rawTail: remainder,
  };
}

function pushSettled(settled: {
  stableText: string;
  rawTail: string;
}): { stream: StripStream; text: string } {
  const text = settled.stableText + settled.rawTail;
  return { stream: { ...settled, text, clean: true }, text };
}

export function pushStripChunk(
  stream: StripStream,
  chunk: string,
): { stream: StripStream; text: string } {
  const rawTail = stream.rawTail + chunk;
  const window = stream.clean
    ? stream.rawTail.slice(Math.max(0, stream.rawTail.length - OVERLAP)) + chunk
    : rawTail;
  const clean = stream.clean && !DIRTY.test(window);

  if (!clean) {
    const settled = settleCompletedSurfaces(stream.stableText, rawTail);
    if (settled) return pushSettled(settled);
  }

  let stableText = stream.stableText;
  let tail = rawTail;
  if (clean && tail.length > TAIL_FLUSH_CHARS) {
    const cut = flushBoundary(tail, tail.length - 1);
    if (cut > 0) {
      stableText += tail.slice(0, cut);
      tail = tail.slice(cut);
    }
  }

  const text = clean ? stream.text + chunk : stableText + stripToolCallSurfaces(tail);
  return { stream: { stableText, rawTail: tail, text, clean }, text };
}
