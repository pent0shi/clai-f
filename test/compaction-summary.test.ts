import { describe, expect, it } from "vitest";
import {
  buildCompactionUserPrompt,
  COMPACTION_SYSTEM_PROMPT,
  trimTranscriptForCompaction,
} from "../src/agent/compaction-summary.js";
import {
  compactMessages,
  compactMessagesWithSummary,
  isCompactionMemoryMessage,
} from "../src/agent/context-manager.js";
import type { ChatMessage } from "../src/types.js";

describe("compaction-summary prompts", () => {
  it("system prompt demands fidelity and sections", () => {
    expect(COMPACTION_SYSTEM_PROMPT).toMatch(/Never invent/i);
    expect(COMPACTION_SYSTEM_PROMPT).toMatch(/secrets/i);
  });

  it("user prompt includes required headings and durable state", () => {
    const p = buildCompactionUserPrompt({
      messageTranscript: "USER: build app\nASSISTANT: ok",
      durableState: "ACTIVE PLAN: t1 done",
    });
    expect(p).toContain("## User goals");
    expect(p).toContain("## Remaining work");
    expect(p).toContain("DURABLE STATE");
    expect(p).toContain("ACTIVE PLAN");
    expect(p).toContain("SESSION MATERIAL");
    expect(p).toMatch(/PHASE AWARENESS/i);
  });

  it("plan-implement handoff separates evidence from plan-mode-only gates", () => {
    const p = buildCompactionUserPrompt({
      purpose: "plan-implement",
      messageTranscript: "USER: recon target\nTOOL: nmap open 443",
      durableState: "ACTIVE PLAN: pentest",
    });
    expect(p).toMatch(/HANDOFF|plan-mode research|plan mode/i);
    expect(p).toMatch(/Do not add another framing paragraph/i);
    expect(p).toContain("## Research evidence");
    expect(p).toContain("## Coverage ledger");
    expect(p).toContain("## Confirmed findings");
    expect(p).toContain("## Untested / open classes");
    expect(p).toContain("## Artifacts & paths");
    expect(p).toContain("## Plan-mode-only notes");
    expect(p).toContain("## Durable engagement rules");
    expect(p).toMatch(/not current agent gates|gather-only|past that phase/i);
    expect(p).toMatch(/mid-token|COMPLETE short memory/i);
    expect(p).toMatch(/DEDUPLICATE/i);
    expect(p).toMatch(/omit routine fs\.list/i);
    expect(p).toMatch(/ACTIVE PLAN is injected separately/i);
    expect(p).toMatch(/revalidation of mutable workspace/i);
    expect(p).toMatch(/Resolve contradictions/i);
  });

  it("system prompt warns against freezing temporary mode gates", () => {
    expect(COMPACTION_SYSTEM_PROMPT).toMatch(/PHASE AWARENESS/i);
    expect(COMPACTION_SYSTEM_PROMPT).toMatch(/HISTORICAL/i);
  });

  it("trims huge transcripts while keeping head and tail", () => {
    const big = "HEAD-" + "x".repeat(100_000) + "-TAIL";
    const out = trimTranscriptForCompaction(big, 1000);
    expect(out.length).toBeLessThan(1200);
    expect(out.startsWith("HEAD-")).toBe(true);
    expect(out.endsWith("-TAIL")).toBe(true);
    expect(out).toMatch(/omitted for length/i);
  });
});

describe("LLM compaction integration shape", () => {
  it("feeds structured prompt and stores model memory", async () => {
    const msgs: ChatMessage[] = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content:
        `message-${index}-` +
        "content-to-exceed-limits-".repeat(20),
    }));
    msgs[0] = {
      role: "system",
      content: "ACTIVE PLAN for this session (goal: todo)\nTasks:\n  1. [t1] (done) scaffold",
    };

    let seen = "";
    const result = await compactMessagesWithSummary(
      msgs,
      async (prompt) => {
        seen = prompt;
        expect(prompt).toContain("## User goals");
        expect(prompt).toContain("DURABLE STATE");
        expect(prompt).toContain("ACTIVE PLAN");
        return "## User goals\nBuild todo app\n## Remaining work\nImplement feature";
      },
      { keepRecent: 4 },
    );
    expect(result.summarized).toBe(true);
    expect(seen.length).toBeGreaterThan(50);
    expect(result.messages.some((m) => m.content.includes("Build todo app"))).toBe(
      true,
    );
  });

  it("plan-implement purpose uses handoff memory prefix", async () => {
    const msgs: ChatMessage[] = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `m-${index}-` + "x".repeat(200),
    }));
    const result = await compactMessagesWithSummary(
      msgs,
      async (prompt) => {
        expect(prompt).toMatch(/Research evidence/i);
        return "## Research evidence\nPorts 80/443 open\n## Remaining work\nt2 auth";
      },
      { keepRecent: 2, purpose: "plan-implement" },
    );
    const mem = result.messages.find(
      (m) =>
        m.role === "system" &&
        /PLAN MODE HANDOFF/i.test(m.content) &&
        m.content.includes("Ports 80/443"),
    );
    expect(mem).toBeTruthy();
    expect(mem!.content).toMatch(/gather-only\/await-approval gates are historical/i);
    expect(mem!.content).toMatch(/ACTIVE PLAN and SESSION STATE are authoritative/i);
  });

  it("continues recognizing legacy plan-handoff memories on session resume", () => {
    expect(
      isCompactionMemoryMessage({
        role: "system",
        content:
          "Session memory from PLAN MODE research that was used to build the comprehensive detailed plan and tasks you are seeing now (handoff to agent implement — gather-only phase is over; execute approved tasks):\nlegacy memory",
      }),
    ).toBe(true);
  });

  it("replaces index-zero compaction memory during LLM re-compaction", async () => {
    const staleMemory: ChatMessage = {
      role: "system",
      content:
        "Session memory from compacted earlier turns:\n\nstale resumed memory",
    };
    const messages: ChatMessage[] = [
      staleMemory,
      { role: "user", content: "old request" },
      { role: "assistant", content: "old response" },
      { role: "user", content: "recent request" },
      { role: "assistant", content: "recent response" },
    ];
    let prompt = "";

    const result = await compactMessagesWithSummary(
      messages,
      async (value) => {
        prompt = value;
        return "## Research evidence\nFresh handoff only";
      },
      { budgetTokens: 0, keepRecent: 2, purpose: "plan-implement" },
    );

    expect(prompt).toContain("stale resumed memory");
    const memories = result.messages.filter(isCompactionMemoryMessage);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toContain("PLAN MODE HANDOFF");
    expect(memories[0]?.content).toContain("Fresh handoff only");
    expect(result.messages).not.toContain(staleMemory);
  });

  it("replaces index-zero compaction memory during mechanical re-compaction", () => {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "Session memory from compacted earlier turns:\n\nstale resumed memory",
      },
      { role: "user", content: "old request " + "x".repeat(200) },
      { role: "assistant", content: "old response " + "x".repeat(200) },
      { role: "user", content: "recent request" },
      { role: "assistant", content: "recent response" },
    ];

    const result = compactMessages(messages, {
      budgetTokens: 0,
      keepRecent: 2,
    });

    const memories = result.filter(isCompactionMemoryMessage);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toContain("Earlier turns in this session");
    expect(result.some((message) => message.content.includes("stale resumed memory"))).toBe(false);
  });
});
