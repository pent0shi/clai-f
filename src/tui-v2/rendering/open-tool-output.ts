/**
 * Open full tool output in the pager modal (scroll + search + Esc/q).
 * Prefers the on-disk artifact, then the unbounded spool. Never re-truncates.
 *
 * Bodies that are pure JSON get pretty-printed so web.search dumps aren't
 * one messy minified blob.
 */

import { readFile, stat } from "node:fs/promises";
import { createArtifactPagerSource, type ArtifactPagerSource } from "./artifact-pager-source.js";
import { asToolCallId } from "../../app/events/app-event.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import type { ToolItem } from "../state/transcript-types.js";
import type { FileChange } from "../../tools/file-diff.js";
import { formatModalPlainText } from "./file-diff-view.js";

interface SearchHit {
  readonly title?: string | undefined;
  readonly url?: string | undefined;
  readonly snippet?: string | undefined;
}

/**
 * Prefer a human-readable hit list for web.search-style payloads.
 * Falls back to pretty JSON, then the raw text.
 */
export function formatToolPagerBody(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return raw;

  // Optional one-line summary above a JSON block:
  //   duckduckgo: 5 results
  //   { "results": [ ... ] }
  let prefix = "";
  let jsonText = trimmed;
  const firstBrace = trimmed.search(/[{\[]/);
  if (firstBrace > 0) {
    prefix = trimmed.slice(0, firstBrace).trimEnd();
    jsonText = trimmed.slice(firstBrace).trim();
  }

  if (jsonText[0] !== "{" && jsonText[0] !== "[") return raw;

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    const hits = extractSearchHits(parsed);
    if (hits && hits.length > 0) {
      const head = prefix || `${hits.length} result${hits.length === 1 ? "" : "s"}`;
      const blocks = hits.map((hit, i) => {
        const title = (hit.title || "(no title)").trim();
        const url = (hit.url || "").trim();
        const snippet = (hit.snippet || "").trim().replace(/\s+/g, " ");
        const lines = [`${i + 1}. ${title}`];
        if (url) lines.push(`   ${url}`);
        if (snippet) lines.push(`   ${snippet}`);
        return lines.join("\n");
      });
      return `${head}\n\n${blocks.join("\n\n")}`;
    }
    // Generic JSON — pretty-print only.
    const pretty = JSON.stringify(parsed, null, 2);
    return prefix ? `${prefix}\n\n${pretty}` : pretty;
  } catch {
    return raw;
  }
}

function extractSearchHits(parsed: unknown): SearchHit[] | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as { results?: unknown };
  if (!Array.isArray(obj.results)) return undefined;
  const hits: SearchHit[] = [];
  for (const entry of obj.results) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.title !== "string" && typeof e.url !== "string") continue;
    hits.push({
      title: typeof e.title === "string" ? e.title : undefined,
      url: typeof e.url === "string" ? e.url : undefined,
      snippet: typeof e.snippet === "string" ? e.snippet : undefined,
    });
  }
  return hits.length > 0 ? hits : undefined;
}

/** Short, stable title: `web.search · output` (args live in the body header). */
export function toolPagerTitle(
  name: string,
  argsDisplay: string | undefined,
): string {
  if (!argsDisplay) return `${name} · output`;
  // Keep the query readable but don't let it double as a second title line.
  const short =
    argsDisplay.length > 48 ? `${argsDisplay.slice(0, 45)}…` : argsDisplay;
  return `${name} · ${short}`;
}

export interface OpenToolOutputOptions {
  /**
   * When set, use this body instead of spool/artifact (e.g. one tool.batch
   * sub-section). Title still comes from `item`.
   */
  readonly bodyOverride?: string;
  /** Override the pager title (defaults to toolPagerTitle). */
  readonly titleOverride?: string;
  /** Skip artifact lookup even if item.artifactPath is set. */
  readonly skipArtifact?: boolean;
  /**
   * Open a single file-change snapshot (full file + green/red markers).
   * Prefer this over the raw tool receipt when the tool card has fileChanges.
   */
  readonly fileChange?: FileChange;
}

async function resolveFileChangeBody(change: FileChange): Promise<string> {
  let full: FileChange = change;
  if (!change.afterText && change.snapshotPath) {
    try {
      const raw = await readFile(change.snapshotPath, "utf8");
      const parsed = JSON.parse(raw) as FileChange;
      if (parsed && typeof parsed === "object") {
        full = { ...change, ...parsed, afterText: parsed.afterText ?? change.afterText };
      }
    } catch {
      /* use inline change as-is */
    }
  }
  return formatModalPlainText(full);
}

export async function openToolOutputPager(
  services: AppServices,
  item: Pick<ToolItem, "toolCallId" | "name" | "argsDisplay" | "artifactPath"> & {
    readonly fileChanges?: ToolItem["fileChanges"];
  },
  options: OpenToolOutputOptions = {},
): Promise<void> {
  try {
    // Prefer structured file-diff modal when available.
    const fileChange =
      options.fileChange ??
      (item.fileChanges && item.fileChanges.length === 1
        ? item.fileChanges[0]
        : undefined);

    if (fileChange && options.bodyOverride === undefined) {
      const body = await resolveFileChangeBody(fileChange);
      const title =
        options.titleOverride ??
        `${fileChange.kind === "create" ? "Created" : fileChange.kind === "delete" ? "Deleted" : fileChange.kind === "append" ? "Appended" : fileChange.kind === "overwrite" ? "Wrote" : "Edited"} · ${fileChange.basename}`;
      const opened = services.overlay.openPager(
        title,
        body || "(empty file)",
        undefined,
        fileChange.path,
      );
      if (!opened) {
        services.session.notice(
          "warn",
          "could not open output pager (another overlay is open)",
        );
      }
      return;
    }

    // Multi-file: concatenate all snapshots when opening the parent card.
    if (
      item.fileChanges &&
      item.fileChanges.length > 1 &&
      options.bodyOverride === undefined &&
      !options.fileChange
    ) {
      const parts: string[] = [];
      for (const ch of item.fileChanges) {
        parts.push(await resolveFileChangeBody(ch));
        parts.push("\n────────\n");
      }
      const title =
        options.titleOverride ??
        toolPagerTitle(item.name, item.argsDisplay);
      const opened = services.overlay.openPager(
        title,
        parts.join("\n").trim() || "(no output)",
        undefined,
        item.fileChanges[0]?.path,
      );
      if (!opened) {
        services.session.notice(
          "warn",
          "could not open output pager (another overlay is open)",
        );
      }
      return;
    }

    let body: string;
    let artifactSource: ArtifactPagerSource | undefined;

    if (options.bodyOverride !== undefined) {
      body = options.bodyOverride;
    } else {
      body = services.session.spool.tail(asToolCallId(item.toolCallId));

      if (item.artifactPath && !options.skipArtifact) {
        try {
          const info = await stat(item.artifactPath);
          if (info.isFile() && info.size >= Buffer.byteLength(body, "utf8")) {
            artifactSource = createArtifactPagerSource(item.artifactPath);
            const firstPage = await artifactSource.readPage(0);
            body = firstPage.body;
          }
        } catch {
          artifactSource?.dispose();
          artifactSource = undefined;
        }
      }
    }

    body = body
      .replace(/^(ok|failed)\n/gm, "")
      .replace(/^full output saved to .+\n?/gim, "")
      .replace(/^artifact: .+\n?/gim, "")
      .trimEnd();

    if (!artifactSource) body = formatToolPagerBody(body);

    // Optional one-line query header so the border title can stay short.
    let header = "";
    if (
      options.bodyOverride === undefined &&
      item.argsDisplay &&
      item.argsDisplay.length > 0
    ) {
      const label = item.name === "shell.exec" ? "command" : "query";
      header = `${label}: ${item.argsDisplay}\n\n`;
    }

    let note = "";
    if (item.artifactPath && options.bodyOverride === undefined) {
      note =
        `\n\n── full output saved at ──\n${item.artifactPath}` +
        (artifactSource ? "\n(paged from disk)" : "\n(spool body; artifact unreadable)");
    }

    const title =
      options.titleOverride ?? toolPagerTitle(item.name, item.argsDisplay);
    const opened = services.overlay.openPager(
      title,
      `${header}${body || "(no output)"}${note}`,
      artifactSource,
    );
    if (!opened) {
      services.session.notice("warn", "could not open output pager (another overlay is open)");
    }
  } catch (err) {
    services.session.notice(
      "warn",
      `failed to open tool output: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
