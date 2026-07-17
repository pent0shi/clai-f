import { describe, expect, it } from "vitest";
import {
  modeIndicatorPresentation,
  statusDensityForWidth,
  tasksToggleLabel,
} from "../../src/tui-v2/components/status/status-line.js";

describe("composer mode indicator", () => {
  it("maps width to density tiers", () => {
    expect(statusDensityForWidth(40)).toBe("xs");
    expect(statusDensityForWidth(55)).toBe("sm");
    expect(statusDensityForWidth(80)).toBe("md");
    expect(statusDensityForWidth(100)).toBe("lg");
  });

  it("labels the active Tasks pane action by density", () => {
    expect(tasksToggleLabel(true, "lg")).toBe("^H · hide");
    expect(tasksToggleLabel(false, "lg")).toBe("^H · show");
    expect(tasksToggleLabel(true, "md")).toBe("^H hide");
    expect(tasksToggleLabel(false, "md")).toBe("^H show");
    expect(tasksToggleLabel(true, "sm")).toBe("^H");
    expect(tasksToggleLabel(false, "sm")).toBe("^H");
    // boolean compact back-compat
    expect(tasksToggleLabel(true, true)).toBe("^H");
    expect(tasksToggleLabel(false, false)).toBe("^H · show");
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
