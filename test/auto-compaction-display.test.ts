import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPACTION_MAP_MAX_COMPLETION_TOKENS } from "../src/agent/compaction-summary.js";
import { runAgent } from "../src/modes/agent.js";
import { deletePlan } from "../src/store/plan.js";
import type { AgentEvent } from "../src/agent/events.js";
import type { ChatMessage } from "../src/types.js";

const stream = vi.fn();
const complete = vi.fn();
const runTool = vi.fn();

vi.mock("../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/llm/router.js")>();
  return {
    ...actual,
    streamWithProvider: (req: unknown, onToken: (t: string) => void) =>
      stream(req, onToken),
    completeWithProvider: (req: unknown) => complete(req),
  };
});

vi.mock("../src/tools/registry.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/tools/registry.js")>();
  return {
    ...actual,
    runToolCall: (call: unknown, opts: unknown) => runTool(call, opts),
  };
});

vi.mock("../src/commands/providers.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../src/commands/providers.js")>();
  return { ...actual, ensureProviderConfigured: async () => {} };
});

const SUMMARY_KEYWORD = "PostgreSQL";
const SUMMARY_TEXT = `User asked to set up a ${SUMMARY_KEYWORD} cluster with replication. Decisions: use ${SUMMARY_KEYWORD} 15, streaming replication. Work completed: installed binaries, initialized data dir. Remaining work: configure replication slots and failover.`;

describe("auto-compaction display (Chunk 3)", () => {
  beforeEach(async () => {
    stream.mockReset();
    complete.mockReset();
    runTool.mockReset();
    await deletePlan("session-compaction").catch(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "emits a compacted event carrying the actual summary text when auto-compaction fires",
    async () => {
      // Build a history large enough that estimateMessagesTokens > 60_000
      // (AUTO_COMPACT_TOKEN_BUDGET). 240 KB of content / 4 chars/token ~= 60_000.
      const history: ChatMessage[] = [
        { role: "system", content: "system prompt" },
      ];
      for (let i = 0; i < 60; i += 1) {
        const role: ChatMessage["role"] = i % 2 === 0 ? "user" : "assistant";
        history.push({
          role,
          content: `${role}-${i} ${"x".repeat(12_000)}`,
        });
      }

      stream.mockImplementation(
        (
          req: { messages?: Array<{ role: string; content: string }> },
          onToken: (t: string) => void,
        ) => {
          const isCompaction = req.messages?.[0]?.content
            .toLowerCase()
            .includes("continuation memory");
          const rawText = isCompaction
            ? `<think>private chain of thought</think>${SUMMARY_TEXT}`
            : "All set; nothing else to do.";
          if (isCompaction) {
            onToken("<thi");
            onToken("nk>private chain of thought</think>");
            onToken(SUMMARY_TEXT.slice(0, 60));
            onToken(SUMMARY_TEXT.slice(60));
          } else {
            onToken(rawText);
          }
          return Promise.resolve({
            text: rawText,
            provider: "nvidia",
            model: "test-model",
          });
        },
      );

      const events: AgentEvent[] = [];
      await runAgent("continue with the next step", {
        session: {
          sessionId: "session-compaction",
          planApproved: { value: false },
          allow: new Set(),
          pentestAuthorized: { value: false },
        } as any,
        history,
        maxSteps: 1,
        onEvent: (e) => events.push(e),
      });

      const started = events.find((e) => e.type === "compaction-start");
      const deltas = events.filter((e) => e.type === "compaction-delta");
      const compacted = events.find((e) => e.type === "compaction-completed");
      expect(started, "expected compaction lifecycle to start").toBeDefined();
      expect(deltas.length).toBeGreaterThan(0);
      const streamedSummary = deltas
        .map((event) =>
          event.type === "compaction-delta" ? event.text : "",
        )
        .join("");
      expect(streamedSummary).toBe(SUMMARY_TEXT);
      expect(streamedSummary).not.toMatch(/<\/?think|private chain/i);
      expect(
        compacted,
        "expected the streaming compaction to complete",
      ).toBeDefined();

      if (
        started?.type === "compaction-start" &&
        compacted?.type === "compaction-completed"
      ) {
        expect(compacted.id).toBe(started.id);
        expect(deltas.every((event) => event.type !== "compaction-delta" || event.id === started.id)).toBe(true);
        expect(compacted.summary).toContain(SUMMARY_KEYWORD);
        expect(compacted.summary).toMatch(/cluster with replication/i);
        expect(typeof compacted.beforeTokens).toBe("number");
        expect(typeof compacted.afterTokens).toBe("number");
        expect(compacted.beforeTokens).toBeGreaterThan(0);
        expect(compacted.afterTokens).toBeGreaterThan(0);
        expect(compacted.afterTokens).toBeLessThanOrEqual(compacted.beforeTokens);
      }

      // Sanity check: the summary keyword must NOT only appear in stats —
      // verify it's present in a non-stats payload (the compacted event).
      const statsEvents = events.filter((e) => e.type === "notice");
      for (const ev of statsEvents) {
        if (ev.type === "notice") {
          expect(ev.text).not.toContain(SUMMARY_KEYWORD);
        }
      }
    },
    30_000,
  );

  it(
    "retries a reasoning-only auto-compaction summary without streaming hidden reasoning",
    async () => {
      const history: ChatMessage[] = [
        { role: "system", content: "system prompt" },
      ];
      for (let i = 0; i < 60; i += 1) {
        const role: ChatMessage["role"] = i % 2 === 0 ? "user" : "assistant";
        history.push({
          role,
          content: `${role}-${i} ${"x".repeat(12_000)}`,
        });
      }

      stream.mockImplementation(
        (
          req: { messages?: Array<{ role: string; content: string }> },
          onToken: (token: string) => void,
        ) => {
          const system = req.messages?.[0]?.content ?? "";
          const isCompaction = system.toLowerCase().includes("continuation memory");
          const rawText = isCompaction
            ? "<think>the summary allowance contained only reasoning</think>"
            : "All set; nothing else to do.";
          onToken(rawText);
          return Promise.resolve({
            text: rawText,
            provider: "nvidia",
            model: "thinking-model",
          });
        },
      );
      complete.mockResolvedValue({
        text: SUMMARY_TEXT,
        provider: "nvidia",
        model: "thinking-model",
      });

      const events: AgentEvent[] = [];
      await runAgent("continue with the next step", {
        session: {
          sessionId: "session-compaction",
          planApproved: { value: false },
          allow: new Set(),
          pentestAuthorized: { value: false },
        } as any,
        history,
        maxSteps: 1,
        onEvent: (event) => events.push(event),
      });

      // Long history uses two evidence-preserving map summaries and one final
      // reduce. Each may need the no-thinking retry; this is bounded (never a
      // nested per-chunk fan-out).
      expect(complete).toHaveBeenCalledTimes(3);
      expect(complete.mock.calls[0]?.[0]).toMatchObject({
        maxTokens: COMPACTION_MAP_MAX_COMPLETION_TOKENS,
        temperature: 0,
        thinking: { enabled: false, effort: "none" },
      });
      const streamed = events
        .filter((event) => event.type === "compaction-delta")
        .map((event) => (event.type === "compaction-delta" ? event.text : ""))
        .join("");
      expect(streamed).toBe(SUMMARY_TEXT);
      expect(streamed).not.toMatch(/final allowance|<\/?think/i);
      expect(
        events.some((event) => event.type === "compaction-completed"),
      ).toBe(true);
      expect(events.some((event) => event.type === "compaction-failed")).toBe(
        false,
      );
    },
    30_000,
  );
});
