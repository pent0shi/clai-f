/**
 * Safe markdown preparation for the full-screen pager.
 *
 * - Markdown docs (help, shortcuts, plan) force-render with classic parity.
 * - Tool / log / plain bodies use a conservative heuristic so normal output
 *   is not mangled by italic underscores or stray asterisks.
 * - Any render failure falls back to plain lines (never throws into the UI).
 */

import { renderMarkdownLines } from "./render-markdown-lines.js";
import { sanitizeDisplayText } from "./sanitize-display.js";

export type PagerMarkdownMode = "auto" | "force" | "plain";

/** Opaque styled line from renderMarkdownLines (avoids @opentui import here). */
export type PagerStyledLine = ReturnType<typeof renderMarkdownLines>[number];

export interface PagerDisplayLine {
  /** Plain text used for search, line counts, and export fallbacks. */
  readonly plain: string;
  /**
   * Pre-styled line when markdown rendered successfully.
   * Undefined → paint as plain `plain` with baseLineFg heuristics.
   */
  readonly styled?: PagerStyledLine | undefined;
}

export interface PreparePagerDisplayOptions {
  readonly body: string;
  readonly width: number;
  readonly mode?: PagerMarkdownMode | undefined;
  /** Default body foreground when markdown renders (theme.foreground). */
  readonly defaultFg?: string | undefined;
}

/**
 * Strip file-diff / modal line gutters (`  12 │ ` / `     │ ± `) so format
 * mode can render real markdown instead of gutter-polluted source.
 * Leaves non-guttered lines unchanged (help, compact cards, tool dumps).
 */
export function stripPagerLineGutters(body: string): string {
  if (!body) return body;
  return body
    .split("\n")
    .map((line) => {
      // formatModalPlainText: `<lineno> │ [+/-/ ]body`
      const withMark = /^(?:[\d ]{0,8}) │ ([+\-−] )?(.*)$/.exec(line);
      if (withMark) {
        // Diff marks stay only in raw view; format wants pure file text.
        return withMark[2] ?? "";
      }
      return line;
    })
    .join("\n");
}

/**
 * Conservative detector: only claim "markdown" when structure is clear.
 * Avoids mangling paths_with_underscores and shell output with * globs.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text || text.length < 8) return false;
  let score = 0;
  if (/^#{1,6}\s+\S/m.test(text)) score += 2;
  if (/^```[\w-]*\s*$/m.test(text)) score += 2;
  if (/^\|.+\|/m.test(text) && /^\|?[\s:|-]{3,}/m.test(text)) score += 2;
  if (/^>\s+\S/m.test(text)) score += 1;
  // Multiple bold spans or list items separated by blank lines
  const bold = text.match(/\*\*[^*\n]{1,80}\*\*/g);
  if (bold && bold.length >= 2) score += 1;
  if (/^[-*]\s+\S.+\n\n/m.test(text) || /^\d+\.\s+\S.+\n\n/m.test(text)) {
    score += 1;
  }
  // Explicit horizontal rules common in our docs
  if (/^---+\s*$/m.test(text) || /^\*\*\*+\s*$/m.test(text)) score += 1;
  return score >= 2;
}

function plainLines(body: string): PagerDisplayLine[] {
  const raw = body.replace(/\n+$/, "");
  if (!raw) return [{ plain: " " }];
  return raw.split("\n").map((line) => ({ plain: line.length === 0 ? " " : line }));
}

/**
 * Prepare body lines for the pager. Never throws.
 */
export function preparePagerDisplay(
  options: PreparePagerDisplayOptions,
): { readonly mode: "markdown" | "plain"; readonly lines: readonly PagerDisplayLine[] } {
  const mode = options.mode ?? "auto";
  const body = options.body ?? "";
  const width = Math.max(24, options.width);

  if (mode === "plain") {
    return { mode: "plain", lines: plainLines(body) };
  }

  const wantMarkdown =
    mode === "force" || (mode === "auto" && looksLikeMarkdown(body));

  if (!wantMarkdown) {
    return { mode: "plain", lines: plainLines(body) };
  }

  try {
    const styled = renderMarkdownLines(body, {
      width,
      defaultFg: options.defaultFg,
      stripOuterIndent: true,
    });
    if (styled.length === 0) {
      return { mode: "plain", lines: plainLines(body) };
    }
    const lines: PagerDisplayLine[] = styled.map((st) => {
      // Join styled chunks for search/highlight. Sanitize so no CSI leaks into
      // the plain path (would blank the terminal when painting as raw text).
      const joined = st.chunks.map((c) => c.text).join("");
      const plain = sanitizeDisplayText(joined) || " ";
      return { plain, styled: st };
    });
    return { mode: "markdown", lines };
  } catch {
    // Never let a markdown bug blank the pager.
    return { mode: "plain", lines: plainLines(body) };
  }
}
