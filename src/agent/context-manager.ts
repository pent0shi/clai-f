import type { ChatMessage } from "../types.js";
import { redactSecrets } from "../llm/provider.js";
import { stripThinking } from "../ui/thinking.js";
import { expandKeepStartForToolPairs } from "./tool-history.js";
import {
  buildCompactionUserPrompt,
  trimTranscriptForCompaction,
} from "./compaction-summary.js";

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
 */
export const AUTO_COMPACT_TOKEN_BUDGET = 150_000;

export interface CompactOptions {
  /** Soft budget (tokens). When estimated tokens exceed this, compact. */
  budgetTokens?: number | undefined;
  /** Keep this many trailing messages (system + user/assistant pairs). */
  keepRecent?: number | undefined;
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
const DEFAULT_KEEP_RECENT = 6;

/**
 * Content prefixes that mark a `role:"system"` message as compacted session
 * memory (vs. the main system prompt or transient injected guidance). Exported
 * so history-persistence can KEEP this memory when it drops other system
 * messages — otherwise a resumed session that compacted mid-run would lose all
 * summarized context.
 */
export const COMPACTION_MEMORY_PREFIX =
  "Session memory from compacted earlier turns:";
export const MECHANICAL_MEMORY_PREFIX =
  "Earlier turns in this session, summarized";

export function isCompactionMemoryMessage(message: ChatMessage): boolean {
  return (
    message.role === "system" &&
    (message.content.startsWith(COMPACTION_MEMORY_PREFIX) ||
      message.content.startsWith(MECHANICAL_MEMORY_PREFIX))
  );
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

  // Always keep the system prompt (index 0 if it's a system message).
  const head: ChatMessage[] = [];
  let start = 0;
  if (messages[0]?.role === "system") {
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
  const start = messages[0]?.role === "system" ? 1 : 0;
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
  });
  const prompt = trimTranscriptForCompaction(rawCombined);

  const rawSummary = redactSecrets((await summarize(prompt)).trim());
  const summary = stripThinking(rawSummary).visible.trim();
  if (!summary) {
    throw new Error("compaction failed: model returned an empty summary");
  }

  const head = start === 1 ? [messages[0]!] : [];
  // Strip <think> tags from tail messages so thinking content never
  // survives compaction into the model's context.
  const tail = messages.slice(tailStart).map((msg) => {
    if (msg.role === "assistant" && /<think/i.test(msg.content)) {
      return { ...msg, content: stripThinking(msg.content).visible };
    }
    return msg;
  });
  const compacted: ChatMessage[] = [
    ...head,
    { role: "system", content: `${COMPACTION_MEMORY_PREFIX}\n\n${summary}` },
    ...tail,
  ];
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

function oneLine(text: string, maxChars: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1)}…`;
}
