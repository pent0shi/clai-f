import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPort } from "../../src/app/ports/agent-port.js";
import type { PersistencePort } from "../../src/app/ports/persistence-port.js";
import {
  isCompactionMemoryMessage,
} from "../../src/agent/context-manager.js";
import { SessionController } from "../../src/app/controllers/session-controller.js";
import type { AnyAppEvent } from "../../src/app/events/app-event.js";

const completeWithProvider = vi.fn();
vi.mock("../../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/llm/router.js")>();
  return {
    ...actual,
    completeWithProvider: (...args: unknown[]) => completeWithProvider(...args),
  };
});

function fakePersistence(): PersistencePort {
  return {
    async saveSession() {},
    async loadPlan() {
      return undefined;
    },
    async savePlan() {},
    async deletePlan() {},
  };
}

function fakeAgent(): AgentPort {
  return {
    async runTurn(_req, handlers) {
      handlers.onMessages?.([{ role: "user", content: "x" }, { role: "assistant", content: "y" }]);
      return "y";
    },
  };
}

describe("SessionController parity helpers (V2-080)", () => {
  beforeEach(() => {
    completeWithProvider.mockReset();
    completeWithProvider.mockResolvedValue({
      text: "User goals: resumed work. Work completed: history + follow-up.",
    });
  });

  it("notice emits a typed notice AppEvent", () => {
    const events: AnyAppEvent[] = [];
    const session = new SessionController({
      agent: fakeAgent(),
      persistence: fakePersistence(),
      emit: (e) => events.push(e),
    });
    session.notice("info", "hello");
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("notice");
    if (events[0]?.type === "notice") {
      expect(events[0].payload).toEqual({ level: "info", text: "hello" });
    }
  });

  it("allow/disallow mutate the session allow set", () => {
    const session = new SessionController({
      agent: fakeAgent(),
      persistence: fakePersistence(),
      emit: () => {},
    });
    session.allowTool("fs.write");
    expect(session.allowedTools()).toEqual(["fs.write"]);
    session.disallowTool("fs.write");
    expect(session.allowedTools()).toEqual([]);
  });

  it("reset clears history, queue, and spool", async () => {
    const session = new SessionController({
      agent: fakeAgent(),
      persistence: fakePersistence(),
      emit: () => {},
    });
    await session.submit("hi");
    session.enqueue("queued");
    session.spool.append("tool-1" as never, "out");
    session.reset();
    expect(session.messages).toHaveLength(0);
    expect(session.queued()).toHaveLength(0);
    expect(session.spool.tail("tool-1" as never)).toBe("");
  });

  it("reset({ mintNewId: true }) changes the session id", () => {
    const session = new SessionController({
      agent: fakeAgent(),
      persistence: fakePersistence(),
      emit: () => {},
      sessionId: "sess-old",
    });
    expect(session.sessionId).toBe("sess-old");
    session.reset({ mintNewId: true });
    expect(session.sessionId).not.toBe("sess-old");
  });

  it("estimateContext reports message count", async () => {
    const session = new SessionController({
      agent: fakeAgent(),
      persistence: fakePersistence(),
      emit: () => {},
    });
    await session.submit("hi");
    const est = session.estimateContext();
    expect(est.messages).toBe(2);
    expect(est.tokens).toBeGreaterThan(0);
  });

  it("setPlanApproved is readable via isPlanApproved", () => {
    const session = new SessionController({
      agent: fakeAgent(),
      persistence: fakePersistence(),
      emit: () => {},
    });
    expect(session.isPlanApproved()).toBe(false);
    session.setPlanApproved(true);
    expect(session.isPlanApproved()).toBe(true);
  });

  it("compact is rejected while a turn is running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent: AgentPort = {
      async runTurn(_req, handlers) {
        await gate;
        handlers.onMessages?.([]);
        return "";
      },
    };
    const session = new SessionController({
      agent,
      persistence: fakePersistence(),
      emit: () => {},
    });
    const running = session.submit("long");
    await expect(session.compact()).rejects.toThrow(/already running/);
    release();
    await running;
  });

  it("compact after loadHistory summarizes resumed history + newer turns", async () => {
    const events: AnyAppEvent[] = [];
    const session = new SessionController({
      agent: fakeAgent(),
      persistence: fakePersistence(),
      emit: (e) => events.push(e),
      sessionId: "sess-hist-compact",
      provider: "groq" as never,
      model: "test-model",
    });

    // /history resume with prior conversation.
    session.loadHistory(
      [
        { role: "user", content: "history prompt one" },
        { role: "assistant", content: "history answer one" },
        { role: "user", content: "follow-up after resume" },
        { role: "assistant", content: "follow-up answer" },
      ],
      { sessionId: "sess-hist-compact" },
    );

    const visual =
      "USER INTENT/PROMPT:\nhistory prompt one\n\n---\n\n" +
      "ASSISTANT RESPONSE:\nhistory answer one\n\n---\n\n" +
      "USER INTENT/PROMPT:\nfollow-up after resume\n\n---\n\n" +
      "ASSISTANT RESPONSE:\nfollow-up answer";

    const result = await session.compact(visual, 2);
    expect(result.summarized).toBe(true);
    expect(completeWithProvider).toHaveBeenCalled();
    const prompt = String(completeWithProvider.mock.calls[0]?.[0]?.messages?.[1]?.content ?? "");
    expect(prompt).toContain("history prompt one");
    expect(prompt).toContain("follow-up after resume");
    // Recent tail kept; memory inserted.
    expect(session.messages.slice(-2).map((m) => m.content)).toEqual([
      "follow-up after resume",
      "follow-up answer",
    ]);
    expect(
      session.messages.some(
        (m) =>
          m.role === "system" &&
          m.content.includes("Session memory from compacted earlier turns"),
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === "compacted")).toBe(true);
  });

  it("persists after compaction even when the kept tail has no user message (trailing compacted card survives reload)", async () => {
    const saved: Array<
      readonly { role: string; content: string }[]
    > = [];
    const persistence: PersistencePort = {
      async saveSession(messages) {
        saved.push(messages.map((m) => ({ role: m.role, content: m.content })));
      },
      async loadPlan() {
        return undefined;
      },
      async savePlan() {},
      async deletePlan() {},
    };
    const session = new SessionController({
      agent: fakeAgent(),
      persistence,
      emit: () => {},
      sessionId: "sess-tail-no-user",
    });
    // Older turns get summarized; the kept tail is assistant-only (no user),
    // which previously tripped the persistNow user-message guard.
    session.loadHistory(
      [
        { role: "user", content: "build the app " + "x".repeat(400) },
        { role: "assistant", content: "starting the build " + "x".repeat(400) },
        { role: "assistant", content: "recent assistant one" },
        { role: "assistant", content: "recent assistant two" },
      ],
      { sessionId: "sess-tail-no-user" },
    );

    const result = await session.compact(undefined, 2);

    expect(result.summarized).toBe(true);
    expect(session.messages.some(isCompactionMemoryMessage)).toBe(true);
    expect(session.messages.some((m) => m.role === "user")).toBe(false);
    expect(saved.length).toBeGreaterThan(0);
    expect(
      saved.at(-1)?.some((m) => m.content.includes("Session memory from compacted")),
    ).toBe(true);
  });

  it("emits the PLAN MODE HANDOFF memory instead of a generic compacted label", async () => {
    completeWithProvider.mockResolvedValueOnce({
      text: "## Research evidence\nVerified React project state\n## Current state\nReady to implement",
    });
    const events: AnyAppEvent[] = [];
    const session = new SessionController({
      agent: fakeAgent(),
      persistence: fakePersistence(),
      emit: (event) => events.push(event),
      sessionId: "sess-plan-handoff",
    });
    session.loadHistory(
      [
        {
          role: "system",
          content:
            "Session memory from compacted earlier turns:\n\nstale resumed memory",
        },
        { role: "user", content: "research the app" },
        { role: "assistant", content: "research result" },
        { role: "user", content: "use glassmorphism" },
        { role: "assistant", content: "plan revised" },
      ],
      { sessionId: "sess-plan-handoff" },
    );

    await session.compact(undefined, 2, undefined, {
      purpose: "plan-implement",
    });

    const systemPrompt = String(
      completeWithProvider.mock.calls.at(-1)?.[0]?.messages?.[0]?.content ?? "",
    );
    expect(systemPrompt).toContain("Do not add framing");
    expect(systemPrompt).not.toContain("State clearly that this context");
    const compacted = events.find((event) => event.type === "compacted");
    expect(compacted?.type).toBe("compacted");
    if (compacted?.type === "compacted") {
      expect(compacted.payload.summary).toContain("PLAN MODE HANDOFF");
      expect(compacted.payload.summary).toContain("Verified React project state");
      expect(compacted.payload.summary).not.toContain("stale resumed memory");
      expect(compacted.payload.summary).not.toBe("Compacted context");
    }
    const memories = session.messages.filter(isCompactionMemoryMessage);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toContain("Verified React project state");
  });

  it("serializes stale autosave and compacted snapshots in revision order", async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const saved: Array<{
      messages: readonly { role: string; content: string }[];
      options: Parameters<PersistencePort["saveSession"]>[1];
    }> = [];
    let activeWrites = 0;
    let maxActiveWrites = 0;
    let callCount = 0;
    const persistence: PersistencePort = {
      async saveSession(messages, options) {
        callCount += 1;
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        if (callCount === 1) {
          markFirstStarted();
          await firstGate;
        }
        saved.push({
          messages: messages.map((message) => ({ ...message })),
          options: options ? { ...options } : undefined,
        });
        activeWrites -= 1;
      },
      async loadPlan() {
        return undefined;
      },
      async savePlan() {},
      async deletePlan() {},
    };
    let transcript: unknown[] = [
      { kind: "user", id: "u-old", text: "resumed task", done: true },
    ];
    const session = new SessionController({
      agent: fakeAgent(),
      persistence,
      emit: (event) => {
        if (event.type === "compacted") {
          transcript = [
            {
              kind: "compacted",
              id: "compact-new",
              summary: event.payload.summary,
              originalItems: [],
              done: true,
            },
          ];
        }
      },
      getTranscriptSnapshot: () => transcript as never,
      sessionId: "sess-ordered-compact",
      provider: "groq" as never,
      model: "test-model",
    });
    session.loadHistory(
      [
        { role: "user", content: "resumed task" },
        { role: "assistant", content: "old progress" },
        { role: "user", content: "post-resume work" },
        { role: "assistant", content: "new progress" },
      ],
      {
        sessionId: "sess-ordered-compact",
        persistenceRevision: 7,
        contextUsage: {
          contextTokens: 88_000,
          contextLimit: 128_000,
          exact: true,
        },
      },
    );

    // Simulate a slow pre-compaction autosave. Compaction captures a newer
    // snapshot while this write is blocked and must queue behind it.
    const staleSave = session.persistNow();
    await firstStarted;
    const compactSave = session.compact(undefined, 2);
    await Promise.resolve();
    releaseFirst();
    await Promise.all([staleSave, compactSave]);

    expect(maxActiveWrites).toBe(1);
    expect(saved).toHaveLength(2);
    const revisions = saved.map((entry) => entry.options?.revision ?? 0);
    const generations = saved.map(
      (entry) => entry.options?.writerGeneration ?? "",
    );
    expect(revisions).toEqual([1, 2]);
    expect(generations[0]).not.toBe("");
    expect(generations[1]).toBe(generations[0]);
    expect(saved[0]?.options?.contextUsage?.contextTokens).toBe(88_000);
    expect(saved[1]?.options?.contextUsage?.contextTokens).toBeLessThan(88_000);
    expect(saved[1]?.options?.transcript?.map((item) => item.kind)).toEqual([
      "compacted",
    ]);
    expect(
      saved[1]?.messages.some(
        (message) =>
          message.role === "system" &&
          message.content.includes("Session memory from compacted earlier turns"),
      ),
    ).toBe(true);
  });

  it("gives a later resume a writer generation older processes cannot overtake", async () => {
    const identitiesA: Array<{ generation: string; revision: number }> = [];
    const identitiesB: Array<{ generation: string; revision: number }> = [];
    const persistence = (
      target: Array<{ generation: string; revision: number }>,
    ): PersistencePort => ({
      async saveSession(_messages, options) {
        target.push({
          generation: options?.writerGeneration ?? "",
          revision: options?.revision ?? 0,
        });
      },
      async loadPlan() {
        return undefined;
      },
      async savePlan() {},
      async deletePlan() {},
    });

    const older = new SessionController({
      agent: fakeAgent(),
      persistence: persistence(identitiesA),
      emit: () => {},
      sessionId: "shared-session",
    });
    older.loadHistory([{ role: "user", content: "shared" }], {
      sessionId: "shared-session",
      persistenceRevision: 7,
    });
    const newer = new SessionController({
      agent: fakeAgent(),
      persistence: persistence(identitiesB),
      emit: () => {},
      sessionId: "shared-session",
    });
    newer.loadHistory([{ role: "user", content: "shared" }], {
      sessionId: "shared-session",
      persistenceRevision: 7,
    });

    await older.persistNow();
    await newer.persistNow();
    // The old process saves again during a later shutdown.
    await older.persistNow();

    expect(identitiesA.map((identity) => identity.revision)).toEqual([1, 2]);
    expect(identitiesB.map((identity) => identity.revision)).toEqual([1]);
    expect(identitiesB[0]!.generation.localeCompare(identitiesA[0]!.generation)).toBeGreaterThan(0);
    expect(identitiesA[1]!.generation).toBe(identitiesA[0]!.generation);
  });
});
