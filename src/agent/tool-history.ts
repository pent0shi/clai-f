import type { ChatMessage, NativeToolCall } from "../types.js";

/** Append assistant turn that requested tools (must precede tool results). */
export function appendAssistantWithTools(
  messages: ChatMessage[],
  text: string,
  toolCalls: NativeToolCall[],
): void {
  messages.push({
    role: "assistant",
    content: text ?? "",
    ...(toolCalls.length ? { toolCalls } : {}),
  });
}

/** Append a single tool result linked by tool_call_id. */
export function appendToolResult(
  messages: ChatMessage[],
  toolCallId: string,
  content: string,
  name?: string,
  ok?: boolean,
): void {
  messages.push({
    role: "tool",
    content,
    toolCallId,
    ...(name ? { name } : {}),
    ...(typeof ok === "boolean" ? { ok } : {}),
  });
}

/**
 * Whether the message list would orphan a tool result (result without a
 * preceding assistant toolCalls entry that owns the id).
 */
export function hasOrphanToolMessages(messages: ChatMessage[]): boolean {
  const openIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) openIds.add(tc.id);
    }
    if (msg.role === "tool") {
      const id = msg.toolCallId ?? "";
      if (!id || !openIds.has(id)) return true;
    }
  }
  return false;
}

/** Ids on the last assistant toolCalls message that lack a following tool result. */
export function missingToolResultIds(messages: ChatMessage[]): string[] {
  let lastAssistant: ChatMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.toolCalls?.length) {
      lastAssistant = m;
      break;
    }
  }
  if (!lastAssistant?.toolCalls?.length) return [];

  const needed = new Set(lastAssistant.toolCalls.map((tc) => tc.id));
  // Only scan results after that assistant message.
  const start = messages.lastIndexOf(lastAssistant);
  for (let i = start + 1; i < messages.length; i += 1) {
    const m = messages[i]!;
    if (m.role === "tool" && m.toolCallId) needed.delete(m.toolCallId);
    // Stop at next non-tool (next turn).
    if (m.role !== "tool") break;
  }
  return [...needed];
}

/**
 * Append synthetic failed tool results for any assistant toolCalls ids that
 * still lack a role:tool reply (deferred, cancelled, sliced, abort).
 */
export function fillMissingToolResults(
  messages: ChatMessage[],
  toolCalls: NativeToolCall[],
  reason = "Cancelled — not executed this turn.",
): number {
  if (!toolCalls.length) return 0;
  const have = new Set<string>();
  // Collect existing tool results after the last matching assistant.
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (
      m.role === "assistant" &&
      m.toolCalls?.some((tc) => toolCalls.some((t) => t.id === tc.id))
    ) {
      start = i;
      break;
    }
  }
  if (start < 0) return 0;
  for (let i = start + 1; i < messages.length; i += 1) {
    const m = messages[i]!;
    if (m.role === "tool" && m.toolCallId) have.add(m.toolCallId);
    else if (m.role !== "tool") break;
  }

  let filled = 0;
  for (const tc of toolCalls) {
    if (have.has(tc.id)) continue;
    appendToolResult(
      messages,
      tc.id,
      `Tool ${tc.name} result (exit=130, ok=false):\n${reason}`,
      tc.name,
      false,
    );
    have.add(tc.id);
    filled += 1;
  }
  return filled;
}

/**
 * True when every id on every assistant toolCalls has a matching tool result
 * later in the list (no missing pairs). Used by tests and diagnostics.
 */
export function allToolCallsHaveResults(messages: ChatMessage[]): boolean {
  const pending = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) pending.add(tc.id);
    }
    if (msg.role === "tool" && msg.toolCallId) {
      pending.delete(msg.toolCallId);
    }
  }
  return pending.size === 0;
}

/**
 * When compacting, never leave role:tool without its assistant toolCalls.
 * Expand a keep-window start so tool pairs stay intact.
 */
export function expandKeepStartForToolPairs(
  messages: ChatMessage[],
  keepStart: number,
): number {
  let start = keepStart;
  while (start > 0 && messages[start]?.role === "tool") {
    start -= 1;
  }
  // If we landed mid-assistant-with-tools, include that assistant.
  if (
    start > 0 &&
    messages[start]?.role === "assistant" &&
    messages[start]!.toolCalls?.length
  ) {
    // already includes assistant
  } else if (start > 0) {
    // If first kept message is tool, walk back to assistant
    while (
      start > 0 &&
      messages[start - 1]?.role !== "system" &&
      (messages[start]?.role === "tool" ||
        (messages[start - 1]?.role === "assistant" &&
          messages[start - 1]!.toolCalls?.length &&
          messages[start]?.role === "tool"))
    ) {
      if (
        messages[start - 1]?.role === "assistant" &&
        messages[start - 1]!.toolCalls?.length
      ) {
        start -= 1;
        break;
      }
      start -= 1;
    }
  }
  return Math.max(0, start);
}

/**
 * Validate native assistant/tool groups immediately before provider dispatch.
 * Every tool result must belong to the currently open assistant group, ids are
 * unique, and no non-tool message may begin until the whole group is closed.
 */
export function validateToolProtocol(messages: readonly ChatMessage[]): string[] {
  const issues: string[] = [];
  const seenIds = new Set<string>();
  let pending = new Set<string>();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && message.toolCalls?.length) {
      if (pending.size > 0) {
        issues.push(`message ${index}: new assistant tool group before results for ${[...pending].join(", ")}`);
      }
      pending = new Set<string>();
      for (const call of message.toolCalls) {
        if (!call.id) issues.push(`message ${index}: tool call has no id`);
        if (seenIds.has(call.id)) issues.push(`message ${index}: duplicate tool call id ${call.id}`);
        seenIds.add(call.id);
        pending.add(call.id);
      }
      continue;
    }
    if (message.role === "tool") {
      const id = message.toolCallId ?? "";
      if (!id || !pending.has(id)) {
        issues.push(`message ${index}: orphan tool result${id ? ` ${id}` : ""}`);
      } else {
        pending.delete(id);
      }
      continue;
    }
    if (pending.size > 0) {
      issues.push(`message ${index}: non-tool message before results for ${[...pending].join(", ")}`);
      pending.clear();
    }
  }
  if (pending.size > 0) issues.push(`end of history: missing results for ${[...pending].join(", ")}`);
  return issues;
}

export function assertValidToolProtocol(messages: readonly ChatMessage[]): void {
  const issues = validateToolProtocol(messages);
  if (issues.length > 0) throw new Error(`invalid native tool protocol: ${issues.join("; ")}`);
}
