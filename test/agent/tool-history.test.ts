import { describe, expect, it } from "vitest";
import {
  allToolCallsHaveResults,
  appendAssistantWithTools,
  appendToolResult,
  expandKeepStartForToolPairs,
  fillMissingToolResults,
  hasOrphanToolMessages,
  missingToolResultIds,
} from "../../src/agent/tool-history.js";
import type { ChatMessage, NativeToolCall } from "../../src/types.js";

describe("tool-history", () => {
  it("appends assistant then tools with ids", () => {
    const messages: ChatMessage[] = [];
    appendAssistantWithTools(messages, "working", [
      { id: "c1", name: "fs.write", args: { path: "a", content: "b" } },
    ]);
    appendToolResult(messages, "c1", "Wrote a", "fs.write", true);
    expect(messages[0]!.role).toBe("assistant");
    expect(messages[0]!.toolCalls?.[0]!.id).toBe("c1");
    expect(messages[1]!.role).toBe("tool");
    expect(messages[1]!.toolCallId).toBe("c1");
    expect(messages[1]!.ok).toBe(true);
    expect(hasOrphanToolMessages(messages)).toBe(false);
    expect(allToolCallsHaveResults(messages)).toBe(true);
  });

  it("detects orphan tool messages", () => {
    const messages: ChatMessage[] = [
      { role: "tool", content: "x", toolCallId: "missing" },
    ];
    expect(hasOrphanToolMessages(messages)).toBe(true);
  });

  it("allows empty text with tools", () => {
    const messages: ChatMessage[] = [];
    appendAssistantWithTools(messages, "", [
      { id: "c1", name: "fs.list", args: {} },
    ]);
    expect(messages[0]!.content).toBe("");
    expect(messages[0]!.toolCalls).toHaveLength(1);
  });

  it("expands keep window to include tool pairs", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "fs.read", args: { path: "a" } }],
      },
      { role: "tool", toolCallId: "c1", content: "data" },
      { role: "user", content: "u2" },
    ];
    const start = expandKeepStartForToolPairs(messages, 3);
    expect(start).toBeLessThanOrEqual(2);
  });

  it("fillMissingToolResults pairs deferred/omitted ids (P2-4)", () => {
    const calls: NativeToolCall[] = [
      { id: "a", name: "dns.lookup", args: { target: "x" } },
      { id: "b", name: "plan.create", args: { goal: "g", tasks: ["t"] } },
      { id: "c", name: "fs.write", args: { path: "p", content: "x" } },
    ];
    const messages: ChatMessage[] = [];
    appendAssistantWithTools(messages, "", calls);
    // Only first executed
    appendToolResult(messages, "a", "ok dns", "dns.lookup", true);
    expect(missingToolResultIds(messages).sort()).toEqual(["b", "c"]);
    expect(allToolCallsHaveResults(messages)).toBe(false);

    const filled = fillMissingToolResults(
      messages,
      calls,
      "Deferred — plan.create must wait until reconnaissance results exist.",
    );
    expect(filled).toBe(2);
    expect(missingToolResultIds(messages)).toEqual([]);
    expect(allToolCallsHaveResults(messages)).toBe(true);
    expect(hasOrphanToolMessages(messages)).toBe(false);
    const toolMsgs = messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(3);
    expect(toolMsgs.every((m) => Boolean(m.toolCallId))).toBe(true);
    expect(toolMsgs[1]!.ok).toBe(false);
    expect(toolMsgs[1]!.content).toMatch(/Deferred/);
  });

  it("fillMissing is a no-op when already paired", () => {
    const calls: NativeToolCall[] = [
      { id: "a", name: "fs.read", args: { path: "x" } },
    ];
    const messages: ChatMessage[] = [];
    appendAssistantWithTools(messages, "", calls);
    appendToolResult(messages, "a", "data", "fs.read", true);
    expect(fillMissingToolResults(messages, calls)).toBe(0);
    expect(messages.filter((m) => m.role === "tool")).toHaveLength(1);
  });

  it("BoundCall-style parallel id order is stable", () => {
    // Simulate runner BoundCall recording in document order after Promise.all.
    const bound = [
      { index: 0, id: "id-0", name: "dns.lookup" },
      { index: 1, id: "id-1", name: "whois.lookup" },
      { index: 2, id: "id-2", name: "http.fetch" },
    ];
    const messages: ChatMessage[] = [];
    appendAssistantWithTools(
      messages,
      "",
      bound.map((b) => ({ id: b.id, name: b.name, args: {} })),
    );
    // Parallel completion order shuffled, but we record by bound index order.
    const resultsShuffled = [
      { index: 2, content: "http" },
      { index: 0, content: "dns" },
      { index: 1, content: "whois" },
    ];
    for (const b of bound) {
      const r = resultsShuffled.find((x) => x.index === b.index)!;
      appendToolResult(messages, b.id, r.content, b.name, true);
    }
    const tools = messages.filter((m) => m.role === "tool");
    expect(tools.map((t) => t.toolCallId)).toEqual(["id-0", "id-1", "id-2"]);
    expect(allToolCallsHaveResults(messages)).toBe(true);
  });
});
