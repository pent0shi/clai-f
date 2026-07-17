/**
 * Resume helpers: classic/history TranscriptItem + ChatMessage → v2 store shape.
 *
 * History records may carry a full TUI transcript (classic clai) or only the
 * model messages array (older / partial saves). We hydrate both so /history
 * restores prompts, tools, and assistant text — not just a notice.
 */

import type { ChatMessage } from "../../types.js";
import type { TranscriptItem as ClassicTranscriptItem } from "../../tui/state.js";
import { asToolCallId, type ToolCallId } from "../../app/events/app-event.js";
import {
  EMPTY_TRANSCRIPT_STATE,
  type AssistantItem,
  type CompactedItem,
  type NoticeItem,
  type ThinkingItem,
  type ToolItem,
  type ToolStatus,
  type TranscriptItem,
  type TranscriptState,
  type UserItem,
} from "./transcript-types.js";

export interface HydrateResult {
  readonly state: TranscriptState;
  /** Tool outputs to seed into OutputSpool (classic embeds output on the item). */
  readonly toolOutputs: ReadonlyMap<ToolCallId, string>;
}

function mapToolStatus(status: string | undefined): ToolStatus {
  if (
    status === "ok" ||
    status === "running" ||
    status === "blocked" ||
    status === "queued"
  ) {
    return status;
  }
  if (status === "fail" || status === "failed") return "failed";
  return "ok";
}

/** Convert a classic (or mixed) saved transcript into the v2 normalized state. */
export function hydrateFromClassicTranscript(
  items: readonly ClassicTranscriptItem[],
): HydrateResult {
  const order: string[] = [];
  const byId = new Map<string, TranscriptItem>();
  const toolOutputs = new Map<ToolCallId, string>();
  let sequence = 0;

  for (const raw of items) {
    sequence += 1;
    const id = raw.id || `hist-${sequence}`;
    const base = {
      id,
      sequence,
      turnId: undefined as undefined,
      timestamp: sequence,
    };

    switch (raw.kind) {
      case "user": {
        const item: UserItem = { ...base, kind: "user", text: raw.text ?? "" };
        byId.set(id, item);
        order.push(id);
        break;
      }
      case "assistant": {
        const item: AssistantItem = {
          ...base,
          kind: "assistant",
          text: raw.text ?? "",
          streaming: false,
        };
        byId.set(id, item);
        order.push(id);
        break;
      }
      case "thinking": {
        const item: ThinkingItem = {
          ...base,
          kind: "thinking",
          content: raw.content ?? "",
          streaming: false,
        };
        byId.set(id, item);
        order.push(id);
        break;
      }
      case "tool": {
        const toolCallId = asToolCallId(id);
        const status = mapToolStatus(raw.status);
        const output = typeof raw.output === "string" ? raw.output : "";
        if (output) toolOutputs.set(toolCallId, output);
        const rawChanges = (raw as { fileChanges?: unknown }).fileChanges;
        const item: ToolItem = {
          ...base,
          kind: "tool",
          toolCallId,
          name: raw.name ?? "tool",
          argsDisplay: raw.argsDisplay ?? "",
          status: status === "running" ? "ok" : status,
          exitCode: raw.exitCode,
          summary: raw.summary,
          artifactPath: raw.artifactPath,
          reason: undefined,
          outputBytes: Buffer.byteLength(output, "utf8"),
          fileChanges: Array.isArray(rawChanges)
            ? (rawChanges as ToolItem["fileChanges"])
            : undefined,
        };
        byId.set(id, item);
        order.push(id);
        break;
      }
      case "notice": {
        const item: NoticeItem = {
          ...base,
          kind: "notice",
          level: raw.level === "warn" ? "warn" : "info",
          text: raw.text ?? "",
        };
        byId.set(id, item);
        order.push(id);
        break;
      }
      case "compacted": {
        const item: CompactedItem = {
          ...base,
          kind: "compacted",
          summary: raw.summary ?? "Compacted context",
          beforeTokens: 0,
          afterTokens: 0,
        };
        byId.set(id, item);
        order.push(id);
        break;
      }
      case "plan":
        // Plans restore via plan store / Ctrl+H — skip visual plan rows.
        break;
      default:
        break;
    }
  }

  if (order.length === 0) {
    return { state: EMPTY_TRANSCRIPT_STATE, toolOutputs };
  }

  return {
    state: {
      ...EMPTY_TRANSCRIPT_STATE,
      order,
      byId,
      // Historical item.sequence is display metadata only. lastSequence must
      // stay 0 so the live EventSequencer (rebound to 0 on loadHistory) can
      // apply turn-started and the rest of the next turn — otherwise every
      // event with seq <= N is dropped and the new user prompt never appears.
      lastSequence: 0,
    },
    toolOutputs,
  };
}

/**
 * Format tool args for a compact card label when restoring from model history.
 */
function argsDisplayFromToolCall(args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== "object") return "";
  try {
    const json = JSON.stringify(args);
    if (json.length <= 80) return json;
    return `${json.slice(0, 77)}…`;
  } catch {
    return "";
  }
}

/**
 * Fallback when a history row only has model messages (no visual transcript),
 * or when the visual transcript is thinner than the model history (e.g. abort
 * stub saved after tools ran in-memory but never as transcript items).
 *
 * Reconstructs user / assistant bubbles and tool cards from native
 * `toolCalls` + `role: "tool"` pairs so /history still shows commands and
 * outputs when possible.
 */
export function hydrateFromMessages(messages: readonly ChatMessage[]): HydrateResult {
  const order: string[] = [];
  const byId = new Map<string, TranscriptItem>();
  const toolOutputs = new Map<ToolCallId, string>();
  let sequence = 0;

  // Index tool results by toolCallId for pairing with assistant toolCalls.
  const toolResultsById = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId) {
      toolResultsById.set(message.toolCallId, message);
    }
  }

  for (const message of messages) {
    if (message.role === "system" || message.role === "tool") continue;

    if (message.role === "user") {
      sequence += 1;
      const id = `hist-user-${sequence}`;
      const item: UserItem = {
        id,
        sequence,
        turnId: undefined,
        timestamp: sequence,
        kind: "user",
        text: message.content,
      };
      byId.set(id, item);
      order.push(id);
      continue;
    }

    // assistant
    if (message.content.trim()) {
      sequence += 1;
      const id = `hist-asst-${sequence}`;
      const item: AssistantItem = {
        id,
        sequence,
        turnId: undefined,
        timestamp: sequence,
        kind: "assistant",
        text: message.content,
        streaming: false,
      };
      byId.set(id, item);
      order.push(id);
    }

    const calls = message.toolCalls;
    if (!calls?.length) continue;
    for (const call of calls) {
      sequence += 1;
      const toolCallId = asToolCallId(call.id || `hist-tool-${sequence}`);
      const result = toolResultsById.get(call.id);
      const output = result?.content ?? "";
      if (output) toolOutputs.set(toolCallId, output);
      const ok = result?.ok !== false;
      const item: ToolItem = {
        id: String(toolCallId),
        sequence,
        turnId: undefined,
        timestamp: sequence,
        kind: "tool",
        toolCallId,
        name: call.name || result?.name || "tool",
        argsDisplay: argsDisplayFromToolCall(call.args),
        status: result ? (ok ? "ok" : "failed") : "ok",
        exitCode: result ? (ok ? 0 : 1) : undefined,
        summary: undefined,
        artifactPath: undefined,
        reason: undefined,
        outputBytes: Buffer.byteLength(output, "utf8"),
        fileChanges: undefined,
      };
      byId.set(item.id, item);
      order.push(item.id);
    }
  }

  return {
    state: {
      ...EMPTY_TRANSCRIPT_STATE,
      order,
      byId,
      // See hydrateFromClassicTranscript — do not block the live sequencer.
      lastSequence: 0,
    },
    toolOutputs,
  };
}

/**
 * True when the visual transcript is missing the bulk of tool work that still
 * exists in model messages (common after abort-before-save of the UI snapshot).
 */
export function transcriptLooksIncomplete(
  transcriptLen: number,
  messages: readonly ChatMessage[],
): boolean {
  const toolMsgCount = messages.filter((m) => m.role === "tool").length;
  const toolCallCount = messages.reduce(
    (n, m) => n + (m.toolCalls?.length ?? 0),
    0,
  );
  const toolWork = Math.max(toolMsgCount, toolCallCount);
  if (toolWork === 0) return false;
  // Transcript has fewer tool rows than tool results in messages.
  // Callers may also treat a very short transcript vs many messages as incomplete.
  return transcriptLen < toolWork + 1;
}

/**
 * Prefer the richer of classic visual transcript vs message-derived hydrate
 * so /history does not drop tools when only one representation survived.
 */
export function hydrateSessionVisual(
  transcript: readonly ClassicTranscriptItem[] | undefined,
  messages: readonly ChatMessage[],
): HydrateResult {
  const fromMessages = hydrateFromMessages(messages);
  if (!transcript || transcript.length === 0) {
    return fromMessages;
  }
  const fromClassic = hydrateFromClassicTranscript(transcript);
  const classicToolCount = [...fromClassic.state.byId.values()].filter(
    (i) => i.kind === "tool",
  ).length;
  const messageToolCount = [...fromMessages.state.byId.values()].filter(
    (i) => i.kind === "tool",
  ).length;
  // Prefer the snapshot with more tool cards (real work); break ties with
  // more total items, then classic (preserves thinking/notices).
  if (messageToolCount > classicToolCount) return fromMessages;
  if (fromMessages.state.order.length > fromClassic.state.order.length * 1.5) {
    return fromMessages;
  }
  return fromClassic;
}

/**
 * Snapshot the live v2 transcript into the classic shape for history.db so
 * /history can restore tools + prompts next time (parity with classic clai).
 */
export function serializeForHistory(
  state: TranscriptState,
  toolOutput: (toolCallId: ToolCallId) => string,
): ClassicTranscriptItem[] {
  const out: ClassicTranscriptItem[] = [];
  for (const id of state.order) {
    const item = state.byId.get(id);
    if (!item) continue;
    switch (item.kind) {
      case "user":
        out.push({ kind: "user", id: item.id, text: item.text, done: true });
        break;
      case "assistant":
        out.push({
          kind: "assistant",
          id: item.id,
          text: item.text,
          streaming: false,
          done: true,
        });
        break;
      case "thinking":
        out.push({
          kind: "thinking",
          id: item.id,
          content: item.content,
          done: true,
        });
        break;
      case "tool": {
        const output = toolOutput(item.toolCallId);
        out.push({
          kind: "tool",
          id: item.id,
          name: item.name,
          argsDisplay: item.argsDisplay,
          output,
          status:
            item.status === "failed"
              ? "fail"
              : item.status === "running" || item.status === "queued"
                ? "ok"
                : item.status,
          exitCode: item.exitCode,
          summary: item.summary,
          artifactPath: item.artifactPath,
          ...(item.fileChanges ? { fileChanges: item.fileChanges } : {}),
          done: true,
        });
        break;
      }
      case "notice":
        out.push({
          kind: "notice",
          id: item.id,
          level: item.level === "error" ? "warn" : item.level,
          text: item.text,
          done: true,
        });
        break;
      case "compacted":
        out.push({
          kind: "compacted",
          id: item.id,
          summary: item.summary,
          originalItems: [],
          done: true,
        });
        break;
      default:
        break;
    }
  }
  return out;
}

/** Strip the model framing prefix for display in the compacted card. */
export function displayCompactSummary(summary: string): string {
  const prefixes = [
    "Session memory from compacted earlier turns:\n\n",
    "Session memory from compacted earlier turns:",
    "Session memory\n\n",
  ];
  let text = summary;
  for (const prefix of prefixes) {
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length);
      break;
    }
  }
  return text.trim();
}
