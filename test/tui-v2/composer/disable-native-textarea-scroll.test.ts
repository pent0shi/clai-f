import { describe, expect, it, vi } from "vitest";
import { disableNativeTextareaScroll } from "../../../src/tui-v2/composer/disable-native-textarea-scroll.js";

describe("disableNativeTextareaScroll", () => {
  it("blocks native onMouseEvent for scroll but keeps other events", () => {
    const native = vi.fn();
    class FakeEditor {
      onMouseEvent(event: { type?: string }): void {
        native(event);
      }
    }
    const editor = new FakeEditor();
    const restore = disableNativeTextareaScroll(editor);

    editor.onMouseEvent({ type: "scroll" });
    expect(native).not.toHaveBeenCalled();

    editor.onMouseEvent({ type: "down" });
    expect(native).toHaveBeenCalledWith({ type: "down" });

    restore();
    editor.onMouseEvent({ type: "scroll" });
    expect(native).toHaveBeenCalledWith({ type: "scroll" });
  });

  it("is a no-op for null editors", () => {
    expect(() => disableNativeTextareaScroll(null)()).not.toThrow();
  });
});
