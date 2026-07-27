import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  armedCancelHint,
  busyCancelHint,
  contextChipForDensity,
  idleHintIds,
  statusDensityForWidth,
  type StatusDensity,
} from "../../src/tui-v2/components/status/status-line.js";

const DENSITIES: StatusDensity[] = ["xs", "sm", "md", "lg"];
const STATUS_LINE = "src/tui-v2/components/status/status-line.tsx";
const APP = "src/tui-v2/app/App.tsx";

describe("status line hints and Esc semantics", () => {
  it("uses a compact cancel hint and a direct second-Esc instruction", () => {
    for (const density of DENSITIES) {
      expect(busyCancelHint(density)).toEqual({
        short: "esc: cancel",
        expand: "cancel active work",
      });
    }
    expect(armedCancelHint()).toBe("esc again to cancel");
  });

  it("thins the optional idle chord row and hides it entirely when narrow", () => {
    expect(idleHintIds("xs")).toEqual([]);
    expect(idleHintIds("sm")).toEqual([]);
    expect(idleHintIds("md")).toEqual(["commands", "thinking", "output"]);
    expect(idleHintIds("lg")).toEqual([
      "commands",
      "thinking",
      "output",
      "shortcuts",
    ]);
  });

  it("maps widths to the densities the hint rows are built for", () => {
    expect(statusDensityForWidth(40)).toBe("xs");
    expect(statusDensityForWidth(100)).toBe("lg");
  });

  it("shows only the raw context count at every density", () => {
    const usage = {
      contextTokens: 54_000,
      contextLimit: 80_000,
      lastCompletionTokens: 80,
      sessionPromptTokens: 54_000,
      sessionCompletionTokens: 80,
      exact: true,
    };
    for (const density of DENSITIES) {
      expect(contextChipForDensity(usage, density)).toBe("ctx 54,000");
    }
  });

  it("routes clicks through the same arm/confirm path as Esc", () => {
    const statusLine = readFileSync(STATUS_LINE, "utf8");
    expect(statusLine).toContain("onClick={onRequestCancel}");
    expect(statusLine).not.toContain("void session.cancelAll()");

    const app = readFileSync(APP, "utf8");
    expect(app).toContain("cancelArmed={escapeCancelArmed}");
    expect(app).toContain("onRequestCancel={() => handleEscapeCancellation(false)}");
    expect(app).toContain("}, ESC_CANCEL_WINDOW_MS)");
  });

  it("uses fixed separators without reserved hover width or idle cancel chrome", () => {
    const statusLine = readFileSync(STATUS_LINE, "utf8");
    const idleBranch = statusLine.split("// ── Idle")[1] ?? "";
    expect(statusLine).not.toContain("padEnd(hintWidth");
    expect(statusLine).toContain('content=" │ "');
    expect(statusLine).not.toContain('content="  "');
    expect(idleBranch).not.toContain('"esc: cancel"');
  });
});
