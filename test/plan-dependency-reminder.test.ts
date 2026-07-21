import { afterEach, describe, expect, it } from "vitest";
import { clearAllPlans, createPlan, loadPlan, savePlan } from "../src/store/plan.js";
import { handlePlanTool } from "../src/agent/plan-tool.js";
import { LoopGuard } from "../src/agent/loop-guard.js";
import { createSessionPolicy } from "../src/agent/session-policy.js";

async function seedPlan(sessionId: string) {
  const plan = createPlan({
    sessionId,
    goal: "app",
    detail: "d",
    kind: "coding",
    taskTitles: ["Scaffold", "Install deps", "Run and verify"],
  });
  plan.status = "in_progress";
  await savePlan(plan);
  return plan;
}

function openTask(sessionId: string, taskId: string) {
  return { name: "task.update", args: { taskId, state: "in_progress" } } as const;
}

describe("dependency-open reminder", () => {
  afterEach(async () => {
    await clearAllPlans();
  });

  it("holds an early task-open behind a reminder, then applies it on identical re-issue", async () => {
    const sessionId = "dep-remind";
    const session = createSessionPolicy(sessionId);
    session.planApproved.value = true;
    await seedPlan(sessionId);

    // t2 depends on t1 (list order) which is still pending.
    const first = await handlePlanTool(openTask(sessionId, "t2"), session, {
      loopGuard: new LoopGuard(),
      step: 1,
    });
    expect(first.ok).toBe(false);
    expect(first.reminder).toBe(true);
    expect(first.toast).toMatch(/\[t2\]/);
    expect(first.modelNote).toMatch(/HELD/);
    expect(session.pendingDependency.value).toBeTruthy();

    // State must not have changed while held.
    const held = await loadPlan(sessionId);
    expect(held!.tasks.find((t) => t.id === "t2")?.state).toBe("pending");

    // Identical re-issue confirms the override and opens the task.
    const second = await handlePlanTool(openTask(sessionId, "t2"), session, {
      loopGuard: new LoopGuard(),
      step: 2,
    });
    expect(second.ok).toBe(true);
    expect(session.pendingDependency.value).toBeUndefined();
    const live = await loadPlan(sessionId);
    expect(live!.tasks.find((t) => t.id === "t2")?.state).toBe("in_progress");
  });

  it("opens a dependency-ready task normally without any reminder", async () => {
    const sessionId = "dep-ready";
    const session = createSessionPolicy(sessionId);
    session.planApproved.value = true;
    await seedPlan(sessionId);

    const result = await handlePlanTool(openTask(sessionId, "t1"), session, {
      loopGuard: new LoopGuard(),
      step: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.reminder).toBeUndefined();
    const live = await loadPlan(sessionId);
    expect(live!.tasks.find((t) => t.id === "t1")?.state).toBe("in_progress");
  });
});
