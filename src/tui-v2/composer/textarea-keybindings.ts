/**
 * Composer overrides for the native Textarea key-binding table (INPUT-002,
 * V2-040/041).
 *
 * OpenTUI's `TextareaRenderable` already implements move/select/word/delete/
 * undo semantics (INPUT-004/005) — this module only overrides the small set
 * of chords where the library default is wrong for a submit-on-Enter
 * composer, plus explicit word vs line kill chords:
 *
 *   Option/Alt + Backspace/Delete  → delete one word
 *   Cmd (Mac) / Ctrl (Win) + Backspace/Delete → delete whole line
 *
 * Terminals report modifiers inconsistently: Option is usually `meta`, Cmd
 * is usually `super` (and sometimes arrives as Ctrl+U for Backspace).
 */

export type TextareaActionName =
  | "submit"
  | "newline"
  | "delete-to-line-start"
  | "delete-to-line-end"
  | "delete-line"
  | "delete-word-backward"
  | "delete-word-forward";

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

  // ── Word kill: Option/Alt (+Backspace/Delete)
  // On macOS terminals, Option almost always arrives as `meta`.
  overrides.push({
    name: "backspace",
    meta: true,
    action: "delete-word-backward",
  });
  overrides.push({
    name: "delete",
    meta: true,
    action: "delete-word-forward",
  });

  // ── Full line kill: Cmd (super) and Ctrl (Windows / some terminals)
  // OpenTUI default maps ctrl+backspace → word; override to whole line.
  overrides.push({ name: "backspace", super: true, action: "delete-line" });
  overrides.push({ name: "delete", super: true, action: "delete-line" });
  overrides.push({ name: "backspace", ctrl: true, action: "delete-line" });
  overrides.push({ name: "delete", ctrl: true, action: "delete-line" });

  // readline Ctrl+U and many terminals' Cmd+Backspace → Ctrl+U encoding.
  overrides.push({ name: "u", ctrl: true, action: "delete-line" });
  // Ctrl+K keeps "kill to end of line" (readline) for power users.
  overrides.push({ name: "k", ctrl: true, action: "delete-to-line-end" });

  return overrides;
}
