/**
 * OpenTUI crashes when React sets <text content={null|undefined}>:
 * setStyledText(null) → text.chunks throws. Coerce nullish / invalid values
 * to a single space so transient unmount/update races never take down the TUI.
 */

import { TextRenderable, stringToStyledText, StyledText } from "@opentui/core";

let patched = false;

function isStyledText(value: unknown): value is StyledText {
  return (
    value instanceof StyledText ||
    (typeof value === "object" &&
      value !== null &&
      Array.isArray((value as { chunks?: unknown }).chunks))
  );
}

export function patchOpenTuiTextContent(): void {
  if (patched) return;
  patched = true;

  const proto = TextRenderable.prototype as unknown as {
    content: unknown;
  };
  const desc = Object.getOwnPropertyDescriptor(proto, "content");
  if (!desc?.set || !desc.get) return;

  const originalSet = desc.set;
  Object.defineProperty(proto, "content", {
    configurable: true,
    enumerable: desc.enumerable ?? true,
    get: desc.get,
    set(value: unknown) {
      if (value == null) {
        originalSet.call(this, " ");
        return;
      }
      if (typeof value === "string") {
        originalSet.call(this, value.length === 0 ? " " : value);
        return;
      }
      if (isStyledText(value)) {
        if (!value.chunks || value.chunks.length === 0) {
          originalSet.call(this, " ");
          return;
        }
        originalSet.call(this, value);
        return;
      }
      try {
        originalSet.call(this, stringToStyledText(String(value)));
      } catch {
        originalSet.call(this, " ");
      }
    },
  });
}
