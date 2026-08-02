/**
 * Summarizer callback used by SessionController.compact (keeps the controller slim).
 */

import type { ChatMessage, ProviderId } from "../../types.js";
import {
  COMPACTION_MAX_COMPLETION_TOKENS,
  COMPACTION_MAP_MAX_COMPLETION_TOKENS,
} from "../../agent/compaction-summary.js";
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
    stage?: "single" | "map" | "reduce" | undefined;
    onToken?: ((token: string) => void) | undefined;
  },
): Promise<string> {
  const maxTokens =
    opts.stage === "map"
      ? COMPACTION_MAP_MAX_COMPLETION_TOKENS
      : COMPACTION_MAX_COMPLETION_TOKENS;
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
      // Summarizing does not benefit from hidden reasoning; disabling it keeps
      // compaction cheap and consistent for reasoning-capable providers.
      thinking: { enabled: false, effort: "none" as const },
      signal: opts.signal,
    };
    let rawSummary: string;
    if (!onToken) {
      rawSummary = (await completeWithProvider(request, { maxRetries: 0 })).text;
    } else {
      const parser = createThinkingStreamParser(onToken, undefined, {
        remember: false,
      });
      const response = await streamWithProvider(
        request,
        (token) => parser.push(token),
        { onStatus: () => undefined, maxRetries: 0 },
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
      maxTokens,
      thinking: { enabled: false, effort: "none" as const },
    }, { maxRetries: 0 });
    const retryVisible = stripThinking(retry.text).visible.trim();
    if (retryVisible && onToken) onToken(retryVisible);
    return retry.text;
  };

  // `compactMessagesWithSummary` owns chunking/map-reduce. A second splitting
  // layer here multiplied one /compact into N map calls plus another reduce.
  return completeSummary(prompt, opts.onToken);
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
          stage: stage?.phase,
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
