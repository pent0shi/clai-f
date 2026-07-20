import { describe, expect, it } from "vitest";
import { sanitizeTitle } from "../src/agent/session-title.js";

describe("sanitizeTitle reasoning stripping", () => {
  it("strips <think> reasoning before the title", () => {
    expect(sanitizeTitle("<think>let me name this</think>Fix login bug")).toBe(
      "Fix login bug",
    );
  });

  it("strips Kimi's <thinking> reasoning before the title", () => {
    expect(
      sanitizeTitle("<thinking>pick a concise title</thinking>Refactor parser"),
    ).toBe("Refactor parser");
  });

  it("drops an unclosed <thinking> block that swallows the answer", () => {
    expect(sanitizeTitle("<thinking>still reasoning with no close")).toBeUndefined();
  });
});
