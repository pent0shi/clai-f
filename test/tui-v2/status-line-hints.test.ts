import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  busyCancelHint,
  idleHintIds,
  statusDensityForWidth,
  type StatusDensity,
} from "../../src/tui-v2/components/status/status-line.js";

const DENSITIES: StatusDensity[] = ["xs", "sm", "md", "lg"];
const STATUS_LINE = "src/tui-v2/components/status/status-line.tsx";
const APP = "src/tui-v2/app/App.tsx";

describe("status line hints and Esc semantics (TUI-007)", () => {
  it("uses one stop vocabulary on the busy row at every density", () => {
    for (const density of DENSITIES) {
      const hint = busyCancelHint(density);
      expect(hint.short.startsWith("Esc×2")).toBe(true);
      expect(hint.expand).toBe("stop turn, queue, and jobs");
      expect(hint.short).not.toMatch(/cancel/i);
    }
    expect(busyCancelHint("sm").short).toBe("Esc×2");
    expect(busyCancelHint("lg").short).toBe("Esc×2 stop");
  });

  it("thins the idle chord row and hides it entirely when narrow", () => {
    expect(idleHintIds("xs")).toEqual([]);
    expect(idleHintIds("sm")).toEqual([]);
    expect(idleHintIds("md")).toEqual(["commands", "thinking", "output"]);
    expect(idleHintIds("lg")).toEqual([
      "commands",
      "thinking",
      "output",
      "shortcuts",
    ]);
    for (const density of DENSITIES) {
      expect(idleHintIds(density).length).toBeLessThanOrEqual(4);
    }
  });

  it("maps widths to the densities the hint rows are built for", () => {
    expect(statusDensityForWidth(40)).toBe("xs");
    expect(statusDensityForWidth(100)).toBe("lg");
  });

  it("routes the busy-row click through the same arm/confirm path as Esc", () => {
    const statusLine = readFileSync(STATUS_LINE, "utf8");
    expect(statusLine).toContain("onClick={onRequestCancel}");
    // The old path fired cancelAll() straight from the chip, skipping arming.
    expect(statusLine).not.toContain("void session.cancelAll()");

    const app = readFileSync(APP, "utf8");
    expect(app).toContain("onRequestCancel={() => handleEscapeCancellation(false)}");
  });

  it("reserves hover width so details never reflow neighbours", () => {
    const statusLine = readFileSync(STATUS_LINE, "utf8");
    expect(statusLine).toContain("padEnd(hintWidth(short, full)");
  });
});
