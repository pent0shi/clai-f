import { describe, expect, it } from "vitest";
import {
  buildContextBreakdown,
  contextBreakdownAuditPayload,
} from "../src/agent/context-breakdown.js";
import type { ChatMessage, ToolDefinition } from "../src/types.js";

const sampleTools: ToolDefinition[] = [
  {
    name: "fs.read",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

describe("context breakdown", () => {
  it("attributes system, user, assistant, and tool roles", () => {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: "# ROLE\nCURRENT MODE: AGENT\nOUTCOME CONTRACT\nBe helpful.",
      },
      {
        role: "system",
        content: "ACTIVE PLAN\ngoal: ship feature\nstatus=approved",
      },
      {
        role: "system",
        content: "ENGAGEMENT SCOPE\ntargets: lab.example.com",
      },
      {
        role: "system",
        content: "SESSION STATE / WORKING MEMORY\ngoal: ship feature",
      },
      {
        role: "system",
        content:
          "Session memory from compacted earlier turns:\n## User goals\n- build app",
      },
      { role: "user", content: "implement the todo app" },
      {
        role: "assistant",
        content: "I'll start.",
        toolCalls: [{ id: "1", name: "fs.read", arguments: { path: "a.ts" } }],
      },
      {
        role: "tool",
        content: "export const x = 1;",
        toolCallId: "1",
        name: "fs.read",
      },
    ];

    const b = buildContextBreakdown(messages, sampleTools);
    expect(b.messageCount).toBe(8);
    expect(b.systemMessageCount).toBe(5);
    expect(b.userMessageCount).toBe(1);
    expect(b.assistantMessageCount).toBe(1);
    expect(b.toolMessageCount).toBe(1);
    expect(b.systemParts.planTokens).toBeGreaterThan(0);
    expect(b.systemParts.scopeTokens).toBeGreaterThan(0);
    expect(b.systemParts.sessionStateTokens).toBeGreaterThan(0);
    expect(b.systemParts.compactionMemoryTokens).toBeGreaterThan(0);
    expect(b.systemParts.constitutionTokens).toBeGreaterThan(0);
    expect(b.toolSchemaTokens).toBeGreaterThan(0);
    expect(b.toolDefinitionCount).toBe(1);
    expect(b.estimatedTotalTokens).toBeGreaterThan(b.systemTokens);

    const payload = contextBreakdownAuditPayload(b);
    expect(payload.planTokens).toBe(b.systemParts.planTokens);
    expect(payload).not.toHaveProperty("content");
    // No raw prompt text leaked into the flat payload.
    expect(JSON.stringify(payload)).not.toContain("implement the todo");
  });

  it("handles empty messages", () => {
    const b = buildContextBreakdown([]);
    expect(b.estimatedTotalTokens).toBe(0);
    expect(b.messageCount).toBe(0);
    expect(b.toolDefinitionCount).toBe(0);
  });
});
