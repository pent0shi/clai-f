import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../src/agent/events.js";
import type { ChatMessage } from "../../src/types.js";
import { deletePlan } from "../../src/store/plan.js";

const stream = vi.fn();
const complete = vi.fn();
const runTool = vi.fn();

vi.mock("../../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/llm/router.js")>();
  return {
    ...actual,
    streamWithProvider: (req: unknown, onToken: (t: string) => void) =>
      stream(req, onToken),
    completeWithProvider: (req: unknown) => complete(req),
  };
});

vi.mock("../../src/tools/registry.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/tools/registry.js")>();
  return {
    ...actual,
    runToolCall: (call: unknown, opts: unknown) => runTool(call, opts),
  };
});

vi.mock("../../src/commands/providers.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/commands/providers.js")>();
  return { ...actual, ensureProviderConfigured: async () => {} };
});

interface CapturedRound {
  readonly maxTokens: number | undefined;
  readonly messages: readonly string[];
}

function makeSession(id: string) {
  return {
    sessionId: id,
    planApproved: { value: false },
    allow: new Set(),
    pentestAuthorized: { value: false },
  } as any;
}

describe("truncated thinking continuation", () => {
  const captured: CapturedRound[] = [];
  let roundResults: Array<(req: any) => any> = [];

  beforeEach(async () => {
    captured.length = 0;
    roundResults = [];
    stream.mockReset();
    complete.mockReset();
    runTool.mockReset();
    runTool.mockResolvedValue({ ok: true, output: "tool-output" });
    stream.mockImplementation((req: any, onToken: (t: string) => void) => {
      const messages = (req.messages ?? []) as ChatMessage[];
      captured.push({
        maxTokens: req.maxTokens,
        messages: messages.map(
          (m) => `${m.role}:${typeof m.content === "string" ? m.content : ""}`,
        ),
      });
      const produce = roundResults[captured.length - 1] ?? roundResults[roundResults.length - 1];
      const result = produce!(req);
      if (result.text) onToken(result.text);
      return Promise.resolve(result);
    });
    await deletePlan("session-trunc-think").catch(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("continues a thinking-only round that was cut at the output-token budget instead of nudging from scratch, and doubles the budget", async () => {
    const events: AgentEvent[] = [];
    const { runAgent } = await import("../../src/modes/agent.js");
    roundResults = [
      () => ({
        text: "<think>long chain of thought about raycasting the platform",
        provider: "nvidia",
        model: "test-model",
        finishReason: "length",
        usage: { promptTokens: 5000, completionTokens: 12_288, totalTokens: 17_288, exact: true },
      }),
      () => ({
        text: "Answer produced after continuation.",
        provider: "nvidia",
        model: "test-model",
        finishReason: "stop",
      }),
    ];

    await runAgent("build something", {
      session: makeSession("session-trunc-think"),
      history: [{ role: "system", content: "sys" } as ChatMessage],
      maxSteps: 6,
      onEvent: (e) => events.push(e),
    });

    expect(captured.length).toBeGreaterThanOrEqual(2);
    expect(captured[1]!.maxTokens).toBe(
      Math.min(65_536, (captured[0]!.maxTokens ?? 0) * 2),
    );
    const roundTwoMessages = captured[1]!.messages;
    expect(
      roundTwoMessages.some(
        (m) => m.startsWith("assistant:") && m.includes("chain of thought about raycasting"),
      ),
      "the truncated round's partial content must be preserved in history so the model can continue from it",
    ).toBe(true);
    expect(
      roundTwoMessages.some(
        (m) => m.startsWith("user:") && m.includes("cut off by the output token limit"),
      ),
    ).toBe(true);
    expect(
      roundTwoMessages.some((m) => m.startsWith("user:") && m.includes("No visible output.")),
      "truncation must not be treated as an empty response",
    ).toBe(false);
  });

  it("detects truncation from usage alone when the gateway omits finish_reason", async () => {
    const { runAgent } = await import("../../src/modes/agent.js");
    let budget = 0;
    roundResults = [
      (req) => {
        budget = req.maxTokens;
        return {
          text: "<think>reasoning stream that consumed the whole completion budget",
          provider: "nvidia",
          model: "test-model",
          usage: { promptTokens: 500, completionTokens: req.maxTokens, totalTokens: 500 + req.maxTokens, exact: true },
        };
      },
      () => ({
        text: "done",
        provider: "nvidia",
        model: "test-model",
        finishReason: "stop",
      }),
    ];

    await runAgent("build something", {
      session: makeSession("session-trunc-think"),
      history: [{ role: "system", content: "sys" } as ChatMessage],
      maxSteps: 6,
      onEvent: () => {},
    });

    expect(captured.length).toBeGreaterThanOrEqual(2);
    expect(captured[1]!.maxTokens).toBe(Math.min(65_536, budget * 2));
  });

  it("caps continuations at two and then falls back to the existing empty-retry ladder", async () => {
    const truncate = (req: any) => ({
      text: "<think>always truncated reasoning",
      provider: "nvidia",
      model: "test-model",
      finishReason: "length",
      usage: { promptTokens: 500, completionTokens: req.maxTokens, totalTokens: 500 + req.maxTokens, exact: true },
    });
    roundResults = [truncate, truncate, truncate, truncate, truncate, truncate];
    const { runAgent } = await import("../../src/modes/agent.js");

    const events: AgentEvent[] = [];
    await runAgent("build something", {
      session: makeSession("session-trunc-think"),
      history: [{ role: "system", content: "sys" } as ChatMessage],
      maxSteps: 12,
      onEvent: (e) => events.push(e),
    });

    expect(captured.length).toBeGreaterThanOrEqual(4);
    const notices = events.filter((e) => e.type === "notice");
    expect(
      notices.some((e) => /output token limit/i.test(e.text)),
      "first two truncations continue with a bigger budget",
    ).toBe(true);
    expect(
      events.some((e) => e.type === "status" && /empty/i.test((e as any).text ?? "")) ||
        notices.some((e) => /empty response|no answer/i.test(e.text)),
      "after the cap, the turn must terminate via the existing empty-response ladder rather than continuing forever",
    ).toBe(true);
  });

  it("keeps the plain empty-response path unchanged (no finishReason, no usage)", async () => {
    roundResults = [
      () => ({ text: "", provider: "nvidia", model: "test-model" }),
      () => ({ text: "final answer", provider: "nvidia", model: "test-model", finishReason: "stop" }),
    ];
    const { runAgent } = await import("../../src/modes/agent.js");

    await runAgent("build something", {
      session: makeSession("session-trunc-think"),
      history: [{ role: "system", content: "sys" } as ChatMessage],
      maxSteps: 6,
      onEvent: () => {},
    });

    expect(captured.length).toBeGreaterThanOrEqual(2);
    const roundTwoMessages = captured[1]!.messages;
    expect(roundTwoMessages.some((m) => m.includes("No visible output."))).toBe(true);
    expect(captured[1]!.maxTokens).toBe(captured[0]!.maxTokens);
  });
});
