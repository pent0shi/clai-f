/**
 * OpenTUI EditBuffer always runs native `handleScroll` in `onMouseEvent`
 * *after* JSX `onMouseScroll` listeners, and it never checks `scrollSpeed`.
 * That dual-path is what made draft + chat both move when the pointer was
 * over an unfocused composer.
 *
 * Patch the instance so scroll events skip native viewport motion; our
 * composer wheel policy (focus-strict) is the only scroll path.
 *
 * Note: `onMouseEvent` is protected on TextareaRenderable — we patch via a
 * structural cast so the public API stays untyped for that field.
 */

type Mouseish = { readonly type?: string };
type Patchable = {
  onMouseEvent: (event: Mouseish) => void;
};

export function disableNativeTextareaScroll(
  editor: object | null | undefined,
): () => void {
  if (!editor) return () => {};
  const target = editor as Patchable;
  const proto = Object.getPrototypeOf(editor) as Patchable | null;
  const original = proto?.onMouseEvent;
  if (typeof original !== "function") return () => {};

  target.onMouseEvent = function patchedOnMouseEvent(
    this: unknown,
    event: Mouseish,
  ) {
    // Swallow native draft wheel only — other mouse events stay intact.
    if (event?.type === "scroll") return;
    return original.call(this, event);
  };

  return () => {
    target.onMouseEvent = original.bind(editor);
  };
}
