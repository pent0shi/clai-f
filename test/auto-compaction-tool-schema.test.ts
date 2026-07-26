import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/modes/agent.js";
import { deletePlan } from "../src/store/plan.js";
import { autoCompactTriggerTokens } from "../src/agent/reliability-policy.js";
import { estimateMessagesTokens } from "../src/agent/context-manager.js";
import { buildContextBreakdown } from "../src/agent/context-breakdown.js";
import { getToolDefinitions } from "../src/tools/definitions.js";
import type { AgentEvent } from "../src/agent/events.js";
import type { ChatMessage, ToolDefinition } from "../src/types.js";

const stream = vi.fn();
const complete = vi.fn();

vi.mock("../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/llm/router.js")>();
  return {
    ...actual,
    streamWithProvider: (req: unknown, onToken: (text: string) => void) =>
      stream(req, onToken),
    completeWithProvider: (req: unknown) => complete(req),
  };
});

vi.mock("../src/commands/providers.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../src/commands/providers.js")>();
  return { ...actual, ensureProviderConfigured: async () => {} };
});

vi.mock("../src/tools/definitions.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../src/tools/definitions.js")>();
  const schemaHeavyTool: ToolDefinition = {
    name: "fs.read",
    wireName: "fs_read",
    description: `Schema-heavy tool fixture: ${"x".repeat(80_000)}`,
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    readOnly: true,
  };
  return {
    ...actual,
    getToolDefinitions: () => [schemaHeavyTool],
    getCompactToolDefinitions: () => [schemaHeavyTool],
  };
});

function streamReply(text: string) {
  return (_req: unknown, onToken: (token: string) => void) => {
    onToken(text);
    return Promise.resolve({ text, provider: "nvidia", model: "test-model" });
  };
}

describe("auto-compaction native tool schemas", () => {
  beforeEach(async () => {
    stream.mockReset();
    complete.mockReset();
    await deletePlan("session-tool-schema-compaction").catch(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("compacts when attached native-tool schemas push the next request past the trigger", async () => {
    const history: ChatMessage[] = [{ role: "system", content: "history" }];
    for (let i = 0; i < 11; i += 1) {
      history.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `${i}: ${"history ".repeat(2_400)}`,
      });
    }

    const trigger = autoCompactTriggerTokens();
    const messageOnlyTokens = estimateMessagesTokens(history);
    const requestTokens = buildContextBreakdown(
      history,
      getToolDefinitions(),
    ).estimatedTotalTokens;
    expect(messageOnlyTokens).toBeLessThan(trigger);
    expect(requestTokens).toBeGreaterThan(trigger);

    stream.mockImplementation(streamReply("All set."));
    complete.mockResolvedValue({
      text:
        "The session has prior work. Preserve the decisions and continue from the latest request.",
      provider: "nvidia",
      model: "test-model",
    });

    const events: AgentEvent[] = [];
    await runAgent("continue", {
      session: {
        sessionId: "session-tool-schema-compaction",
        planApproved: { value: false },
        allow: new Set(),
        pentestAuthorized: { value: false },
      } as any,
      history,
      maxSteps: 1,
      onEvent: (event) => events.push(event),
    });

    const compactedIndex = events.findIndex(
      (event) => event.type === "compacted",
    );
    const firstStreamStatusIndex = events.findIndex(
      (event) => event.type === "status" && event.text === "waiting for model",
    );
    expect(compactedIndex).toBeGreaterThanOrEqual(0);
    expect(firstStreamStatusIndex).toBeGreaterThan(compactedIndex);
    expect(stream).toHaveBeenCalled();

    const compacted = events[compactedIndex];
    if (compacted?.type === "compacted") {
      expect(compacted.beforeTokens).toBeGreaterThan(trigger);
      expect(compacted.afterTokens).toBeLessThan(compacted.beforeTokens);
    }
  });
});
