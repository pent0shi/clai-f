import { describe, expect, it } from "vitest";
import {
  asSessionId,
  asToolCallId,
  asTurnId,
  type AnyAppEvent,
} from "../../../src/app/events/app-event.js";
import { createCountingIdFactory, EventSequencer } from "../../../src/app/events/sequencer.js";
import { applyAppEvent } from "../../../src/tui-v2/state/transcript-reducer.js";
import {
  EMPTY_TRANSCRIPT_STATE,
  transcriptItems,
  type AssistantItem,
  type ThinkingItem,
  type ToolItem,
  type TranscriptState,
} from "../../../src/tui-v2/state/transcript-types.js";
import { normalizeSemanticDocument } from "../../../src/tui-v2/state/semantic-document.js";
import { extractTranscriptSemanticDocument } from "../../../src/tui-v2/rendering/transcript-semantic.js";

function fold(events: readonly AnyAppEvent[]): TranscriptState {
  return events.reduce(applyAppEvent, EMPTY_TRANSCRIPT_STATE);
}

function buildSequencer(prefix = "") {
  return new EventSequencer(
    asSessionId("sess-1"),
    createCountingIdFactory(prefix),
    { now: () => 1_700_000_000_000 },
  );
}

describe("transcript reducer (V2-050)", () => {
  it("creates a user item from turn-started", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    const events = [seq.build("turn-started", { prompt: "hello" }, turnId)];
    const state = fold(events);
    expect(state.order).toHaveLength(1);
    const item = transcriptItems(state)[0];
    expect(item).toMatchObject({ kind: "user", text: "hello" });
  });

  it("hides turn-started when displayPrompt is null (implement/revision directives)", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    const events = [
      seq.build(
        "turn-started",
        {
          prompt: "Plan approved. Execute it. Work through pending tasks…",
          displayPrompt: null,
        },
        turnId,
      ),
    ];
    const state = fold(events);
    expect(state.order).toHaveLength(0);
  });

  it("shows short displayPrompt instead of full model prompt for plan revisions", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    const events = [
      seq.build(
        "turn-started",
        {
          prompt: "Plan revision request from the user…\nUser feedback:\nuse glassmorphism",
          displayPrompt: "use glassmorphism",
        },
        turnId,
      ),
    ];
    const state = fold(events);
    expect(transcriptItems(state)[0]).toMatchObject({
      kind: "user",
      text: "use glassmorphism",
    });
  });

  it("coalesces assistant deltas into one streaming item, then finalizes on assistant-message", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    const events: AnyAppEvent[] = [
      seq.build("assistant-delta", { text: "Hel" }, turnId),
      seq.build("assistant-delta", { text: "lo" }, turnId),
    ];
    const streaming = fold(events);
    expect(streaming.order).toHaveLength(1);
    const pending = streaming.byId.get(streaming.pendingAssistantId!) as AssistantItem;
    expect(pending).toMatchObject({ kind: "assistant", text: "Hello", streaming: true });

    const final = applyAppEvent(
      streaming,
      seq.build("assistant-message", { messageId: seq.ids.message(), text: "Hello!" }, turnId),
    );
    expect(final.order).toHaveLength(1);
    expect(final.pendingAssistantId).toBeUndefined();
    const item = final.byId.get(final.order[0]!) as AssistantItem;
    expect(item).toMatchObject({ text: "Hello!", streaming: false });
  });

  it("starts a new assistant item after finalization (multi-step turn)", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(state, seq.build("assistant-delta", { text: "First" }, turnId));
    state = applyAppEvent(
      state,
      seq.build("assistant-message", { messageId: seq.ids.message(), text: "First" }, turnId),
    );
    state = applyAppEvent(state, seq.build("assistant-delta", { text: "Second" }, turnId));
    state = applyAppEvent(
      state,
      seq.build("assistant-message", { messageId: seq.ids.message(), text: "Second" }, turnId),
    );
    const items = transcriptItems(state) as AssistantItem[];
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.text)).toEqual(["First", "Second"]);
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
  });

  it("finalizes a thinking-block with no preceding deltas", () => {
    const seq = buildSequencer();
    const state = applyAppEvent(
      EMPTY_TRANSCRIPT_STATE,
      seq.build("thinking-block", { messageId: seq.ids.message(), content: "reasoning" }, undefined),
    );
    const item = transcriptItems(state)[0] as ThinkingItem;
    expect(item).toMatchObject({ kind: "thinking", content: "reasoning", streaming: false });
  });

  it("discards unfinalized assistant stream when a tool-call arrives (no tool JSON as Response)", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build("assistant-delta", { text: '```tool\n{"name":"fs.read","args":{}}\n```' }, turnId),
    );
    expect(state.pendingAssistantId).toBeDefined();
    state = applyAppEvent(
      state,
      seq.build(
        "tool-call",
        { toolCallId: asToolCallId("c1"), name: "fs.read", argsDisplay: "{}" },
        turnId,
      ),
    );
    const items = transcriptItems(state);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", name: "fs.read" });
    expect(state.pendingAssistantId).toBeUndefined();
    expect(state.runningStatus).toBe("responding");
  });

  it("keeps finalized Response prose above the tool card", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(state, seq.build("assistant-delta", { text: "Checking…" }, turnId));
    state = applyAppEvent(
      state,
      seq.build(
        "assistant-message",
        { messageId: seq.ids.message(), text: "Checking your interfaces." },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "tool-call",
        { toolCallId: asToolCallId("c1"), name: "net.context", argsDisplay: "{}" },
        turnId,
      ),
    );
    const items = transcriptItems(state);
    expect(items.map((i) => i.kind)).toEqual(["assistant", "tool"]);
    expect((items[0] as AssistantItem).text).toBe("Checking your interfaces.");
  });

  it("keeps late thinking after the assistant response that preceded it", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build("assistant-delta", { text: "Let me batch these." }, turnId),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "assistant-message",
        { messageId: seq.ids.message(), text: "Good — recon summary." },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "thinking-block",
        { messageId: seq.ids.message(), content: "I should run http.fetch and dns.lookup." },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "tool-call",
        {
          toolCallId: asToolCallId("c1"),
          name: "tool.batch",
          argsDisplay: "4 call(s): http.fetch, dns.lookup",
        },
        turnId,
      ),
    );
    const kinds = transcriptItems(state).map((i) => i.kind);
    expect(kinds).toEqual(["assistant", "thinking", "tool"]);
    expect((transcriptItems(state)[0] as AssistantItem).text).toMatch(/recon/);
    expect((transcriptItems(state)[1] as ThinkingItem).content).toMatch(/http\.fetch/);
  });

  it("preserves each response and late thinking block in multi-step turns", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build("turn-started", { prompt: "hi" }, turnId),
    );

    // Step 1: response then late thinking-block
    state = applyAppEvent(
      state,
      seq.build(
        "assistant-message",
        { messageId: seq.ids.message(), text: "Hey! I'm clai." },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "thinking-block",
        { messageId: seq.ids.message(), content: "think-1 greeting" },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build("notice", { level: "warn", text: "described a web action…" }, turnId),
    );

    // Step 2
    state = applyAppEvent(
      state,
      seq.build(
        "assistant-message",
        { messageId: seq.ids.message(), text: "I didn't promise a fetch." },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "thinking-block",
        { messageId: seq.ids.message(), content: "think-2 clarify" },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build("notice", { level: "warn", text: "described a web action…" }, turnId),
    );

    // Step 3
    state = applyAppEvent(
      state,
      seq.build(
        "assistant-message",
        { messageId: seq.ids.message(), text: "Give me a real topic." },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "thinking-block",
        { messageId: seq.ids.message(), content: "think-3 refuse" },
        turnId,
      ),
    );

    const items = transcriptItems(state);
    const summary = items.map((i) => {
      if (i.kind === "thinking") return `T:${(i as ThinkingItem).content}`;
      if (i.kind === "assistant") return `A:${(i as AssistantItem).text.slice(0, 12)}`;
      if (i.kind === "notice") return "N";
      if (i.kind === "user") return "U";
      return i.kind;
    });
    // Notices between steps are toast-only and do not appear as chat rows.
    expect(summary).toEqual([
      "U",
      "A:Hey! I'm cla",
      "T:think-1 greeting",
      "A:I didn't pro",
      "T:think-2 clarify",
      "A:Give me a re",
      "T:think-3 refuse",
    ]);
  });

  it("reorders late thinking-delta before the pending assistant row", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build("assistant-delta", { text: "Assessment complete. Risk: LOW." }, turnId),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "thinking-delta",
        { text: "The user wants me to continue; I should provide a final summary." },
        turnId,
      ),
    );
    // Thinking is moved before the assistant even though its delta arrived later.
    expect(transcriptItems(state).map((item) => item.kind)).toEqual([
      "thinking",
      "assistant",
    ]);
    state = applyAppEvent(
      state,
      seq.build(
        "thinking-block",
        {
          messageId: seq.ids.message(),
          content: "The user wants me to continue; I should provide a final summary.",
        },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "assistant-message",
        {
          messageId: seq.ids.message(),
          text: "Assessment complete. Risk: LOW.",
        },
        turnId,
      ),
    );
    const items = transcriptItems(state);
    expect(items.map((i) => i.kind)).toEqual(["thinking", "assistant"]);
    expect((items[1] as AssistantItem).text).toMatch(/Risk: LOW/);
    expect((items[0] as ThinkingItem).content).toMatch(/final summary/);
    expect((items[0] as ThinkingItem).streaming).toBe(false);
  });

  it("keeps streaming thinking after the previous response (multi-step deltas)", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build("thinking-delta", { text: "plan-1" }, turnId),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "thinking-block",
        { messageId: seq.ids.message(), content: "plan-1" },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "assistant-message",
        { messageId: seq.ids.message(), text: "First reply" },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build("thinking-delta", { text: "plan-2" }, turnId),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "thinking-block",
        { messageId: seq.ids.message(), content: "plan-2" },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "assistant-message",
        { messageId: seq.ids.message(), text: "Second reply" },
        turnId,
      ),
    );
    const kinds = transcriptItems(state).map((i) => {
      if (i.kind === "thinking") return `T:${(i as ThinkingItem).content}`;
      if (i.kind === "assistant") return `A:${(i as AssistantItem).text}`;
      return i.kind;
    });
    expect(kinds).toEqual([
      "T:plan-1",
      "A:First reply",
      "T:plan-2",
      "A:Second reply",
    ]);
  });

  it("closes streaming thinking when a tool-call arrives", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build("thinking-delta", { text: "planning…" }, turnId),
    );
    expect(state.pendingThinkingId).toBeDefined();
    state = applyAppEvent(
      state,
      seq.build(
        "tool-call",
        { toolCallId: asToolCallId("c1"), name: "sysinfo", argsDisplay: "" },
        turnId,
      ),
    );
    expect(state.pendingThinkingId).toBeUndefined();
    const thinking = transcriptItems(state).find((i) => i.kind === "thinking") as ThinkingItem;
    expect(thinking.streaming).toBe(false);
  });

  it("sets runningStatus for thinking / responding / tool name", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = applyAppEvent(
      EMPTY_TRANSCRIPT_STATE,
      seq.build("thinking-delta", { text: "hmm" }, turnId),
    );
    expect(state.runningStatus).toBe("thinking");
    state = applyAppEvent(state, seq.build("assistant-delta", { text: "hi" }, turnId));
    expect(state.runningStatus).toBe("responding");
  });

  it("runs a tool call through call -> output -> result", () => {
    const seq = buildSequencer();
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build("tool-call", { toolCallId: asToolCallId("c1"), name: "fs.read", argsDisplay: "a.ts" }, undefined),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "tool-output",
        { ref: { toolCallId: asToolCallId("c1"), chunkBytes: 5, totalBytes: 5 } },
        undefined,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "tool-result",
        { toolCallId: asToolCallId("c1"), ok: true, exitCode: 0, summary: "done", artifactPath: undefined },
        undefined,
      ),
    );
    const item = transcriptItems(state)[0] as ToolItem;
    expect(item).toMatchObject({
      kind: "tool",
      status: "ok",
      exitCode: 0,
      summary: "done",
      outputBytes: 5,
    });
  });

  it("marks a tool blocked", () => {
    const seq = buildSequencer();
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build("tool-call", { toolCallId: asToolCallId("c1"), name: "shell.exec", argsDisplay: "rm -rf" }, undefined),
    );
    state = applyAppEvent(
      state,
      seq.build("tool-blocked", { toolCallId: asToolCallId("c1"), name: "shell.exec", reason: "unsafe" }, undefined),
    );
    const item = transcriptItems(state)[0] as ToolItem;
    expect(item).toMatchObject({ status: "blocked", reason: "unsafe" });
  });

  it("gives repeated legacy tool ids unique transcript rows", () => {
    const seq = buildSequencer();
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build("tool-call", { toolCallId: asToolCallId("tool-1"), name: "fs.read", argsDisplay: "first" }, asTurnId("turn-1")),
    );
    state = applyAppEvent(
      state,
      seq.build("tool-result", { toolCallId: asToolCallId("tool-1"), ok: true, summary: "done" }, asTurnId("turn-1")),
    );
    state = applyAppEvent(
      state,
      seq.build("tool-call", { toolCallId: asToolCallId("tool-1"), name: "fs.read", argsDisplay: "second" }, asTurnId("turn-2")),
    );

    const tools = transcriptItems(state).filter((item): item is ToolItem => item.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(new Set(tools.map((item) => item.id)).size).toBe(2);
    expect(() => normalizeSemanticDocument(extractTranscriptSemanticDocument(state))).not.toThrow();
  });

  it("ignores chrome notices but appends compacted items", () => {
    const seq = buildSequencer();
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(state, seq.build("notice", { level: "warn", text: "careful" }, undefined));
    state = applyAppEvent(
      state,
      seq.build("compacted", { summary: "sum", beforeTokens: 100, afterTokens: 40 }, undefined),
    );
    const items = transcriptItems(state);
    // Notices are toast-only — must never become chat rows.
    expect(items.every((i) => i.kind !== "notice")).toBe(true);
    expect(items[0]).toMatchObject({ kind: "compacted", beforeTokens: 100, afterTokens: 40 });
  });

  it("closes an open streaming item and surfaces a notice on turn-error", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(state, seq.build("assistant-delta", { text: "partial" }, turnId));
    state = applyAppEvent(state, seq.build("turn-error", { message: "boom" }, turnId));
    expect(state.pendingAssistantId).toBeUndefined();
    const items = transcriptItems(state);
    expect(items[0]).toMatchObject({ kind: "assistant", text: "partial", streaming: false });
    expect(items[1]).toMatchObject({ kind: "notice", level: "error", text: "boom" });
  });

  it("surfaces a warn notice on turn-aborted and clears runningStatus", () => {
    const seq = buildSequencer();
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(state, seq.build("status", { text: "step 1" }, undefined));
    expect(state.runningStatus).toBe("step 1");
    state = applyAppEvent(state, seq.build("turn-aborted", {}, undefined));
    expect(state.runningStatus).toBeUndefined();
    expect(transcriptItems(state).at(-1)).toMatchObject({ kind: "notice", level: "warn" });
  });

  it("keeps model prose, tools, and post-tool analysis in emitted order", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(state, seq.build("thinking-delta", { text: "checking" }, turnId));
    state = applyAppEvent(state, seq.build("assistant-delta", { text: "I'll inspect the config." }, turnId));
    state = applyAppEvent(
      state,
      seq.build("assistant-message", { messageId: seq.ids.message(), text: "I'll inspect the config." }, turnId),
    );
    state = applyAppEvent(
      state,
      seq.build("tool-call", { toolCallId: asToolCallId("tool-1"), name: "fs.read", argsDisplay: "config.json" }, turnId),
    );
    state = applyAppEvent(
      state,
      seq.build("tool-result", { toolCallId: asToolCallId("tool-1"), ok: true, summary: "read" }, turnId),
    );
    state = applyAppEvent(state, seq.build("thinking-delta", { text: "interpreting" }, turnId));
    state = applyAppEvent(state, seq.build("assistant-delta", { text: "The setting is enabled." }, turnId));

    expect(transcriptItems(state).map((item) => item.kind)).toEqual([
      "thinking",
      "assistant",
      "tool",
      "thinking",
      "assistant",
    ]);
  });

  it("ignores plan-updated/confirm-requested but still advances lastSequence", () => {
    const seq = buildSequencer();
    const before = EMPTY_TRANSCRIPT_STATE.lastSequence;
    const state = applyAppEvent(
      EMPTY_TRANSCRIPT_STATE,
      seq.build("confirm-requested", { requestId: "r1", kind: "tool", prompt: "ok?" }, undefined),
    );
    expect(state.order).toHaveLength(0);
    expect(state.lastSequence).toBeGreaterThan(before);
  });

  it("is deterministic on replay given the same ids/clock", () => {
    const build = (prefix: string) => {
      const seq = new EventSequencer(asSessionId("sess-1"), createCountingIdFactory(prefix), {
        now: () => 42,
      });
      const turnId = asTurnId("turn-1");
      const events: AnyAppEvent[] = [
        seq.build("turn-started", { prompt: "go" }, turnId),
        seq.build("assistant-delta", { text: "Hi" }, turnId),
        seq.build("assistant-message", { messageId: seq.ids.message(), text: "Hi" }, turnId),
      ];
      return fold(events);
    };
    const a = build("r-");
    const b = build("r-");
    expect(JSON.stringify([...a.byId.entries()])).toBe(JSON.stringify([...b.byId.entries()]));
    expect(a.order).toEqual(b.order);
  });
});
