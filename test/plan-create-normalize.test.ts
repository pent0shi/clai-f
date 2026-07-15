import { afterEach, describe, expect, it } from "vitest";
import { handlePlanTool } from "../src/agent/plan-tool.js";
import { LoopGuard } from "../src/agent/loop-guard.js";
import { createSessionPolicy } from "../src/agent/session-policy.js";
import { clearAllPlans } from "../src/store/plan.js";

describe("plan.create robust arg normalization", () => {
  afterEach(async () => {
    await clearAllPlans();
  });

  it("accepts tasks as {title} objects", async () => {
    const result = await handlePlanTool(
      {
        name: "plan.create",
        args: {
          goal: "Assess target.example",
          detail: "Recon then report",
          kind: "pentest",
          tasks: [
            { id: "t1", title: "DNS enumeration" },
            { title: "Port scan" },
            { name: "HTTP fingerprint" },
          ],
        },
      },
      createSessionPolicy("plan-obj-tasks"),
      { loopGuard: new LoopGuard(), step: 1 },
    );
    expect(result.ok).toBe(true);
    expect(result.plan?.tasks.map((t) => t.title)).toEqual([
      "DNS enumeration",
      "Port scan",
      "HTTP fingerprint",
    ]);
  });

  it("accepts tasks as a newline-separated string", async () => {
    const result = await handlePlanTool(
      {
        name: "plan.create",
        args: {
          goal: "Build todo app",
          tasks:
            "scaffold project\nimplement UI\nverify build\nstart dev server, probe localhost, leave running, report URL",
          kind: "coding",
        },
      },
      createSessionPolicy("plan-string-tasks"),
      { loopGuard: new LoopGuard(), step: 1 },
    );
    expect(result.ok).toBe(true);
    // coding app plans auto-inject an install step after scaffold
    expect(result.plan?.tasks.length).toBe(5);
    expect(result.plan?.tasks.some((t) => /install/i.test(t.title))).toBe(true);
  });

  it("still rejects empty goal/tasks with a helpful note", async () => {
    const result = await handlePlanTool(
      {
        name: "plan.create",
        args: { goal: "", tasks: [] },
      },
      createSessionPolicy("plan-empty"),
      { loopGuard: new LoopGuard(), step: 1 },
    );
    expect(result.ok).toBe(false);
    expect(result.modelNote).toMatch(/tasks array/i);
  });
});
