import type { ChatMessage } from "../types.js";
import { redactSecrets } from "../llm/provider.js";
import { stripThinking } from "../ui/thinking.js";
import {
  expandKeepStartForToolPairs,
  hasOrphanToolMessages,
} from "./tool-history.js";
import {
  buildCompactionUserPrompt,
  trimTranscriptForCompaction,
} from "./compaction-summary.js";
import {
  measureToolCallsChars,
  slimToolArgs,
} from "./message-slim.js";

/**
 * Per-char token estimator. Real tokenization varies by provider, but for
 * budgeting a chars/3.3 heuristic is close enough for mixed text/code/JSON
 * (which tokenizes less efficiently than pure English prose). We
 * deliberately over-estimate — better to compact one turn too early than to
 * lose state to a provider context-window error.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.3);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let sum = 0;
  for (const message of messages) {
    sum += estimateTokens(message.content) + 4; // role overhead
    // Native toolCalls often carry full fs.write bodies — must count them or
    // auto-compact never fires and RAM climbs with every scaffold write.
    if (message.toolCalls?.length) {
      const toolChars = Math.min(
        measureToolCallsChars(message.toolCalls),
        2_000_000,
      );
      sum += Math.ceil(toolChars / 3.3);
    }
    // Images contribute tokens too — a typical image is ~1k tokens.
    if (message.images) {
      sum += message.images.length * 1000;
    }
  }
  return sum;
}

/**
 * Agent-loop auto-compact threshold (estimated tokens). Shared with `/context`
 * so the reported % of budget matches when auto-compaction fires.
 *
 * 100k (was 150k): thinking models balloon context; implement turns with large
 * tool artifacts hit mid-100k before the old threshold and then fail streams.
 * Earlier compact keeps implement/plan loops healthier without constant /compact.
 */
export const AUTO_COMPACT_TOKEN_BUDGET = 100_000;

/**
 * Soft post-compact band we *prefer* (includes system prompt ~8k).
 * Achieved by dense memory + progressive soft-trim of oversized dumps only.
 * Never a reject gate, never drops messages/tool pairs to hit the number.
 */
export const POST_COMPACT_SOFT_GUIDANCE_TOKENS = 16_000;
/** Prefer landing at or under this; still accept if content needs more room. */
export const POST_COMPACT_SOFT_UPPER_BAND_TOKENS = 20_000;

type TailPreferMax = { tool: number; assistant: number; user: number };

/**
 * Progressive soft-trim tiers for the kept tail. Start generous; only step
 * tighter if estimate is still above the soft upper band. Never blanks a
 * message or removes tool pairs.
 */
const TAIL_SOFT_TIERS: readonly TailPreferMax[] = [
  { tool: 6_000, assistant: 8_000, user: 8_000 },
  { tool: 4_000, assistant: 5_000, user: 6_000 },
  { tool: 2_500, assistant: 3_500, user: 4_000 },
];

/** Auto-compact: reject empty/near-empty memory after large history (amnesia). */
export const AUTO_COMPACT_STUB_MIN_CHARS = 120;
export const AUTO_COMPACT_STUB_BEFORE_TOKENS = 20_000;

export interface CompactOptions {
  /** Soft budget (tokens). When estimated tokens exceed this, compact. */
  budgetTokens?: number | undefined;
  /** Keep this many trailing messages (system + user/assistant pairs). */
  keepRecent?: number | undefined;
  /**
   * Bias summarizer prompt (e.g. plan-implement preserves recon evidence).
   * Does not change accept/reject heuristics.
   */
  purpose?: "default" | "plan-implement" | undefined;
}

export interface CompactResult {
  messages: ChatMessage[];
  before: number;
  after: number;
  beforeTokens: number;
  afterTokens: number;
  summarized: boolean;
}

const DEFAULT_BUDGET_TOKENS = 32_000;
/** Default keepRecent for mechanical compact; LLM auto path uses 2 via runner. */
const DEFAULT_KEEP_RECENT = 2;

/**
 * Content prefixes that mark a `role:"system"` message as compacted session
 * memory (vs. the main system prompt or transient injected guidance). Exported
 * so history-persistence can KEEP this memory when it drops other system
 * messages — otherwise a resumed session that compacted mid-run would lose all
 * summarized context.
 */
export const COMPACTION_MEMORY_PREFIX =
  "Session memory from compacted earlier turns:";
/**
 * Plan-mode research handoff memory (pre-implement compact). Distinct so the
 * agent does not treat plan-mode gather-only history as permanent gates.
 * Explicitly ties this context to the plan/tasks the implementer is seeing.
 */
const LEGACY_PLAN_IMPLEMENT_MEMORY_PREFIX =
  "Session memory from PLAN MODE research that was used to build the comprehensive detailed plan and tasks you are seeing now (handoff to agent implement — gather-only phase is over; execute approved tasks):";
export const PLAN_IMPLEMENT_MEMORY_PREFIX =
  "PLAN MODE HANDOFF: research memory for the accepted implementation phase. Gather-only/await-approval gates are historical; ACTIVE PLAN and SESSION STATE are authoritative:";
export const MECHANICAL_MEMORY_PREFIX =
  "Earlier turns in this session, summarized";

export function isCompactionMemoryMessage(message: ChatMessage): boolean {
  return (
    message.role === "system" &&
    (message.content.startsWith(COMPACTION_MEMORY_PREFIX) ||
      message.content.startsWith(PLAN_IMPLEMENT_MEMORY_PREFIX) ||
      message.content.startsWith(LEGACY_PLAN_IMPLEMENT_MEMORY_PREFIX) ||
      message.content.startsWith(MECHANICAL_MEMORY_PREFIX))
  );
}

/** Prefix used when writing a compacted memory system message. */
export function compactionMemoryPrefixForPurpose(
  purpose?: "default" | "plan-implement" | undefined,
): string {
  return purpose === "plan-implement"
    ? PLAN_IMPLEMENT_MEMORY_PREFIX
    : COMPACTION_MEMORY_PREFIX;
}

/**
 * Replace older messages with a single condensed "memory" message while
 * preserving the system prompt and the most recent N messages.
 *
 * We do not call the LLM here — that's a future enhancement. The current
 * compaction is mechanical: keep the system prompt; replace the prefix of
 * older turns with a bullet list of the assistant's last lines and the
 * tool calls that produced output. This is conservative and reversible
 * (the artifact files still hold the raw outputs).
 */
export function compactMessages(
  messages: ChatMessage[],
  options: CompactOptions = {},
): ChatMessage[] {
  const budget = options.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const keepRecent = Math.max(2, options.keepRecent ?? DEFAULT_KEEP_RECENT);
  if (messages.length <= keepRecent + 1) return messages;
  if (estimateMessagesTokens(messages) <= budget) return messages;

  // Keep the real system prompt, but never pin prior compaction memory as
  // the head: re-compaction must summarize/replace that stale memory.
  const head: ChatMessage[] = [];
  let start = 0;
  if (
    messages[0]?.role === "system" &&
    !isCompactionMemoryMessage(messages[0])
  ) {
    head.push(messages[0]);
    start = 1;
  }

  let tailStart = Math.max(start, messages.length - keepRecent);
  tailStart = expandKeepStartForToolPairs(messages, tailStart);
  const tail = messages.slice(tailStart);
  const middle = messages.slice(start, tailStart);
  if (middle.length === 0) return messages;

  const bullets: string[] = [];
  for (const msg of middle) {
    if (msg.role === "user") {
      bullets.push(`- user asked: ${oneLine(msg.content, 200)}`);
    } else if (msg.role === "assistant") {
      const line = oneLine(msg.content, 200);
      if (line) bullets.push(`- assistant: ${line}`);
      if (msg.toolCalls?.length) {
        bullets.push(
          `- assistant tools: ${msg.toolCalls.map((t) => t.name).join(", ")}`,
        );
      }
    } else if (msg.role === "tool") {
      bullets.push(`- tool result: ${oneLine(msg.content, 200)}`);
    }
  }

  const memo: ChatMessage = {
    role: "system",
    content:
      `${MECHANICAL_MEMORY_PREFIX} to fit the context budget. Full artifacts (when produced) are saved on disk and can be expanded with /output.\n\n` +
      bullets.join("\n"),
  };

  return [...head, memo, ...tail];
}

/**
 * Compact older turns into a model-written memory while retaining recent
 * messages verbatim. The model summary is the ONLY compaction path: if the
 * model fails to produce a summary we DO NOT fall back to a mechanical dump
 * of the transcript (that historically produced an enormous, low-quality
 * "memory" of tens of thousands of lines). Instead we throw, so the caller
 * can report the failure and the original messages stay untouched.
 */
export async function compactMessagesWithSummary(
  messages: ChatMessage[],
  summarize: (prompt: string) => Promise<string>,
  options: CompactOptions = {},
  sessionTranscript?: string | undefined,
): Promise<CompactResult> {
  const before = messages.length;
  const beforeTokens = estimateMessagesTokens(messages);
  const isForced = options.budgetTokens === 0;

  let keepRecent = Math.max(2, options.keepRecent ?? DEFAULT_KEEP_RECENT);
  const firstMessage = messages[0];
  const preserveSystemHead =
    firstMessage?.role === "system" &&
    !isCompactionMemoryMessage(firstMessage);
  const start = preserveSystemHead ? 1 : 0;
  let tailStart = Math.max(start, messages.length - keepRecent);
  tailStart = expandKeepStartForToolPairs(messages, tailStart);
  let older = messages.slice(start, tailStart);

  // If forced and the older slice would be empty, try keeping fewer recent
  // messages (minimum 1) so we have something to compact (e.g. the first user prompt).
  if (older.length === 0 && isForced && messages.length >= start + 2) {
    keepRecent = 1;
    tailStart = messages.length - 1;
    tailStart = expandKeepStartForToolPairs(messages, tailStart);
    older = messages.slice(start, tailStart);
  }

  if (older.length === 0 && !sessionTranscript?.trim()) {
    // Genuinely nothing to compact yet — return a no-op result.
    return {
      messages: [...messages],
      before,
      after: before,
      beforeTokens,
      afterTokens: beforeTokens,
      summarized: false,
    };
  }

  const messageTranscript = older
    .map((message) => {
      let content = redactSecrets(message.content);
      if (message.role === "assistant") {
        content = stripThinking(content).visible;
      }
      if (message.toolCalls?.length) {
        content +=
          "\n[tools: " +
          message.toolCalls.map((t) => t.name).join(", ") +
          "]";
      }
      return `${message.role.toUpperCase()}: ${content}`;
    })
    .join("\n\n");

  const visual = sessionTranscript?.trim()
    ? redactSecrets(sessionTranscript.trim())
    : "";
  const isDurableSystem = (content: string): boolean =>
    content.startsWith("ACTIVE PLAN") ||
    content.startsWith("SESSION STATE") ||
    content.startsWith("ENGAGEMENT SCOPE") ||
    content.startsWith("TASK ANALYSIS") ||
    content.includes("\nACTIVE PLAN") ||
    content.includes("SESSION STATE / WORKING MEMORY");

  const durableBits = messages
    .filter((m) => m.role === "system" && isDurableSystem(m.content))
    .map((m) => {
      // Large system prompts: extract only durable subsections when present.
      if (m.content.length > 4_000) {
        const chunks: string[] = [];
        for (const marker of [
          "ACTIVE PLAN",
          "SESSION STATE / WORKING MEMORY",
          "ENGAGEMENT SCOPE",
          "TASK ANALYSIS",
        ]) {
          const idx = m.content.indexOf(marker);
          if (idx >= 0) chunks.push(m.content.slice(idx, idx + 2_500));
        }
        return chunks.join("\n\n") || m.content.slice(0, 2_000);
      }
      return m.content;
    })
    .filter(Boolean)
    .join("\n\n");

  const rawCombined = buildCompactionUserPrompt({
    visualTranscript: visual || undefined,
    messageTranscript,
    durableState: durableBits || undefined,
    purpose: options.purpose,
  });
  const prompt = trimTranscriptForCompaction(rawCombined);

  const rawSummary = redactSecrets((await summarize(prompt)).trim());
  const summary = stripThinking(rawSummary).visible.trim();
  if (!summary) {
    throw new Error("compaction failed: model returned an empty summary");
  }

  const head = preserveSystemHead ? [messages[0]!] : [];
  const rawTail = messages.slice(tailStart);
  const memoryPrefix = compactionMemoryPrefixForPurpose(options.purpose);
  const memoryMsg: ChatMessage = {
    role: "system",
    content: `${memoryPrefix}\n\n${summary}`,
  };

  // Prefer ~16–20k: start with a generous lean tail, then progressively
  // soft-trim oversized dumps only while still over the soft upper band.
  // Never drop messages or tool pairs. If still high after last tier, accept.
  let compacted = buildLeanCompact(head, memoryMsg, rawTail, TAIL_SOFT_TIERS[0]!);
  for (let i = 1; i < TAIL_SOFT_TIERS.length; i += 1) {
    if (estimateMessagesTokens(compacted) <= POST_COMPACT_SOFT_UPPER_BAND_TOKENS) {
      break;
    }
    compacted = buildLeanCompact(head, memoryMsg, rawTail, TAIL_SOFT_TIERS[i]!);
  }

  // Structural safety only — never reject because afterTokens > soft band.
  if (hasOrphanToolMessages(compacted)) {
    throw new Error(
      "compaction failed: would produce orphan tool messages — keeping full history",
    );
  }

  const afterTokens = estimateMessagesTokens(compacted);
  return {
    messages: compacted,
    before,
    after: compacted.length,
    beforeTokens,
    afterTokens,
    summarized: true,
  };
}

function buildLeanCompact(
  head: ChatMessage[],
  memoryMsg: ChatMessage,
  rawTail: ChatMessage[],
  preferMax: TailPreferMax,
): ChatMessage[] {
  return [...head, memoryMsg, ...leanTailMessages(rawTail, preferMax)];
}

/**
 * Whether an auto-compact result is safe to apply.
 * Only structural / quality gates — never "afterTokens must be under N".
 */
export function shouldApplyAutoCompact(input: {
  summarized: boolean;
  summaryBody: string;
  beforeTokens: number;
  afterTokens: number;
  afterMessages: readonly ChatMessage[];
}): boolean {
  if (!input.summarized) return false;
  // Must actually shrink (otherwise pointless and can thrash).
  if (input.afterTokens >= input.beforeTokens) return false;
  if (hasOrphanToolMessages([...input.afterMessages])) return false;
  const body = input.summaryBody.trim();
  if (!body) return false;
  // Amnesia stub only — not a target-size check.
  if (
    input.beforeTokens >= AUTO_COMPACT_STUB_BEFORE_TOKENS &&
    body.length < AUTO_COMPACT_STUB_MIN_CHARS
  ) {
    return false;
  }
  return true;
}

function isStaleDurableSystem(content: string): boolean {
  return (
    content.startsWith("ACTIVE PLAN") ||
    content.startsWith("SESSION STATE") ||
    content.startsWith("ENGAGEMENT SCOPE") ||
    content.startsWith("TASK ANALYSIS") ||
    content.includes("SESSION STATE / WORKING MEMORY")
  );
}

/** Soft head+tail prefer — only when a single message is huge waste. */
function preferTrimContent(text: string, preferMax: number): string {
  if (text.length <= preferMax) return text;
  const half = Math.floor((preferMax - 48) / 2);
  if (half < 120) return text; // don't mangle medium messages
  return `${text.slice(0, half)}\n…(trimmed oversized dump in compact tail; full may be on disk)…\n${text.slice(-half)}`;
}

function leanTailMessages(
  tail: ChatMessage[],
  preferMax: { tool: number; assistant: number; user: number },
): ChatMessage[] {
  return tail
    .filter((msg) => {
      // Fresh plan/session are re-injected after compact — drop stale copies.
      if (msg.role === "system" && isStaleDurableSystem(msg.content)) {
        return false;
      }
      // Drop prior compaction memory from the tail (new memory is the prefix).
      if (isCompactionMemoryMessage(msg)) return false;
      return true;
    })
    .map((msg) => {
      if (msg.role === "tool") {
        return { ...msg, content: preferTrimContent(msg.content, preferMax.tool) };
      }
      if (msg.role === "assistant") {
        const visible = /<think/i.test(msg.content)
          ? stripThinking(msg.content).visible
          : msg.content;
        const slimCalls = msg.toolCalls?.map((tc) => ({
          ...tc,
          args: slimToolArgs(tc.args ?? {}),
        }));
        return {
          ...msg,
          content: preferTrimContent(visible, preferMax.assistant),
          ...(slimCalls ? { toolCalls: slimCalls } : {}),
        };
      }
      if (msg.role === "user") {
        return {
          ...msg,
          content: preferTrimContent(msg.content, preferMax.user),
        };
      }
      return msg;
    });
}

function oneLine(text: string, maxChars: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1)}…`;
}
