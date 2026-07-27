import { describe, expect, it } from "vitest";
import {
  analyzeTask,
  formatTaskAnalysisHint,
  isNarrowExplicitNmapOperation,
} from "../src/agent/task-analyzer.js";
import { computeStepBudget } from "../src/agent/step-budget.js";

describe("task-analyzer", () => {
  it("classifies short shell probes as simple", () => {
    const analysis = analyzeTask("whoami");
    expect(analysis.complexity).toBe("simple");
    expect(analysis.shouldPlan).toBe(false);
    expect(analysis.suggestedSteps).toEqual([]);
  });

  it("keeps an explicit nmap request direct instead of expanding it into a pentest plan", () => {
    const prompt = "run stealth nmap scan on aniketpandey.website";
    expect(isNarrowExplicitNmapOperation(prompt)).toBe(true);
    expect(
      isNarrowExplicitNmapOperation("sudo nmap -sS -p 80,443 example.com"),
    ).toBe(true);
    expect(
      isNarrowExplicitNmapOperation("nmap --top-ports 100 example.com"),
    ).toBe(true);
    expect(
      isNarrowExplicitNmapOperation("find open ports on aniketpandey.website"),
    ).toBe(true);
    expect(analyzeTask("check which ports are open on example.com")).toMatchObject({
      shouldPlan: false,
      likelyTools: ["net.scan"],
      suggestedSteps: [],
    });
    const analysis = analyzeTask(prompt);
    expect(analysis.shouldPlan).toBe(false);
    expect(analysis.complexity).toBe("standard");
    expect(analysis.likelyTools).toEqual(["net.scan"]);
    expect(analysis.suggestedSteps).toEqual([]);
    expect(analysis.stopWhen).toMatch(/do not broaden scope/i);
  });

  it("does not narrow a requested assessment or multi-operation recon", () => {
    expect(
      isNarrowExplicitNmapOperation(
        "run an nmap scan and assess vulnerabilities across the attack surface",
      ),
    ).toBe(false);
    expect(
      isNarrowExplicitNmapOperation(
        "run nmap and then perform DNS and HTTP reconnaissance",
      ),
    ).toBe(false);
  });

  it("marks pentest work complex with planning signal and tools", () => {
    const analysis = analyzeTask("run a pentest against example.com");
    expect(analysis.complexity).toBe("complex");
    expect(analysis.shouldPlan).toBe(true);
    expect(analysis.likelyTools).toEqual(
      expect.arrayContaining(["dns.lookup", "http.fetch", "plan.create"]),
    );
    expect(analysis.suggestedSteps.length).toBeGreaterThan(0);
    expect(analysis.stopWhen.toLowerCase()).toMatch(/finding|evidence|scope/);
  });

  it("marks multi-step app builds as plan-worthy", () => {
    const analysis = analyzeTask(
      "create a React todo app on the Desktop with Vite",
    );
    expect(analysis.complexity).toBe("complex");
    expect(analysis.shouldPlan).toBe(true);
    expect(analysis.category).toBe("filesystem");
    expect(analysis.likelyTools).toContain("plan.create");
    expect(analysis.suggestedSteps.some((s) => /feature|implement/i.test(s.title))).toBe(
      true,
    );
  });

  it("treats fix/debug as standard with a fix loop soft steps", () => {
    const analysis = analyzeTask("fix the typeerror in App.tsx");
    expect(["standard", "complex"]).toContain(analysis.complexity);
    expect(analysis.likelyTools).toEqual(
      expect.arrayContaining(["fs.read", "fs.edit"]),
    );
    expect(analysis.suggestedSteps.length).toBeGreaterThan(0);
  });

  it("detects network discovery needs", () => {
    const analysis = analyzeTask("discover live hosts on my local network subnet");
    expect(analysis.needsNetworkContext).toBe(true);
    expect(analysis.category).toBe("network-discovery");
    expect(analysis.likelyTools).toContain("net.context");
  });

  it("formats a compact analysis hint", () => {
    const hint = formatTaskAnalysisHint(
      analyzeTask("build a next.js dashboard app"),
    );
    expect(hint).toMatch(/TASK ANALYSIS/);
    expect(hint).toMatch(/complexity=/);
    expect(hint).toMatch(/Likely tools/);
    expect(hint).toMatch(/durable task tracking strongly recommended/i);
    expect(hint).toMatch(/plan before mutation/i);
  });

  it("truncates goal to 100 chars", () => {
    const long = "a ".repeat(200);
    const analysis = analyzeTask(long);
    expect(analysis.goal.length).toBeLessThanOrEqual(100);
  });

  it("does not force plan steps into execution — soft suggestions only", () => {
    const analysis = analyzeTask("full recon example.com");
    // Soft steps exist for complex work but are never auto-run by the analyzer.
    expect(analysis.suggestedSteps.every((s) => s.status === "pending")).toBe(
      true,
    );
  });
});

describe("step budget", () => {
  it("gives builds full maxSteps ceiling", () => {
    const analysis = analyzeTask("create a react todo app");
    const budget = computeStepBudget({
      analysis,
      maxSteps: 100,
      buildLike: true,
      pentestLike: false,
      hasHistory: false,
    });
    expect(budget).toBeGreaterThanOrEqual(100);
  });

  it("keeps simple one-liners small without build flags", () => {
    const analysis = analyzeTask("whoami");
    const budget = computeStepBudget({
      analysis,
      maxSteps: 100,
      buildLike: false,
      pentestLike: false,
      hasHistory: false,
    });
    expect(budget).toBe(20);
  });
});
