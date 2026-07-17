/**
 * Accept-by-default gate for plan-implement research compaction.
 *
 * Prefer keeping a good free-form model summary. Reject only clear structural
 * failures (empty summary, orphan tool pairs, catastrophic stub) — never on
 * missing headings, missing hostnames, or token-% taste checks.
 */

import type { ChatMessage } from "../types.js";
import { hasOrphanToolMessages } from "./tool-history.js";
import {
  COMPACTION_MEMORY_PREFIX,
  PLAN_IMPLEMENT_MEMORY_PREFIX,
} from "./context-manager.js";

/** Summary body shorter than this after a large history is treated as a stub. */
export const CATASTROPHIC_SUMMARY_MIN_CHARS = 120;

const MEMORY_PREFIXES = [
  PLAN_IMPLEMENT_MEMORY_PREFIX,
  COMPACTION_MEMORY_PREFIX,
] as const;
/**
 * Only apply catastrophic-stub check when pre-compact history was at least
 * this many estimated tokens (small sessions may legitimately shrink a lot).
 */
export const CATASTROPHIC_BEFORE_TOKENS_MIN = 8_000;
/** After-tokens ratio below this vs large before + tiny body → reject. */
export const CATASTROPHIC_AFTER_RATIO = 0.05;

export interface AcceptPlanImplementCompactionInput {
  readonly summarized: boolean;
  /** Memory body without the COMPACTION_MEMORY_PREFIX header (or full text). */
  readonly summaryBody: string;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly afterMessages: readonly ChatMessage[];
}

export type AcceptPlanImplementCompactionResult =
  | { readonly accept: true }
  | { readonly accept: false; readonly reason: string };

function summaryBodyText(raw: string): string {
  const t = raw.trim();
  for (const prefix of MEMORY_PREFIXES) {
    if (t.startsWith(prefix)) {
      return t.slice(prefix.length).replace(/^\s+/, "");
    }
  }
  return t;
}

/**
 * Accept unless a clear structural failure is proven.
 * Does not inspect plan.goal keywords or markdown section headings.
 */
export function acceptPlanImplementCompaction(
  input: AcceptPlanImplementCompactionInput,
): AcceptPlanImplementCompactionResult {
  if (!input.summarized) {
    return { accept: false, reason: "compaction did not produce a summary" };
  }

  const body = summaryBodyText(input.summaryBody);
  if (!body) {
    return { accept: false, reason: "empty compaction summary" };
  }

  if (hasOrphanToolMessages([...input.afterMessages])) {
    return {
      accept: false,
      reason: "compacted history has orphan tool messages",
    };
  }

  // Catastrophic stub: huge history collapsed to almost nothing + tiny body.
  // Normal dense free-form summaries are hundreds+ chars — never reject those.
  const before = Math.max(0, input.beforeTokens);
  const after = Math.max(0, input.afterTokens);
  if (
    before >= CATASTROPHIC_BEFORE_TOKENS_MIN &&
    body.length < CATASTROPHIC_SUMMARY_MIN_CHARS &&
    after < before * CATASTROPHIC_AFTER_RATIO
  ) {
    return {
      accept: false,
      reason: "compaction summary is too thin for a large research session",
    };
  }

  return { accept: true };
}

/** Extract summary body from compacted messages for the accept gate. */
export function extractCompactionSummaryBody(
  messages: readonly ChatMessage[],
): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role !== "system" || typeof m.content !== "string") continue;
    if (MEMORY_PREFIXES.some((p) => m.content.startsWith(p))) {
      return summaryBodyText(m.content);
    }
  }
  return "";
}

/** Skip compact when history is already small (no toast). */
export const PLAN_IMPLEMENT_COMPACT_MIN_TOKENS = 6_000;
