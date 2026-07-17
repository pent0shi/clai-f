import { describe, expect, it } from "vitest";
import { buildComposerTextareaOverrides } from "../../../src/tui-v2/composer/textarea-keybindings.js";

describe("buildComposerTextareaOverrides", () => {
  const overrides = buildComposerTextareaOverrides();

  it("binds bare Enter and numpad Enter to submit", () => {
    expect(overrides).toContainEqual({ name: "return", action: "submit" });
    expect(overrides).toContainEqual({ name: "kpenter", action: "submit" });
  });

  it("binds Shift+Enter to newline, overriding the unbound default", () => {
    expect(overrides).toContainEqual({
      name: "return",
      shift: true,
      action: "newline",
    });
  });

  it("binds Alt/Option+Enter (meta) to newline, overriding the submit default", () => {
    expect(overrides).toContainEqual({
      name: "return",
      meta: true,
      action: "newline",
    });
  });

  it("binds Ctrl+Enter to newline as a cross-OS fallback", () => {
    expect(overrides).toContainEqual({
      name: "return",
      ctrl: true,
      action: "newline",
    });
  });

  it("never leaves Ctrl+J / linefeed bound to newline (jobs owns it globally)", () => {
    expect(overrides.some((o) => o.name === "linefeed")).toBe(false);
    expect(overrides.some((o) => o.name === "j" && o.ctrl)).toBe(false);
  });

  it("binds Option/Alt (meta) + Backspace/Delete to word delete", () => {
    expect(overrides).toContainEqual({
      name: "backspace",
      meta: true,
      action: "delete-word-backward",
    });
    expect(overrides).toContainEqual({
      name: "delete",
      meta: true,
      action: "delete-word-forward",
    });
  });

  it("binds Cmd (super) + Backspace/Delete to delete the whole line", () => {
    expect(overrides).toContainEqual({
      name: "backspace",
      super: true,
      action: "delete-line",
    });
    expect(overrides).toContainEqual({
      name: "delete",
      super: true,
      action: "delete-line",
    });
  });

  it("binds Ctrl + Backspace/Delete/U to full-line kill (Windows + terminal Cmd)", () => {
    expect(overrides).toContainEqual({
      name: "backspace",
      ctrl: true,
      action: "delete-line",
    });
    expect(overrides).toContainEqual({
      name: "delete",
      ctrl: true,
      action: "delete-line",
    });
    expect(overrides).toContainEqual({
      name: "u",
      ctrl: true,
      action: "delete-line",
    });
  });
});
