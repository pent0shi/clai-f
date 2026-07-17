import { describe, expect, it } from "vitest";
import {
  acceptPlanImplementCompaction,
  CATASTROPHIC_BEFORE_TOKENS_MIN,
  CATASTROPHIC_SUMMARY_MIN_CHARS,
  extractCompactionSummaryBody,
} from "../../src/agent/plan-implement-compact.js";
import { COMPACTION_MEMORY_PREFIX } from "../../src/agent/context-manager.js";
import type { ChatMessage } from "../../src/types.js";

function msgs(...parts: ChatMessage[]): ChatMessage[] {
  return parts;
}

describe("acceptPlanImplementCompaction", () => {
  it("accepts dense free-form summary without markdown section headers", () => {
    const body =
      "User wanted a pentest of app.example. Stack is React + FastAPI. " +
      "Found source maps exposed and OpenAPI public. Remaining: auth IDOR, RBAC, payments. " +
      "Credentials not obtained. Recon used nmap, http.fetch, dns.";
    const after = msgs(
      { role: "system", content: "sys" },
      {
        role: "system",
        content: `${COMPACTION_MEMORY_PREFIX}\n\n${body}`,
      },
      { role: "user", content: "implement" },
    );
    const r = acceptPlanImplementCompaction({
      summarized: true,
      summaryBody: body,
      beforeTokens: 40_000,
      afterTokens: 6_000,
      afterMessages: after,
    });
    expect(r).toEqual({ accept: true });
  });

  it("accepts paraphrased findings without repeating a plan goal string", () => {
    const body =
      "Engagement against the dental SaaS continued with unauthenticated recon. " +
      "Multiple medium issues documented; authenticated testing still open.";
    const r = acceptPlanImplementCompaction({
      summarized: true,
      summaryBody: body,
      beforeTokens: 20_000,
      afterTokens: 4_000,
      afterMessages: msgs(
        { role: "system", content: `${COMPACTION_MEMORY_PREFIX}\n\n${body}` },
        { role: "user", content: "go" },
      ),
    });
    expect(r.accept).toBe(true);
  });

  it("rejects empty summary", () => {
    const r = acceptPlanImplementCompaction({
      summarized: true,
      summaryBody: "   ",
      beforeTokens: 10_000,
      afterTokens: 100,
      afterMessages: msgs({ role: "user", content: "x" }),
    });
    expect(r.accept).toBe(false);
  });

  it("rejects when summarized is false", () => {
    const r = acceptPlanImplementCompaction({
      summarized: false,
      summaryBody: "lots of text here that would otherwise pass",
      beforeTokens: 10_000,
      afterTokens: 2_000,
      afterMessages: msgs({ role: "user", content: "x" }),
    });
    expect(r.accept).toBe(false);
  });

  it("rejects orphan tool messages", () => {
    const body = "A".repeat(CATASTROPHIC_SUMMARY_MIN_CHARS + 20);
    const r = acceptPlanImplementCompaction({
      summarized: true,
      summaryBody: body,
      beforeTokens: 10_000,
      afterTokens: 2_000,
      afterMessages: msgs(
        { role: "system", content: `${COMPACTION_MEMORY_PREFIX}\n\n${body}` },
        // tool without preceding assistant toolCalls
        { role: "tool", content: "out", toolCallId: "t1" },
      ),
    });
    expect(r.accept).toBe(false);
    if (!r.accept) expect(r.reason).toMatch(/orphan/i);
  });

  it("rejects catastrophic thin stub after large history", () => {
    const tiny = "ok";
    const r = acceptPlanImplementCompaction({
      summarized: true,
      summaryBody: tiny,
      beforeTokens: CATASTROPHIC_BEFORE_TOKENS_MIN + 1_000,
      afterTokens: 50,
      afterMessages: msgs(
        { role: "system", content: `${COMPACTION_MEMORY_PREFIX}\n\n${tiny}` },
        { role: "user", content: "x" },
      ),
    });
    expect(r.accept).toBe(false);
  });

  it("accepts modest token savings with substantial body", () => {
    const body =
      "Work completed: recon, stack fingerprint, confirmed three findings. " +
      "Remaining: obtain credentials and run authenticated IDOR suite.";
    const r = acceptPlanImplementCompaction({
      summarized: true,
      summaryBody: body,
      beforeTokens: 12_000,
      afterTokens: 11_000, // tiny savings — still accept
      afterMessages: msgs(
        { role: "system", content: `${COMPACTION_MEMORY_PREFIX}\n\n${body}` },
        { role: "user", content: "continue" },
      ),
    });
    expect(r.accept).toBe(true);
  });

  it("extracts summary body from compacted messages", () => {
    const body = "memory body here";
    const extracted = extractCompactionSummaryBody([
      { role: "system", content: "main prompt" },
      { role: "system", content: `${COMPACTION_MEMORY_PREFIX}\n\n${body}` },
      { role: "user", content: "hi" },
    ]);
    expect(extracted).toBe(body);
  });
});
