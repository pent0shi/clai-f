import { describe, expect, it } from "vitest";
import { createPlan, shortenPlanGoal } from "../src/store/plan.js";

describe("shortenPlanGoal", () => {
  it("leaves short goals untouched", () => {
    expect(shortenPlanGoal("Build todo app")).toBe("Build todo app");
    expect(shortenPlanGoal("Scaffold a Vite React todo app")).toBe(
      "Scaffold a Vite React todo app",
    );
  });

  it("collapses internal whitespace", () => {
    expect(shortenPlanGoal("Build   todo\n\napp")).toBe("Build todo app");
  });

  it("shortens a long echoed user request to a coherent short phrase", () => {
    const raw =
      "Build a modern, frontend-only React blogging app (no backend/DB) " +
      "in /Users/aniketpandey/Desktop/blog with a glassmorphism visual " +
      "design, verified via typecheck/build and a running dev server.";
    const out = shortenPlanGoal(raw);
    // Must not be a meaningless fragment like "Build a modern".
    expect(out.length).toBeGreaterThan(20);
    expect(out.toLowerCase()).not.toBe("build a modern");
    // Should read as a complete phrase, not truncated mid-clause with "with".
    expect(out).not.toMatch(/\bwith$/i);
    expect(out).not.toMatch(/\bwith,?\s*$/i);
    // Should stay within a title-length budget (roughly 1-2 lines).
    expect(out.length).toBeLessThanOrEqual(90);
    expect(out).toBe("Build a modern, frontend-only React blogging app");
  });

  it("keeps the first sentence when it is a reasonable title", () => {
    const raw =
      "Assess target.example for common web vulnerabilities. " +
      "Then write a full report with remediations for each finding discovered.";
    expect(shortenPlanGoal(raw)).toBe(
      "Assess target.example for common web vulnerabilities.",
    );
  });

  it("cuts at the last clause boundary under the max, not the first", () => {
    const raw =
      "Implement OAuth2 login, add rate limiting, and write integration " +
      "tests for the payments service before Friday deploy";
    const out = shortenPlanGoal(raw);
    expect(out).toBe("Implement OAuth2 login, add rate limiting");
    expect(out.length).toBeGreaterThan(20);
  });

  it("never returns an empty or whitespace-only result for non-empty input", () => {
    expect(shortenPlanGoal("   ")).toBe("");
    expect(shortenPlanGoal("hi")).toBe("hi");
  });

  it("falls back to leaving text intact when no good boundary exists under the hard cap", () => {
    const raw =
      "This is one extremely long goal without any punctuation at all " +
      "that just keeps going and going past the max length limit set";
    const out = shortenPlanGoal(raw);
    expect(out).toBe(raw);
  });

  it("hard-cuts only far-past-limit unpunctuated text, at a word boundary", () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const out = shortenPlanGoal(words);
    expect(out.endsWith("…")).toBe(true);
    // Cut lands on a whole word, not mid-word (e.g. "word2…" not "wor…").
    const withoutEllipsis = out.slice(0, -1);
    expect(words.startsWith(withoutEllipsis)).toBe(true);
    expect(withoutEllipsis.endsWith(" ")).toBe(false);
  });

  it("integrates with createPlan to store a short goal", () => {
    const plan = createPlan({
      sessionId: "s1",
      goal:
        "Build a modern, frontend-only React blogging app (no backend/DB) " +
        "in /Users/aniketpandey/Desktop/blog with a glassmorphism visual " +
        "design, verified via typecheck/build and a running dev server.",
      detail: "",
      taskTitles: ["scaffold", "verify"],
    });
    expect(plan.goal).toBe("Build a modern, frontend-only React blogging app");
  });
});
