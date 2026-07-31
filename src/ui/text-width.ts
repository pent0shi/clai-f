/**
 * Column budgeting that no renderer can overflow.
 *
 * Two measurement models disagree on non-Latin text:
 *
 *  - `string-width` (wcwidth): combining marks count 0, CJK counts 2. This is
 *    what a terminal actually advances the cursor by.
 *  - OpenTUI's text buffer: one cell per UTF-16 code unit. A Devanagari matra,
 *    a ZWJ, and each half of a surrogate pair all take a cell.
 *
 * Budgeting with the smaller of the two lets a row render wider than the box we
 * reserved for it. The surplus is painted outside that box, so no row owns those
 * cells and nothing ever repaints them — stale glyphs pile up at the pane edge
 * as the viewport scrolls (`सूचना` leaking `अ` down the right-hand column).
 *
 * Taking the larger of the two is identical for ASCII, honours double-width CJK,
 * and reserves the cell OpenTUI will actually consume for marks and emoji. Worst
 * case a complex-script line wraps a column or two early, which is invisible;
 * the alternative smears the UI.
 */

import stringWidth from "string-width";

// biome-ignore lint: ANSI escape sequences are intentional.
const SGR = /\x1b\[[0-9;]*m/g;

/** Columns to reserve for `text`, safe under both measurement models. */
export function renderColumns(text: string): number {
  if (text.length === 0) return 0;
  const plain = text.includes("\x1b") ? text.replace(SGR, "") : text;
  return Math.max(stringWidth(plain), plain.length);
}
