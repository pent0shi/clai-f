import { describe, expect, it } from "vitest";
import { applyPlanOperation, deserializeTaskPlan, readyPlanSteps, validatePlanDag, type PlanOperation, type VersionedPlanStep } from "../src/agent/task-plan.js";
import { applySessionPlanOperation, createPlan, readyPlanTasks } from "../src/store/plan.js";

const step = (id: string, dependencies: string[] = [], resourceLocks: string[] = []): VersionedPlanStep => ({ id, title: id, kind: "other", status: "pending", dependencies, resourceLocks });
const legacy = { id: "p", goal: "goal", complexity: "standard" as const, steps: [step("a")], createdAt: "2020-01-01", updatedAt: "2020-01-01" };

describe("versioned task plan domain", () => {
  it("migrates legacy persisted plans conservatively", () => {
    const plan = deserializeTaskPlan(legacy);
    expect(plan).toMatchObject({ schemaVersion: 2, version: 1 });
    expect(plan.steps[0]).toMatchObject({ dependencies: [], resourceLocks: [] });
  });

  it("exposes exactly the requested operation discriminants", () => {
    const operations: PlanOperation[] = [
      { type: "addTask", expectedVersion: 1, step: step("b") },
      { type: "editTask", expectedVersion: 1, stepId: "a", changes: {} },
      { type: "removeTask", expectedVersion: 1, stepId: "a" },
      { type: "moveTask", expectedVersion: 1, stepId: "a", index: 0 },
      { type: "supersedeTask", expectedVersion: 1, stepId: "a", replacement: step("b") },
      { type: "splitTask", expectedVersion: 1, stepId: "a", steps: [step("b"), step("c")] },
      { type: "mergeTasks", expectedVersion: 1, stepIds: ["a", "b"], step: step("c") },
      { type: "setDependencies", expectedVersion: 1, stepId: "a", dependencies: [] },
    ];
    expect(operations.map((operation) => operation.type)).toEqual(["addTask", "editTask", "removeTask", "moveTask", "supersedeTask", "splitTask", "mergeTasks", "setDependencies"]);
  });

  it("applies operations immutably, increments versions, and rejects stale writes", () => {
    const plan = deserializeTaskPlan(legacy);
    const added = applyPlanOperation(plan, { type: "addTask", expectedVersion: 1, step: step("b", ["a"]) });
    const edited = applyPlanOperation(added, { type: "editTask", expectedVersion: 2, stepId: "b", changes: { title: "build" } });
    const deps = applyPlanOperation(edited, { type: "setDependencies", expectedVersion: 3, stepId: "b", dependencies: [] });
    expect(plan.steps).toHaveLength(1);
    expect(deps).toMatchObject({ version: 4, steps: [{ id: "a" }, { id: "b", title: "build", dependencies: [] }] });
    expect(() => applyPlanOperation(deps, { type: "removeTask", expectedVersion: 3, stepId: "b" })).toThrow(/version mismatch/);
    expect(applyPlanOperation(deps, { type: "removeTask", expectedVersion: 4, stepId: "b" }).steps).toHaveLength(1);
  });


  it("moves a task without changing its durable fields", () => {
    const plan = deserializeTaskPlan({
      ...legacy,
      steps: [
        { ...step("a"), status: "done" },
        { ...step("b", ["a"]), notes: "evidence retained" },
        step("c", ["b"]),
      ],
    });
    const moved = applyPlanOperation(plan, {
      type: "moveTask",
      expectedVersion: 1,
      stepId: "c",
      index: 1,
    });
    expect(moved.steps.map((item) => item.id)).toEqual(["a", "c", "b"]);
    expect(moved.steps.find((item) => item.id === "c")?.dependencies).toEqual(["b"]);
    expect(plan.steps.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });
  it("supports supersede, split, and merge while rewiring dependencies", () => {
    let plan = deserializeTaskPlan({ ...legacy, steps: [step("a"), step("b", ["a"]), step("c", ["b"])] });
    plan = applyPlanOperation(plan, { type: "supersedeTask", expectedVersion: 1, stepId: "b", replacement: step("b2") });
    expect(plan.steps.find((s) => s.id === "c")?.dependencies).toEqual(["b2"]);
    plan = applyPlanOperation(plan, { type: "splitTask", expectedVersion: 2, stepId: "c", steps: [step("c1"), step("c2")] });
    expect(plan.steps.find((s) => s.id === "c2")?.dependencies).toEqual(["c1"]);
    plan = applyPlanOperation(plan, { type: "mergeTasks", expectedVersion: 3, stepIds: ["c1", "c2"], step: step("c3") });
    expect(plan.steps.some((s) => s.id === "c3")).toBe(true);
  });

  it("validates DAGs and computes readiness with dependencies and locks", () => {
    expect(validatePlanDag({ steps: [step("a", ["b"]), step("b", ["a"])] })).toMatchObject({ ok: false });
    const plan = deserializeTaskPlan({ ...legacy, steps: [{ ...step("a"), status: "done" }, { ...step("lock"), status: "running", resourceLocks: ["repo"] }, step("b", ["a"], ["repo"]), step("c", ["a"], ["network"])] });
    expect(readyPlanSteps(plan).map((s) => s.id)).toEqual(["c"]);
  });

  it("applies immutable versioned operations to persisted SessionPlan shape", () => {
    const plan = createPlan({
      sessionId: "session-plan",
      goal: "ship",
      detail: "",
      taskTitles: ["inspect", "build"],
    });
    const updated = applySessionPlanOperation(plan, {
      type: "addTask",
      expectedVersion: 1,
      step: step("verify", ["t2"], ["repo"]),
    });
    expect(plan.tasks).toHaveLength(2);
    expect(updated.version).toBe(2);
    expect(updated.tasks.map((task) => task.id)).toEqual(["t1", "t2", "verify"]);
    expect(readyPlanTasks(updated).map((task) => task.id)).toEqual(["t1"]);
    expect(() =>
      applySessionPlanOperation(updated, {
        type: "removeTask",
        expectedVersion: 1,
        stepId: "verify",
      }),
    ).toThrow(/version mismatch/);
  });
});
