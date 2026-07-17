/**
 * Pure transcript reducer (V2-050). Folds one `AnyAppEvent` into normalized
 * transcript state. Streaming deltas keep one open pending item per kind;
 * `assistant-message` / `thinking-block` finalize it. A real `tool-call`
 * discards any unfinalized assistant stream (raw tool-fence text) so display
 * order is thinking → Response prose → tool cards.
 */

import type { AnyAppEvent } from "../../app/events/app-event.js";
import type {
  AssistantItem,
  NoticeLevel,
  ThinkingItem,
  ToolItem,
  TranscriptItem,
  TranscriptState,
} from "./transcript-types.js";
import {
  isToolFenceOnlyText,
  stripToolCallSurfaces,
} from "../rendering/strip-tool-surfaces.js";
import { appendItem, moveItemBefore, removeItem, updateItem } from "./transcript-struct.js";

function updateToolItem(
  state: TranscriptState,
  toolCallId: ToolItem["toolCallId"],
  update: (item: ToolItem) => ToolItem,
): TranscriptState {
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const item = state.byId.get(state.order[index]!);
    if (item?.kind === "tool" && item.toolCallId === toolCallId) {
      return updateItem(state, item.id, (existing) => update(existing as ToolItem));
    }
  }
  return state;
}

/**
 * Drop or clean streaming assistant text that is (or was) only tool-fence
 * surfaces so raw ```tool JSON never sticks on screen once tool cards land.
 */
function discardPendingToolFenceStream(state: TranscriptState): TranscriptState {
  if (!state.pendingAssistantId) return state;
  const pending = state.byId.get(state.pendingAssistantId);
  if (!pending || pending.kind !== "assistant") {
    return { ...state, pendingAssistantId: undefined };
  }
  const stripped = stripToolCallSurfaces(pending.text).trim();
  if (!stripped) {
    return {
      ...removeItem(state, state.pendingAssistantId),
      pendingAssistantId: undefined,
    };
  }
  if (stripped === pending.text) {
    return state;
  }
  return updateItem(state, state.pendingAssistantId, (item) => ({
    ...(item as AssistantItem),
    text: stripped,
  }));
}

function withSequence(state: TranscriptState, sequence: number): TranscriptState {
  return { ...state, lastSequence: sequence };
}

function appendDelta(
  state: TranscriptState,
  event: AnyAppEvent,
  kind: "assistant" | "thinking",
  text: string,
): TranscriptState {
  const pendingKey = kind === "assistant" ? "pendingAssistantId" : "pendingThinkingId";
  const pendingId = state[pendingKey];
  if (pendingId) {
    return updateItem(state, pendingId, (item) => {
      if (kind === "assistant") {
        // Strip tool fences from the cumulative stream so raw JSON never paints.
        const nextText = stripToolCallSurfaces(
          (item as AssistantItem).text + text,
        );
        return { ...(item as AssistantItem), text: nextText };
      }
      return {
        ...(item as ThinkingItem),
        content: (item as ThinkingItem).content + text,
      };
    });
  }
  const id = `${kind}-${event.id}`;
  const base = {
    id,
    sequence: event.sequence,
    turnId: event.turnId,
    timestamp: event.timestamp,
  };
  if (kind === "assistant") {
    const nextText = stripToolCallSurfaces(text);
    // Fence-only start of a stream: hold an empty pending row so later prose
    // can still attach; tool-call events will discard empty fences.
    const item: TranscriptItem = {
      ...base,
      kind: "assistant",
      text: nextText,
      streaming: true,
    };
    return { ...appendItem(state, item), [pendingKey]: id } as TranscriptState;
  }
  const item: TranscriptItem = {
    ...base,
    kind: "thinking",
    content: text,
    streaming: true,
  };
  // Streaming thinking stays in append order (after prior responses). Reordering
  // is only for late one-shot thinking-block finalizes (see finalizeMessage).
  return { ...appendItem(state, item), [pendingKey]: id } as TranscriptState;
}

function finalizeMessage(
  state: TranscriptState,
  event: AnyAppEvent,
  kind: "assistant" | "thinking",
  text: string,
): TranscriptState {
  const pendingKey = kind === "assistant" ? "pendingAssistantId" : "pendingThinkingId";
  const pendingId = state[pendingKey];
  let next = state;
  /** Thinking that was already open via thinking-delta (vs one-shot block). */
  let hadStreamingThinking = false;
  let thinkingId: string | undefined;
  let assistantId: string | undefined;
  if (pendingId) {
    next = updateItem(next, pendingId, (item) =>
      kind === "assistant"
        ? { ...(item as AssistantItem), text, streaming: false }
        : { ...(item as ThinkingItem), content: text, streaming: false },
    );
    if (kind === "thinking") {
      thinkingId = pendingId;
      hadStreamingThinking = true;
    } else {
      assistantId = pendingId;
    }
  } else {
    const id = `${kind}-${event.id}`;
    const base = {
      id,
      sequence: event.sequence,
      turnId: event.turnId,
      timestamp: event.timestamp,
    };
    const item: TranscriptItem =
      kind === "assistant"
        ? { ...base, kind: "assistant", text, streaming: false }
        : { ...base, kind: "thinking", content: text, streaming: false };
    next = appendItem(next, item);
    if (kind === "thinking") thinkingId = id;
    else assistantId = id;
  }
  next = { ...next, [pendingKey]: undefined };
  // Repair answer-then-think order without stacking every think before A1.
  if (thinkingId) {
    next = repairThinkingBeforePrecedingAssistant(
      next,
      thinkingId,
      event.turnId,
      /* allowMovePastFinalizedAssistant */ !hadStreamingThinking,
    );
  } else if (assistantId) {
    next = repairTrailingThinkingForAssistant(next, assistantId, event.turnId);
  }
  return next;
}

function pushNotice(
  state: TranscriptState,
  event: AnyAppEvent,
  level: NoticeLevel,
  text: string,
): TranscriptState {
  return appendItem(state, {
    id: `notice-${event.id}`,
    sequence: event.sequence,
    turnId: event.turnId,
    timestamp: event.timestamp,
    kind: "notice",
    level,
    text,
  });
}

function closePending(state: TranscriptState): TranscriptState {
  let next = state;
  if (next.pendingAssistantId) {
    next = updateItem(next, next.pendingAssistantId, (item) => ({
      ...(item as AssistantItem),
      streaming: false,
    }));
    next = { ...next, pendingAssistantId: undefined };
  }
  if (next.pendingThinkingId) {
    next = updateItem(next, next.pendingThinkingId, (item) => ({
      ...(item as ThinkingItem),
      streaming: false,
    }));
    next = { ...next, pendingThinkingId: undefined };
  }
  return next;
}

function sameTurn(
  item: TranscriptItem,
  turnId: TranscriptItem["turnId"],
): boolean {
  if (turnId !== undefined) return item.turnId === turnId;
  return item.turnId === undefined;
}

/**
 * If thinking sits after a same-turn assistant with no tool cards between them,
 * optionally move it before that assistant.
 *
 * - One-shot late thinking-block (allowMovePastFinalizedAssistant): always
 *   pull above the preceding response (classic stripThinking-after-prose).
 * - Streamed thinking: only pull above an assistant that is **still streaming**
 *   (answer-then-think in the same step). Streamed think after a *finished*
 *   response is the next step (A1 → T2 → A2) and must stay put.
 * - Tool between assistant and thinking: never cross (A1 → tools → T2).
 */
function repairThinkingBeforePrecedingAssistant(
  state: TranscriptState,
  thinkingId: string,
  turnId: TranscriptItem["turnId"],
  allowMovePastFinalizedAssistant: boolean,
): TranscriptState {
  const thinkingIdx = state.order.indexOf(thinkingId);
  if (thinkingIdx < 0) return state;
  for (let i = thinkingIdx - 1; i >= 0; i -= 1) {
    const id = state.order[i]!;
    const item = state.byId.get(id);
    if (!item || !sameTurn(item, turnId)) continue;
    if (item.kind === "tool") return state;
    if (item.kind === "assistant") {
      const assistant = item as AssistantItem;
      if (assistant.streaming || allowMovePastFinalizedAssistant) {
        return moveItemBefore(state, thinkingId, id);
      }
      return state;
    }
  }
  return state;
}

/**
 * When an assistant finalizes, pull same-turn thinking that is still after it
 * with no tools between (covers races where thinking-block lands after
 * assistant-message). Only moves thinking that is still streaming or was
 * already finalized for this step — never pulls step-2 thinking across tools.
 */
function repairTrailingThinkingForAssistant(
  state: TranscriptState,
  assistantId: string,
  turnId: TranscriptItem["turnId"],
): TranscriptState {
  const assistantIdx = state.order.indexOf(assistantId);
  if (assistantIdx < 0) return state;
  let next = state;
  const toMove: string[] = [];
  for (let i = assistantIdx + 1; i < next.order.length; i += 1) {
    const id = next.order[i]!;
    const item = next.byId.get(id);
    if (!item || !sameTurn(item, turnId)) continue;
    if (item.kind === "tool" || item.kind === "assistant") break;
    if (item.kind === "thinking") toMove.push(id);
  }
  for (const thinkingId of toMove) {
    next = moveItemBefore(next, thinkingId, assistantId);
  }
  return next;
}

/** Close open thinking so tool cards never sit under a still-streaming block. */
function closePendingThinking(state: TranscriptState): TranscriptState {
  if (!state.pendingThinkingId) return state;
  const next = updateItem(state, state.pendingThinkingId, (item) => ({
    ...(item as ThinkingItem),
    streaming: false,
  }));
  return { ...next, pendingThinkingId: undefined };
}

export function applyAppEvent(state: TranscriptState, event: AnyAppEvent): TranscriptState {
  if (event.sequence <= state.lastSequence) return state;
  const withSeq = withSequence(state, event.sequence);
  switch (event.type) {
    case "turn-started": {
      // Backend-only directives (implement/revision) pass displayPrompt=null.
      const display =
        event.payload.displayPrompt !== undefined
          ? event.payload.displayPrompt
          : event.payload.prompt;
      if (display === null || display === "") {
        return withSeq;
      }
      return appendItem(withSeq, {
        id: `user-${event.id}`,
        sequence: event.sequence,
        turnId: event.turnId,
        timestamp: event.timestamp,
        kind: "user",
        text: display,
      });
    }

    case "status":
      return { ...withSeq, runningStatus: event.payload.text };

    case "assistant-delta":
      return {
        ...appendDelta(withSeq, event, "assistant", event.payload.text),
        runningStatus: "responding",
      };

    case "assistant-message": {
      // Never finalize a Response card that is only tool-call fences.
      const text = stripToolCallSurfaces(event.payload.text).trim();
      if (!text || isToolFenceOnlyText(event.payload.text)) {
        if (withSeq.pendingAssistantId) {
          return {
            ...removeItem(withSeq, withSeq.pendingAssistantId),
            pendingAssistantId: undefined,
          };
        }
        return withSeq;
      }
      return finalizeMessage(withSeq, event, "assistant", text);
    }

    case "thinking-delta":
      return {
        ...appendDelta(withSeq, event, "thinking", event.payload.text),
        runningStatus: "thinking",
      };

    case "thinking-block":
      return finalizeMessage(withSeq, event, "thinking", event.payload.content);

    case "notice":
      // Chrome feedback only — composition-root surfaces these as toasts.
      // Never append INFO/WARN rows into the chat (inflates history item counts).
      return withSeq;

    case "tool-call": {
      // Close open streams so cards never interleave under live thinking /
      // raw fence text. Then append the tool row (thinking → response → tools).
      // Status starts as "queued" until tool-started — so dns/http don't look
      // "running" while stuck behind a long pentest.recon/nmap.
      const cleaned = discardPendingToolFenceStream(closePendingThinking(withSeq));
      const item: ToolItem = {
        // Occurrence id stays unique even if the agent reuses tool-1 next turn.
        id: `tool-${event.id}`,
        sequence: event.sequence,
        turnId: event.turnId,
        timestamp: event.timestamp,
        kind: "tool",
        toolCallId: event.payload.toolCallId,
        name: event.payload.name,
        argsDisplay: event.payload.argsDisplay,
        status: "queued",
        exitCode: undefined,
        summary: undefined,
        artifactPath: undefined,
        reason: undefined,
        outputBytes: 0,
        fileChanges: undefined,
      };
      return {
        ...appendItem(cleaned, item),
        // Don't set activity to this name yet — card is only queued.
        runningStatus: withSeq.runningStatus ?? "preparing tools",
      };
    }

    case "tool-started": {
      let startedName: string | undefined;
      for (let i = withSeq.order.length - 1; i >= 0; i -= 1) {
        const it = withSeq.byId.get(withSeq.order[i]!);
        if (it?.kind === "tool" && it.toolCallId === event.payload.toolCallId) {
          startedName = it.name;
          break;
        }
      }
      return {
        ...updateToolItem(withSeq, event.payload.toolCallId, (item) => ({
          ...item,
          status: item.status === "queued" ? "running" : item.status,
        })),
        runningStatus: startedName ?? withSeq.runningStatus,
      };
    }

    case "tool-output":
      return updateToolItem(withSeq, event.payload.ref.toolCallId, (item) => ({
        ...item,
        outputBytes: event.payload.ref.totalBytes,
      }));

    case "tool-result":
      return updateToolItem(withSeq, event.payload.toolCallId, (item) => ({
        ...item,
        status: event.payload.ok ? "ok" : "failed",
        exitCode: event.payload.exitCode,
        summary: event.payload.summary,
        artifactPath: event.payload.artifactPath,
        fileChanges: event.payload.fileChanges ?? item.fileChanges,
      }));

    case "tool-blocked":
      return updateToolItem(withSeq, event.payload.toolCallId, (item) => ({
        ...item,
        status: "blocked",
        reason: event.payload.reason,
      }));

    case "compacted":
      return appendItem(withSeq, {
        id: `compacted-${event.id}`,
        sequence: event.sequence,
        turnId: event.turnId,
        timestamp: event.timestamp,
        kind: "compacted",
        summary: event.payload.summary,
        beforeTokens: event.payload.beforeTokens,
        afterTokens: event.payload.afterTokens,
      });

    case "turn-ended":
      return { ...closePending(withSeq), runningStatus: undefined };

    case "turn-aborted":
      return pushNotice(
        { ...closePending(withSeq), runningStatus: undefined },
        event,
        "warn",
        "Turn aborted.",
      );

    case "turn-error":
      return pushNotice(
        { ...closePending(withSeq), runningStatus: undefined },
        event,
        "error",
        event.payload.message,
      );

    case "plan-updated":
    case "confirm-requested":
    case "token-usage":
      // SessionController records usage; transcript does not need a card.
      return withSeq;

    default: {
      const unreachable: never = event;
      throw new Error(`unhandled AppEvent: ${JSON.stringify(unreachable)}`);
    }
  }
}
