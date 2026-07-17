/**
 * Composer overrides for the native Textarea key-binding table (INPUT-002,
 * V2-040/041).
 *
 * OpenTUI's `TextareaRenderable` already implements move/select/word/delete/
 * undo semantics (INPUT-004/005) — this module only overrides the small set
 * of chords where the library default is backwards for a submit-on-Enter
 * composer (its default binds bare Enter to "newline" and Alt+Enter to
 * "submit"), plus macOS line-delete chords that conflict with chat scroll.
 * Everything else passes through untouched. The shape here mirrors
 * `@opentui/core`'s `KeyBinding<TextareaAction>` structurally without
 * importing it, keeping this module renderer-independent; the renderer glue
 * casts it at the one place it is consumed.
 */

export type TextareaActionName =
  | "submit"
  | "newline"
  | "delete-to-line-start"
  | "delete-to-line-end"
  | "delete-line";

export interface TextareaKeyBindingLike {
  readonly name: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
  readonly super?: boolean;
  readonly action: TextareaActionName;
}

const ENTER_NAMES = ["return", "kpenter"] as const;

export function buildComposerTextareaOverrides(): TextareaKeyBindingLike[] {
  const overrides: TextareaKeyBindingLike[] = [];
  for (const name of ENTER_NAMES) {
    // Bare Enter → submit. Newline chords cover every OS/terminal that can
    // report a modifier on Return (Shift, Alt/Option/meta, Ctrl).
    overrides.push({ name, action: "submit" });
    overrides.push({ name, shift: true, action: "newline" });
    overrides.push({ name, meta: true, action: "newline" });
    overrides.push({ name, ctrl: true, action: "newline" });
  }

  // Line kill: readline Ctrl+U and macOS Cmd+Backspace/Delete.
  // OpenTUI defaults map meta+backspace → delete-word-backward; override to
  // delete-to-line-start so Cmd+Backspace matches macOS text fields. Explicit
  // ctrl+u keeps delete-to-line-start even if library defaults change.
  // (Chat jump-to-top is NOT bound globally on ctrl+u — see keymap.ts.)
  overrides.push({ name: "u", ctrl: true, action: "delete-to-line-start" });
  overrides.push({
    name: "backspace",
    meta: true,
    action: "delete-to-line-start",
  });
  overrides.push({
    name: "backspace",
    super: true,
    action: "delete-to-line-start",
  });
  overrides.push({
    name: "delete",
    meta: true,
    action: "delete-to-line-end",
  });
  overrides.push({
    name: "delete",
    super: true,
    action: "delete-to-line-end",
  });

  return overrides;
}
