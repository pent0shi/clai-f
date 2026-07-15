import chalk from "chalk";

export const ANSI_SGR_PATTERN = /\x1b\[[0-9;]*m/g;

/** Full CSI / OSC / DCS (not SGR-only) so model text cannot leak cursor junk. */
const ANSI_ESCAPE_FULL_RE =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|P[^\x1b]*(?:\x1b\\)?|[@-Z\\_])/g;
const CONTROL_CHARS_RE = /[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f\x80-\x9f]/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_ESCAPE_FULL_RE, "").replace(ANSI_SGR_PATTERN, "");
}

/** Sanitize assistant-visible / history text (X9). */
export function sanitizeAssistantText(text: string): string {
  return text.replace(ANSI_ESCAPE_FULL_RE, "").replace(CONTROL_CHARS_RE, "");
}

/** Draws a bordered box around the given lines, padded to a common width. */
export function box(
  lines: string[],
  opts: { color?: (s: string) => string; minWidth?: number } = {},
): string {
  const color = opts.color ?? chalk.gray;
  const contentWidth = Math.max(
    opts.minWidth ?? 60,
    ...lines.map((l) => stripAnsi(l).length),
  );
  const top = color(`╭${"─".repeat(contentWidth + 2)}╮`);
  const bottom = color(`╰${"─".repeat(contentWidth + 2)}╯`);
  const padded = lines.map((l) => {
    const pad = contentWidth - stripAnsi(l).length;
    return `${color("│")} ${l}${" ".repeat(Math.max(0, pad))} ${color("│")}`;
  });
  return [top, ...padded, bottom].map((line) => `  ${line}`).join("\n");
}
