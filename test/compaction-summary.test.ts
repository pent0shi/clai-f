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
});
