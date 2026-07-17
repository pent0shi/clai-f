import { describe, expect, it } from "vitest";
import {
  buildCompactionUserPrompt,
  COMPACTION_SYSTEM_PROMPT,
  trimTranscriptForCompaction,
} from "../src/agent/compaction-summary.js";
import { compactMessagesWithSummary } from "../src/agent/context-manager.js";
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
    expect(p).toMatch(/HANDOFF|plan-mode research/i);
    expect(p).toContain("## Research evidence");
    expect(p).toContain("## Plan-mode-only notes");
    expect(p).toContain("## Durable engagement rules");
    expect(p).toMatch(/not current agent gates|gather-only/i);
    expect(p).not.toMatch(/Do not implement or exploit yet/i);
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
        m.content.includes("plan-mode research") &&
        m.content.includes("Ports 80/443"),
    );
    expect(mem).toBeTruthy();
    expect(mem!.content).toMatch(/gather-only phase is over/i);
  });
});
