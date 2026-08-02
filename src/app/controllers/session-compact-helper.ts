/**
 * Summarizer callback used by SessionController.compact (keeps the controller slim).
 */

import type { ChatMessage, ProviderId } from "../../types.js";
import {
  compactMessagesWithSummary,
  estimateMessagesTokens,
  isCompactionMemoryMessage,
  type CompactResult,
} from "../../agent/context-manager.js";
import { completeWithProvider, streamWithProvider } from "../../llm/router.js";
import {
  createThinkingStreamParser,
  stripThinking,
} from "../../ui/thinking.js";
import type {
  AnyAppEvent,
  AppEventPayloads,
} from "../events/app-event.js";
import type { EventSequencer } from "../events/sequencer.js";

export async function summarizeForSessionCompact(
  prompt: string,
  opts: {
    provider: ProviderId | undefined;
    model: string | undefined;
    signal?: AbortSignal | undefined;
    /** plan-implement needs denser handoff memory — allow a larger completion. */
    purpose?: "default" | "plan-implement" | undefined;
    onToken?: ((token: string) => void) | undefined;
  },
): Promise<string> {
  const maxTokens = 8_192;
  const systemContent =
    opts.purpose === "plan-implement"
      ? "Write concise, non-redundant research memory for an agent executing an approved plan. Do not add framing: the PLAN MODE HANDOFF wrapper and active plan are injected separately. For coding target 600–1000 tokens; preserve only verified state, reusable research/artifacts, decisions, blockers, and risks. Security handoffs may be longer to preserve findings and coverage. Never invent or cut a fact mid-token. You are summarizing, not continuing: never emit tool calls or fabricate tool results, file receipts, or transcript lines."
      : "You compress conversation history into accurate continuation memory. You are SUMMARIZING the past session, not continuing it: do not answer the user, do not perform the next task, and never emit tool calls or fabricate tool results, file-write receipts (bytes/lines/sha256), exit codes, or 'TOOL:'/'[tools: …]' transcript lines. Describe what already happened in your own words.";

  const completeSummary = async (
    p: string,
    onToken?: (token: string) => void,
  ): Promise<string> => {
    const request = {
      provider: opts.provider,
      model: opts.model,
      messages: [
        {
          role: "system" as const,
          content: systemContent,
        },
        { role: "user" as const, content: p },
      ],
      temperature: 0.1,
      maxTokens,
      signal: opts.signal,
    };
    let rawSummary: string;
    if (!onToken) {
      rawSummary = (await completeWithProvider(request, { maxRetries: 1 })).text;
    } else {
      const parser = createThinkingStreamParser(onToken, undefined, {
        remember: false,
      });
      const response = await streamWithProvider(
        request,
        (token) => parser.push(token),
        { onStatus: () => undefined, maxRetries: 1 },
      );
      parser.finish();
      rawSummary = response.text;
    }

    const parsed = stripThinking(rawSummary);
    if (parsed.visible.trim() || !parsed.hasThinking) return rawSummary;

    const retry = await completeWithProvider({
      ...request,
      messages: [
        {
          role: "system" as const,
          content: `${systemContent}\nReturn only the continuation-memory summary. Do not include analysis, reasoning, or <think> tags.`,
        },
        { role: "user" as const, content: p },
      ],
      temperature: 0,
      maxTokens: 8_192,
      thinking: { enabled: false, effort: "none" as const },
    }, { maxRetries: 1 });
    const retryVisible = stripThinking(retry.text).visible.trim();
    if (retryVisible && onToken) onToken(retryVisible);
    return retry.text;
  };

  const chunkSize = 50_000;
  if (prompt.length <= chunkSize) {
    return completeSummary(prompt, opts.onToken);
  }
  const chunks = Array.from(
    { length: Math.ceil(prompt.length / chunkSize) },
    (_, index) => prompt.slice(index * chunkSize, (index + 1) * chunkSize),
  );
  const partials = await Promise.all(
    chunks.map((chunk, index) =>
      completeSummary(
        opts.purpose === "plan-implement"
          ? `Summarize part ${index + 1} of ${chunks.length} of plan-mode research for implement handoff. Preserve targets, stack, confirmed findings, negatives, untested classes, artifact paths, tools used, and remaining work.\n\n${chunk}`
          : `Summarize part ${index + 1} of ${chunks.length} of one session. Preserve concrete goals, actions, commands, results, task state, failures, and remaining work.\n\n${chunk}`,
      ),
    ),
  );
  opts.signal?.throwIfAborted();
  return completeSummary(
    opts.purpose === "plan-implement"
      ? "Merge these ordered partial plan-mode research memories into one non-redundant implement handoff. Use sections: User goals, Research evidence, Coverage ledger, Confirmed findings, Negative/tested-OK, Untested/open, Artifacts, Durable rules, Plan-mode-only notes, Commands/tools, Current state, Remaining work, Open risks. Complete every fact; never cut mid-token.\n\n" +
          partials.map((part, index) => `PART ${index + 1}:\n${part}`).join("\n\n")
      : "Merge these ordered partial session memories into one non-redundant continuation memory. Preserve all concrete facts and unresolved work. Use sections: User goals, Decisions and constraints, Work completed, Commands/tools and results, Current state, Remaining work.\n\n" +
          partials.map((part, index) => `PART ${index + 1}:\n${part}`).join("\n\n"),
    opts.onToken,
  );
}

interface RunSessionCompactionOptions {
  readonly history: ChatMessage[];
  readonly sessionTranscript?: string | undefined;
  readonly keepRecent: number;
  readonly signal: AbortSignal;
  readonly purpose?: "default" | "plan-implement" | undefined;
  readonly provider: ProviderId | undefined;
  readonly model: string | undefined;
  readonly persist: boolean;
  readonly compactionId: string;
  readonly sequencer: EventSequencer;
  readonly emit: (event: AnyAppEvent) => void;
  readonly isCurrent: () => boolean;
  readonly commit: (result: CompactResult) => void;
  readonly persistNow: () => Promise<void>;
}

export async function runSessionCompaction(
  options: RunSessionCompactionOptions,
): Promise<CompactResult> {
  type CompactionEventType =
    | "compaction-started"
    | "compaction-delta"
    | "compaction-completed"
    | "compaction-failed";
  const emit = <T extends CompactionEventType>(
    type: T,
    payload: AppEventPayloads[T],
  ): void => {
    options.emit(
      options.sequencer.build(type, payload, undefined) as AnyAppEvent,
    );
  };

  const beforeTokens = estimateMessagesTokens(options.history);
  if (options.persist) {
    emit("compaction-started", {
      compactionId: options.compactionId,
      beforeTokens,
    });
  }

  let settled = false;
  try {
    const result = await compactMessagesWithSummary(
      options.history,
      (prompt, stage) =>
        summarizeForSessionCompact(prompt, {
          provider: options.provider,
          model: options.model,
          signal: options.signal,
          purpose: options.purpose,
          ...(options.persist && stage?.phase !== "map"
            ? {
                onToken: (text: string) => {
                  if (options.isCurrent()) {
                    emit("compaction-delta", {
                      compactionId: options.compactionId,
                      text,
                    });
                  }
                },
              }
            : {}),
        }),
      {
        budgetTokens: 0,
        keepRecent: options.keepRecent,
        purpose: options.purpose,
      },
      options.sessionTranscript,
    );

    if (!options.isCurrent()) return result;
    options.commit(result);
    if (options.persist && result.summarized) {
      const summary =
        [...result.messages]
          .reverse()
          .find((message) => isCompactionMemoryMessage(message))?.content ??
        "Compacted context";
      emit("compaction-completed", {
        compactionId: options.compactionId,
        summary,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
      });
    } else if (options.persist) {
      emit("compaction-failed", {
        compactionId: options.compactionId,
        message: "There was no closed history to compact.",
        retainedTokens: beforeTokens,
      });
    }
    if (options.persist) settled = true;
    if (options.persist && result.summarized && result.after !== result.before) {
      await options.persistNow();
    }
    return result;
  } catch (error) {
    if (options.persist && !settled && options.isCurrent()) {
      const message = error instanceof Error ? error.message : String(error);
      emit("compaction-failed", {
        compactionId: options.compactionId,
        message: /aborted/i.test(message) ? "Compaction was cancelled." : message,
        retainedTokens: beforeTokens,
      });
    }
    throw error;
  }
}
