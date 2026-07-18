/**
 * Soft-wrap helpers for user prompt bubbles in the transcript.
 *
 * Long prompts must reflow to the chat-pane width when the tasks pane is open
 * (assistant markdown already does this). Never ellipsis-truncate.
 */

import { wrapPlainString } from "../../tui/text-format.js";

/**
 * Columns reserved for the YOU badge + gap + box padding/border.
 * " YOU " (5) + gap (1) + horizontal padding (2) + border (2) ≈ 10.
 */
export const USER_MESSAGE_CHROME_COLS = 10;

/**
 * Soft-wrap a user prompt to the chat-pane width (plan split already subtracted).
 * Never ellipsis-truncates — every character lands on some line.
 */
export function wrapUserPrompt(text: string, contentWidth: number): string[] {
  const wrapWidth = Math.max(12, contentWidth - USER_MESSAGE_CHROME_COLS);
  return wrapPlainString(text, wrapWidth).map((line) => line.lineText);
}
