/**
 * Parse and present tool.batch output as nested sub-tool sections
 * (classic TUI parity).
 *
 * Batch runners emit labeled sections:
 *   ── #1 dns.lookup [ok exit=0]
 *   …
 *   ── #2 web.fetch [fail exit=1]
 *   …
 */

import { cleanToolOutputLines, presentOutput } from "./tool-presenter.js";

export interface BatchSection {
  readonly index: number;
  readonly name: string;
  readonly ok: boolean;
  readonly exitCode: number | undefined;
  readonly body: string;
}

const HEADER_RE = /^──\s+#(\d+)\s+([\w.]+)\s+\[(ok|fail)(?:\s+exit=(\d+))?\]/;

/**
 * Split a completed tool.batch output into per-sub-tool sections.
 * Returns [] when the body is not in the labeled batch format.
 */
export function parseBatchSections(output: string): BatchSection[] {
  const sections: BatchSection[] = [];
  let current: {
    index: number;
    name: string;
    ok: boolean;
    exitCode: number | undefined;
  } | null = null;
  const bodyLines: string[] = [];

  for (const line of output.replace(/\r/g, "").split("\n")) {
    const m = HEADER_RE.exec(line);
    if (m) {
      if (current !== null) {
        sections.push({
          ...current,
          body: bodyLines.join("\n").trim(),
        });
        bodyLines.length = 0;
      }
      const exitCode = m[4] !== undefined ? parseInt(m[4], 10) : undefined;
      current = {
        index: parseInt(m[1]!, 10),
        name: m[2]!,
        ok: m[3] === "ok",
        exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
      };
    } else if (current !== null) {
      bodyLines.push(line);
    }
  }
  if (current !== null) {
    sections.push({
      ...current,
      body: bodyLines.join("\n").trim(),
    });
  }
  return sections;
}

export interface BatchSectionPresentation {
  readonly glyph: string;
  readonly statusLabel: string;
  readonly name: string;
  readonly lines: readonly string[];
  readonly hiddenAboveCount: number;
  readonly hasBody: boolean;
}

/** Present one nested sub-tool for the card (collapsed head/tail or full). */
export function presentBatchSection(
  section: BatchSection,
  expanded: boolean,
): BatchSectionPresentation {
  const presented = presentOutput(section.body, undefined, expanded);
  // Prefer cleaned body even when presentOutput samples ends for huge text.
  const hasBody = section.body.trim().length > 0;
  return {
    glyph: section.ok ? "✓" : "✗",
    statusLabel: section.ok
      ? section.exitCode !== undefined
        ? `done (exit ${section.exitCode})`
        : "done"
      : section.exitCode !== undefined
        ? `failed (exit ${section.exitCode})`
        : "failed",
    name: section.name,
    lines: hasBody ? presented.lines : [],
    hiddenAboveCount: presented.hiddenAboveCount,
    hasBody,
  };
}

/** Human summary line under the parent batch header. */
export function batchSummaryLine(sections: readonly BatchSection[]): string {
  if (sections.length === 0) return "";
  const failed = sections.filter((s) => !s.ok).length;
  if (failed === 0) {
    return `${sections.length} sub-tool(s) — all ok`;
  }
  return `${failed}/${sections.length} sub-tool(s) failed`;
}

/** True when this tool item should use nested batch UI. */
export function isBatchToolName(name: string): boolean {
  return name === "tool.batch";
}

export interface BatchLiveLine {
  readonly text: string;
  readonly tone: "info" | "ok" | "fail" | "running";
}

/**
 * Present live `[batch] …` progress ticks as compact status lines while the
 * parent card is still running (no nested section headers yet).
 */
export function parseBatchLiveProgress(raw: string): {
  readonly lines: readonly BatchLiveLine[];
  readonly summary: string;
} {
  const ticks = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\[batch\]/i.test(l));
  if (ticks.length === 0) {
    return { lines: [], summary: "" };
  }

  // Prefer the latest status per call index so the card stays short.
  const byKey = new Map<string, BatchLiveLine>();
  let header: BatchLiveLine | undefined;
  let progress: BatchLiveLine | undefined;
  for (const tick of ticks) {
    const body = tick.replace(/^\[batch\]\s*/i, "");
    const start = /^#(\d+)\s+([\w.]+)\s+starting/i.exec(body);
    const done = /^#(\d+)\s+([\w.]+)\s+(ok|fail)/i.exec(body);
    const running = /^#(\d+)\s+([\w.]+)\s+still running/i.exec(body);
    const still = /^still running/i.test(body);
    if (start) {
      byKey.set(start[1]!, {
        text: `#${start[1]} ${start[2]} · running`,
        tone: "running",
      });
    } else if (done) {
      const ok = done[3]!.toLowerCase() === "ok";
      byKey.set(done[1]!, {
        text: `#${done[1]} ${done[2]} · ${ok ? "ok" : "fail"}`,
        tone: ok ? "ok" : "fail",
      });
    } else if (running) {
      // Keep "running" only if not already terminal.
      const prev = byKey.get(running[1]!);
      if (!prev || prev.tone === "running") {
        byKey.set(running[1]!, {
          text: `#${running[1]} ${running[2]} · running…`,
          tone: "running",
        });
      }
    } else if (still) {
      progress = { text: body, tone: "info" };
    } else if (/^starting\b/i.test(body)) {
      header = { text: body, tone: "info" };
    }
  }

  const lines: BatchLiveLine[] = [];
  if (header) lines.push(header);
  const ordered = [...byKey.entries()].sort(
    (a, b) => Number(a[0]) - Number(b[0]),
  );
  for (const [, line] of ordered) lines.push(line);
  if (progress) lines.push(progress);

  const runningN = ordered.filter(([, l]) => l.tone === "running").length;
  const doneN = ordered.filter(([, l]) => l.tone !== "running").length;
  const summary =
    ordered.length > 0
      ? `${doneN} settled · ${runningN} running · ${ordered.length} total`
      : header?.text ?? "batch running…";

  return { lines, summary };
}

/**
 * Rebuild a single section as a labeled block for the pager (matches
 * runner formatting so the full-batch view stays familiar).
 */
export function formatBatchSectionForPager(section: BatchSection): string {
  const status = section.ok ? "ok" : "fail";
  const exit =
    section.exitCode !== undefined ? ` exit=${section.exitCode}` : "";
  const head = `── #${section.index} ${section.name} [${status}${exit}]`;
  const body = section.body.trim();
  return body ? `${head}\n${body}` : head;
}

/** Full batch body for the parent pager — prefer original spool order. */
export function formatBatchForPager(
  sections: readonly BatchSection[],
  raw: string,
): string {
  if (sections.length === 0) return raw;
  // Prefer the raw spool so nothing is lost; fall back to reassembly.
  if (raw.trim().length > 0) return raw;
  return sections.map(formatBatchSectionForPager).join("\n\n");
}

/** Preview helper used by tests — clean lines without expand sampling. */
export function cleanBatchBodyLines(body: string): string[] {
  return cleanToolOutputLines(body);
}
