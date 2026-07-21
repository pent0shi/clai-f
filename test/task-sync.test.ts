import { describe, expect, it } from "vitest";
import type { ToolCall } from "../src/types.js";
import {
  advancingStateCounts,
  batchUpdateSignature,
  buildDependencyReminder,
  buildMultiUpdateReminder,
  dependencySignature,
  dependencyToast,
  distinctAdvancingTaskIds,
  isSimultaneousTaskAdvance,
  multiUpdateToast,
  readTaskUpdateArgs,
  type TaskUpdateIntent,
} from "../src/agent/task-sync.js";

function update(taskId: string, state: string): ToolCall {
  return { name: "task.update", args: { taskId, state } };
}

function intent(taskId: string, state: string): TaskUpdateIntent {
  return { call: update(taskId, state), taskId, state };
}

describe("readTaskUpdateArgs", () => {
  it("reads taskId/state from task.update", () => {
    expect(readTaskUpdateArgs(update("t1", "done"))).toEqual({
      taskId: "t1",
      state: "done",
    });
  });

  it("accepts the id alias", () => {
    expect(
      readTaskUpdateArgs({ name: "task.update", args: { id: "t2", state: "in_progress" } }),
    ).toEqual({ taskId: "t2", state: "in_progress" });
  });

  it("ignores non-task.update calls and incomplete args", () => {
    expect(readTaskUpdateArgs({ name: "fs.read", args: { path: "x" } })).toBeUndefined();
    expect(readTaskUpdateArgs({ name: "task.update", args: { taskId: "t1" } })).toBeUndefined();
    expect(readTaskUpdateArgs({ name: "task.update", args: { state: "done" } })).toBeUndefined();
  });
});

describe("distinctAdvancingTaskIds", () => {
  it("counts only done / in_progress distinct tasks", () => {
    const intents = [
      intent("t1", "done"),
      intent("t2", "in_progress"),
      intent("t3", "failed"),
      intent("t4", "skipped"),
    ];
    expect(distinctAdvancingTaskIds(intents).sort()).toEqual(["t1", "t2"]);
  });

  it("dedupes the same task opened then completed", () => {
    const intents = [intent("t1", "in_progress"), intent("t1", "done")];
    expect(distinctAdvancingTaskIds(intents)).toEqual(["t1"]);
  });
});

describe("advancingStateCounts", () => {
  it("counts distinct done and in_progress tasks separately", () => {
    const counts = advancingStateCounts([
      intent("t1", "done"),
      intent("t2", "in_progress"),
      intent("t3", "failed"),
    ]);
    expect(counts).toEqual({ done: 1, inProgress: 1 });
  });

  it("dedupes repeats within a state", () => {
    const counts = advancingStateCounts([
      intent("t1", "done"),
      intent("t1", "done"),
      intent("t2", "in_progress"),
      intent("t3", "in_progress"),
    ]);
    expect(counts).toEqual({ done: 1, inProgress: 2 });
  });
});

describe("isSimultaneousTaskAdvance", () => {
  it("is true when more than one task is completed at once", () => {
    expect(isSimultaneousTaskAdvance([intent("t1", "done"), intent("t2", "done")])).toBe(true);
  });

  it("is true when more than one task is opened at once", () => {
    expect(
      isSimultaneousTaskAdvance([intent("t1", "in_progress"), intent("t2", "in_progress")]),
    ).toBe(true);
  });

  it("allows the canonical handoff: close one task and open the next", () => {
    expect(
      isSimultaneousTaskAdvance([intent("t1", "done"), intent("t2", "in_progress")]),
    ).toBe(false);
  });

  it("is false for a single task open+close in one message", () => {
    expect(
      isSimultaneousTaskAdvance([intent("t1", "in_progress"), intent("t1", "done")]),
    ).toBe(false);
  });

  it("is false when the batch only marks failed/skipped", () => {
    expect(
      isSimultaneousTaskAdvance([intent("t1", "failed"), intent("t2", "skipped")]),
    ).toBe(false);
  });

  it("is false for zero or one intent", () => {
    expect(isSimultaneousTaskAdvance([])).toBe(false);
    expect(isSimultaneousTaskAdvance([intent("t1", "done")])).toBe(false);
  });
});

describe("batchUpdateSignature", () => {
  it("is stable regardless of intent order", () => {
    const a = batchUpdateSignature([intent("t1", "done"), intent("t2", "in_progress")]);
    const b = batchUpdateSignature([intent("t2", "in_progress"), intent("t1", "done")]);
    expect(a).toBe(b);
  });

  it("differs when the target set changes", () => {
    const a = batchUpdateSignature([intent("t1", "done"), intent("t2", "done")]);
    const b = batchUpdateSignature([intent("t1", "done"), intent("t3", "done")]);
    expect(a).not.toBe(b);
  });
});

describe("dependencySignature", () => {
  it("is stable regardless of blocker order", () => {
    expect(dependencySignature("t3", "in_progress", ["t1", "t2"])).toBe(
      dependencySignature("t3", "in_progress", ["t2", "t1"]),
    );
  });
});

describe("reminder + toast copy", () => {
  it("lists every batched task in the multi-update reminder", () => {
    const text = buildMultiUpdateReminder([
      { taskId: "t1", title: "Scaffold", targetState: "done" },
      { taskId: "t2", title: "Implement feature", targetState: "done" },
      { taskId: "t3", title: "Wire routing", targetState: "in_progress" },
    ]);
    expect(text).toContain("HELD");
    expect(text).toContain("[t1] Scaffold → done");
    expect(text).toContain("[t2] Implement feature → done");
    expect(text).toContain("[t3] Wire routing → in_progress");
    expect(text).toMatch(/re-issue these exact task\.update calls/i);
    expect(text).toMatch(/one task at a time/i);
  });

  it("names the blocking prerequisites in the dependency reminder", () => {
    const text = buildDependencyReminder({
      taskId: "t3",
      title: "Run and verify",
      targetState: "in_progress",
      blockers: [{ id: "t2", title: "Install deps" }],
    });
    expect(text).toContain("[t3]");
    expect(text).toContain("[t2] Install deps");
    expect(text).toMatch(/re-issue this exact task\.update to CONFIRM/i);
  });

  it("produces short identifiable toasts", () => {
    expect(multiUpdateToast(3)).toContain("3 task updates batched");
    expect(dependencyToast("t3")).toContain("[t3]");
  });
});
