import { describe, expect, it } from "vitest";
import { StyledText, stringToStyledText } from "@opentui/core";
import { patchOpenTuiTextContent } from "../src/tui-v2/bootstrap/patch-opentui-text.js";

describe("patchOpenTuiTextContent", () => {
  it("is idempotent and exports a callable patch", () => {
    expect(() => {
      patchOpenTuiTextContent();
      patchOpenTuiTextContent();
    }).not.toThrow();
  });

  it("StyledText with chunks remains valid for content assignment", () => {
    const st = stringToStyledText("hello");
    expect(st.chunks?.length).toBeGreaterThan(0);
    const emptyish = new StyledText([]);
    // Empty chunks should still be a defined object with an array
    expect(Array.isArray(emptyish.chunks)).toBe(true);
  });
});
