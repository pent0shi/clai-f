import { describe, expect, it } from "vitest";
import { toastLabel } from "../../src/tui-v2/components/toast/toast-host.js";
import { TOAST_BOX_HEIGHT } from "../../src/tui-v2/components/toast/toast-anim.js";
import { MAX_TOAST_MESSAGE_CHARS } from "../../src/tui-v2/controllers/toast-controller.js";

describe("toast notification chip", () => {
  it("is a roomy 3-row solid bar", () => {
    expect(TOAST_BOX_HEIGHT).toBe(3);
  });

  it("includes full message in the label (no mid-string clip helper)", () => {
    const msg = "Tasks hidden · ^H";
    const label = toastLabel("info", msg);
    expect(label).toContain(msg);
    expect(label.startsWith("   ")).toBe(true); // H_PAD = 3
    expect(label.endsWith("   ")).toBe(true);
  });

  it("allows long status lines through the controller cap", () => {
    expect(MAX_TOAST_MESSAGE_CHARS).toBeGreaterThanOrEqual(200);
  });
});
