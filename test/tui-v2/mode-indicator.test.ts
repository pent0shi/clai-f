import { describe, expect, it } from "vitest";
import { modeIndicatorPresentation, tasksToggleLabel } from "../../src/tui-v2/components/status/status-line.js";

describe("composer mode indicator", () => {
  it("labels the active Tasks pane action for visible and hidden states", () => {
    expect(tasksToggleLabel(true)).toBe("Ctrl+H · HIDE TASKS");
    expect(tasksToggleLabel(false)).toBe("Ctrl+H · SHOW TASKS");
    expect(tasksToggleLabel(true, true)).toBe("HIDE TASKS");
    expect(tasksToggleLabel(false, true)).toBe("SHOW TASKS");
  });

  it("presents concise, distinct copy for every live session mode", () => {
    expect(modeIndicatorPresentation("ask")).toEqual({
      label: "ASK",
      description: "",
    });
    expect(modeIndicatorPresentation("agent")).toEqual({
      label: "AGENT",
      description: "",
    });
    expect(modeIndicatorPresentation("plan")).toEqual({
      label: "PLAN",
      description: "",
    });
  });
});
