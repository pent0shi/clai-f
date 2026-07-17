/** @jsxImportSource @opentui/react */
/**
 * Scrollable pager for long content — full tool output, plan detail (PICK-003,
 * V2-074).
 *
 * Clean chrome: one border title, one meta/help row, body, one footer.
 * Ctrl+R search: substring matches paint reverse-video; Enter jumps to the
 * next hit and keeps the query so n/N / highlight stay active after the
 * filter bar closes.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { Theme } from "../../rendering/theme.js";
import { chordFromKeyEvent } from "../../actions/chord-from-key.js";
import type { ArtifactPage, ArtifactPagerSource } from "../../rendering/artifact-pager-source.js";
import {
  findPagerMatches,
  nextPagerMatch,
  prevPagerMatch,
  segmentPagerLine,
  type PagerMatch,
} from "../../state/pager-search.js";
import {
  fitOneLine,
  padChromeRow,
  wrapPagerLine,
} from "../../rendering/pager-chrome.js";
import { syntaxColor } from "../../rendering/file-diff-view.js";
import {
  emptyCarry,
  highlightLineForPath,
} from "../../rendering/syntax-highlight.js";

export interface PagerProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly title: string;
  readonly body: string;
  readonly source?: ArtifactPagerSource | undefined;
  /** When set, syntax-highlight diff bodies using this path's language. */
  readonly highlightPath?: string | undefined;
}

const HIDDEN_SCROLLBARS = {
  visible: false,
  showArrows: false,
} as const;

/** Progressive help lines — always one row; never wrap into the line-count. */
const PAGER_HELP_FULL =
  "↑↓:scroll  ·  pg↑↓:page  ·  g/G:jump  ·  ^r:search  ·  n/N:next  ·  c:copy  ·  s:scrollback  ·  e:editor  ·  q/esc:close";
const PAGER_HELP_MED =
  "↑↓:scroll  ·  ^r:search  ·  n/N:next  ·  c:copy  ·  e:editor  ·  q/esc:close";
const PAGER_HELP_SHORT = "↑↓:scroll  ·  ^r:search  ·  c:copy  ·  q/esc:close";
const PAGER_HELP_MIN = "↑↓  ·  ^r  ·  q/esc:close";

const PAGER_FOOTER_FULL =
  "c:copy  ·  drag:select  ·  s/^s:scrollback  ·  e/^e:editor";
const PAGER_FOOTER_SHORT = "c:copy  ·  s:scrollback  ·  e:editor";

/**
 * Diff modal lines: `  12 │ + body` (see formatModalPlainText).
 * Split so gutters are never selected/copied with the code.
 */
const DIFF_SPLIT_RE = /^(?<gutter>[\d ]{0,8}) │ (?<rest>.*)$/;

/** Base fg for a non-match body line (path/header cues, plan sections). */
function baseLineFg(line: string, theme: Theme): string {
  const t = line.trim();
  if (/^──\s*full output saved at/i.test(t)) return theme.response;
  if (/^\/Users\/|^\/home\/|^~\/|^\.clai\/|outputs\//i.test(t)) {
    return theme.response;
  }
  if (t.startsWith("─")) return theme.chip;
  // Plan pager section titles
  if (/^(Approach|Tasks|Goal|Status)\b/i.test(t) && !t.includes("  ·")) {
    return theme.cyan;
  }
  if (/^Status\s+/i.test(t) || /^Updated\s+/i.test(t)) return theme.muted;
  if (/^[✓✗○◉–]\s/.test(t) || /^\s+[✓✗○◉–]\s/.test(line)) {
    if (t.startsWith("✓") || line.includes("  ✓")) return theme.success;
    if (t.startsWith("✗") || line.includes("  ✗")) return theme.accent;
    if (t.startsWith("◉") || line.includes("  ◉")) return theme.activity;
    return theme.muted;
  }
  if (/^(Next:|Plan is approved|All tasks completed)/i.test(t)) return theme.muted;
  if (/q\/esc:close|Esc or q to close/i.test(t)) return theme.muted;
  return theme.foreground;
}

function parseDiffLine(line: string): {
  gutter: string;
  prefix: string;
  code: string;
  tone: "add" | "del" | "context" | "header";
} | null {
  const m = DIFF_SPLIT_RE.exec(line);
  if (!m?.groups) return null;
  const gutter = m.groups.gutter ?? "";
  const rest = m.groups.rest ?? "";
  // header rows: no +/- marker at start of rest as single-char prefix + space
  if (/^[+\-−] /.test(rest)) {
    const prefix = rest[0]!;
    const code = rest.slice(2);
    const tone =
      prefix === "+" ? "add" : prefix === "-" || prefix === "−" ? "del" : "context";
    return { gutter, prefix, code, tone };
  }
  // context with leading space marker "  code" from format (space + space + text)
  if (rest.startsWith("  ") || rest.startsWith(" ")) {
    // format is ` ${p} ${text}` so context is "  text" (space space) or "  " empty
    if (rest[0] === " " && rest[1] === " ") {
      return { gutter, prefix: " ", code: rest.slice(2), tone: "context" };
    }
  }
  // header-like (kind · path, stats)
  return { gutter, prefix: " ", code: rest, tone: "header" };
}

function PagerLine(props: {
  line: string;
  index: number;
  theme: Theme;
  matches: readonly PagerMatch[];
  activeMatchIndex: number;
  hasQuery: boolean;
  /** Path used for language detection (any extension / family). */
  highlightPath: string;
  /** Shared carry — mutated across lines for block comments. */
  carry: ReturnType<typeof emptyCarry>;
}): ReactNode {
  const {
    line,
    index,
    theme,
    matches,
    activeMatchIndex,
    hasQuery,
    highlightPath,
    carry,
  } = props;
  const isActiveLine =
    hasQuery &&
    activeMatchIndex >= 0 &&
    matches[activeMatchIndex]?.line === index;

  const parsed = parseDiffLine(line);

  if (parsed) {
    const bg =
      parsed.tone === "add"
        ? theme.diffAddBg
        : parsed.tone === "del"
          ? theme.diffDelBg
          : isActiveLine
            ? theme.rowA
            : undefined;
    // Add/del indicated only by background color — no +/- markers.
    const spans =
      parsed.tone === "header"
        ? [{ kind: "plain" as const, text: parsed.code }]
        : highlightLineForPath(parsed.code, highlightPath, carry);
    const bodyForSearch = parsed.code;
    const segs =
      hasQuery && matches.length > 0
        ? segmentPagerLine(bodyForSearch, index, matches, activeMatchIndex)
        : null;

    // Gutter untinted; code column full-width tint. height:1 on every node so
    // the solid "│" column doesn't look dashed from extra row gaps.
    const codeBg =
      parsed.tone === "add" || parsed.tone === "del"
        ? bg
        : isActiveLine
          ? theme.rowA
          : undefined;

    return (
      <box
        id={`pager-line-${index}`}
        style={{
          flexDirection: "row",
          width: "100%",
          height: 1,
          flexShrink: 0,
        }}
      >
        <text selectable={false} style={{ height: 1, flexShrink: 0 }}>
          <span style={{ fg: theme.diffGutter }}>{parsed.gutter}</span>
          <span style={{ fg: theme.diffGutter }}>{" │ "}</span>
        </text>
        <box
          style={{
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 0,
            height: 1,
            ...(codeBg ? { backgroundColor: codeBg } : {}),
          }}
        >
          <text selectable style={{ height: 1 }}>
            {segs
              ? segs.map((seg, i) => {
                  if (seg.kind === "plain") {
                    return (
                      <span key={i} style={{ fg: theme.foreground }}>
                        {seg.text}
                      </span>
                    );
                  }
                  if (seg.kind === "active") {
                    return (
                      <span
                        key={i}
                        style={{
                          fg: theme.background,
                          bg: theme.activity,
                          attributes: TextAttributes.BOLD,
                        }}
                      >
                        {seg.text}
                      </span>
                    );
                  }
                  return (
                    <span
                      key={i}
                      style={{
                        fg: theme.white,
                        bg: theme.selection,
                        attributes: TextAttributes.BOLD,
                      }}
                    >
                      {seg.text}
                    </span>
                  );
                })
              : spans.map((sp, i) => (
                  <span
                    key={i}
                    style={{
                      fg:
                        parsed.tone === "header"
                          ? theme.muted
                          : syntaxColor(sp.kind, theme),
                    }}
                  >
                    {sp.text || (i === 0 ? " " : "")}
                  </span>
                ))}
          </text>
        </box>
      </box>
    );
  }

  const baseFg = baseLineFg(line, theme);
  if (!hasQuery || matches.length === 0) {
    return (
      <text
        id={`pager-line-${index}`}
        selectable
        style={{
          fg: baseFg,
          ...(isActiveLine ? { bg: theme.rowA } : {}),
        }}
      >
        {line || " "}
      </text>
    );
  }

  const segments = segmentPagerLine(line, index, matches, activeMatchIndex);
  return (
    <text
      id={`pager-line-${index}`}
      selectable
      style={{
        fg: baseFg,
        ...(isActiveLine ? { bg: theme.rowA } : {}),
      }}
    >
      {segments.map((seg, i) => {
        if (seg.kind === "plain") {
          return (
            <span key={i} style={{ fg: baseFg }}>
              {seg.text}
            </span>
          );
        }
        if (seg.kind === "active") {
          return (
            <span
              key={i}
              style={{
                fg: theme.background,
                bg: theme.activity,
                attributes: TextAttributes.BOLD,
              }}
            >
              {seg.text}
            </span>
          );
        }
        return (
          <span
            key={i}
            style={{
              fg: theme.white,
              bg: theme.selection,
              attributes: TextAttributes.BOLD,
            }}
          >
            {seg.text}
          </span>
        );
      })}
    </text>
  );
}

/** Strip gutters from a full pager body for clipboard copy. */
export function bodyOnlyForCopy(full: string): string {
  return full
    .split("\n")
    .map((line) => {
      const p = parseDiffLine(line);
      if (p) return p.code;
      return line;
    })
    .join("\n");
}

export function Pager(props: PagerProps): ReactNode {
  const { services, theme, title, body, source, highlightPath } = props;
  const { width: termWidth } = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const [displayBody, setDisplayBody] = useState(body);
  const [artifactPage, setArtifactPage] = useState<ArtifactPage | undefined>(undefined);
  const [pageBusy, setPageBusy] = useState(false);
  const lines = useMemo(() => displayBody.replace(/\n+$/, "").split("\n"), [displayBody]);
  const pathForHighlight = highlightPath ?? title;
  // Search against code-only (no gutters) when body is a diff dump.
  const searchLines = useMemo(
    () =>
      lines.map((line) => {
        const p = parseDiffLine(line);
        return p ? p.code : line;
      }),
    [lines],
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(-1);
  const [scrollHint, setScrollHint] = useState("top");
  const matches = useMemo(
    () => findPagerMatches(searchLines, query),
    [searchLines, query],
  );
  const [exportError, setExportError] = useState<string | undefined>(undefined);
  const [statusFlash, setStatusFlash] = useState<string | undefined>(undefined);
  const hasQuery = query.trim().length > 0;
  // Stable carry for syntax across the visible line list (recreated when body changes).
  const syntaxCarry = useMemo(() => emptyCarry(), [displayBody, pathForHighlight]);

  useEffect(() => {
    if (!source) {
      setDisplayBody(body);
      setArtifactPage(undefined);
      return;
    }
    let active = true;
    setPageBusy(true);
    void source.readPage(0).then((page) => {
      if (!active) return;
      setArtifactPage(page);
      setDisplayBody(page.body || "(no output)");
    }).catch((error) => {
      if (active) setExportError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (active) setPageBusy(false); });
    return () => { active = false; };
  }, [body, source]);

  async function loadArtifactPage(
    offset: number,
    scroll: "top" | "bottom" = "top",
  ): Promise<void> {
    if (!source || pageBusy) return;
    setPageBusy(true);
    try {
      const page = await source.readPage(offset);
      setArtifactPage(page);
      setDisplayBody(page.body || "(no output)");
      setMatchIndex(-1);
      queueMicrotask(() => {
        const box = scrollRef.current;
        if (!box) return;
        if (scroll === "bottom") {
          const max = Math.max(0, box.scrollHeight - (box.viewport?.height ?? 0));
          box.scrollTo(max);
        } else {
          box.scrollTo(0);
        }
      });
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    } finally {
      setPageBusy(false);
    }
  }

  async function fullBody(): Promise<string> {
    return source ? source.readAll() : body;
  }

  // Conservative width: 96% box sits inside app chrome; overestimate caused
  // "11 lines" to paint past the rounded border after search.
  const pagerOuterCols = Math.max(40, Math.floor(termWidth * 0.96));
  const contentCols = Math.max(24, pagerOuterCols - 10);
  // Meta/footer rows (with their padding) — exact column budget for padChromeRow.
  const chromeCols = Math.max(20, contentCols - 4);

  function flash(message: string, ms = 1800): void {
    setStatusFlash(message);
    setExportError(undefined);
    setTimeout(() => setStatusFlash((cur) => (cur === message ? undefined : cur)), ms);
  }

  // Force-hide both bars — the grey horizontal track was the ugly bottom band.
  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb) return;
    sb.verticalScrollBar.visible = false;
    sb.horizontalScrollBar.visible = false;
  }, [lines.length]);

  // Drop an out-of-range active index when the query shrinks the hit list.
  useEffect(() => {
    if (!hasQuery || matches.length === 0) {
      setMatchIndex(-1);
      return;
    }
    setMatchIndex((cur) => (cur >= matches.length ? -1 : cur));
  }, [hasQuery, matches]);

  function refreshScrollHint(): void {
    const sb = scrollRef.current;
    if (!sb) return;
    const max = Math.max(0, sb.scrollHeight - sb.viewport.height);
    if (max <= 0) {
      setScrollHint("all");
      return;
    }
    const ratio = sb.scrollTop / max;
    if (ratio <= 0.02) setScrollHint("top");
    else if (ratio >= 0.98) setScrollHint("bottom");
    else setScrollHint(`${Math.round(ratio * 100)}%`);
  }

  function scrollByRows(delta: number): void {
    const sb = scrollRef.current;
    if (!sb) return;
    const max = Math.max(0, sb.scrollHeight - sb.viewport.height);
    sb.scrollTo(Math.max(0, Math.min(max, sb.scrollTop + delta)));
    refreshScrollHint();
  }

  function jumpToMatch(index: number, matchList: readonly PagerMatch[] = matches): void {
    if (index < 0 || matchList.length === 0) {
      setMatchIndex(-1);
      return;
    }
    setMatchIndex(index);
    const match = matchList[index];
    if (match) {
      // Defer until after paint so the active line exists in the scroll tree.
      queueMicrotask(() => {
        scrollRef.current?.scrollChildIntoView(`pager-line-${match.line}`);
        refreshScrollHint();
      });
    }
  }

  /** Enter / submit: next hit from the *current* query (avoids stale closure). */
  async function submitSearch(): Promise<void> {
    if (source && query.trim()) {
      setPageBusy(true);
      try {
        const page = await source.search(query.trim(), artifactPage?.offset ?? 0);
        if (page) {
          setArtifactPage(page);
          setDisplayBody(page.body);
          setMatchIndex(-1);
          setSearchOpen(false);
          queueMicrotask(() => scrollRef.current?.scrollTo(0));
        } else {
          setStatusFlash("no further matches");
        }
      } finally {
        setPageBusy(false);
      }
      return;
    }
    const found = findPagerMatches(lines, query);
    if (found.length === 0) return;
    const next = nextPagerMatch(found, matchIndex);
    jumpToMatch(next, found);
    setSearchOpen(false);
  }

  async function moveArtifactSearch(reverse: boolean): Promise<void> {
    if (!source || !query.trim() || pageBusy) return;
    setPageBusy(true);
    try {
      const from = reverse ? artifactPage?.offset ?? 0 : artifactPage?.nextOffset ?? 0;
      const page = await source.search(query.trim(), from, reverse);
      if (!page) {
        setStatusFlash(reverse ? "no previous matches" : "no further matches");
        return;
      }
      setArtifactPage(page);
      setDisplayBody(page.body);
      setMatchIndex(-1);
      queueMicrotask(() => scrollRef.current?.scrollTo(0));
    } finally {
      setPageBusy(false);
    }
  }

  function clearSearch(): void {
    setSearchOpen(false);
    setQuery("");
    setMatchIndex(-1);
  }

  async function runExport(
    promise: Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string },
    okMessage: string,
  ): Promise<void> {
    try {
      const result = await promise;
      if (result.ok) {
        flash(okMessage, 2400);
        setExportError(undefined);
      } else {
        setExportError(result.error ?? "export failed");
        setStatusFlash(undefined);
      }
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
      setStatusFlash(undefined);
    }
  }

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    const chord = chordFromKeyEvent(key);

    if (searchOpen) {
      if (chord === "escape") {
        key.preventDefault();
        // Abort filter: drop query + highlights.
        clearSearch();
      }
      // Let the <input> consume other keys (including Enter → onSubmit).
      return;
    }

    const action = services.router.resolve(chord, "pager");
    if (!action) {
      // Esc with an active query clears highlight without closing the pager.
      if (chord === "escape" && hasQuery) {
        key.preventDefault();
        clearSearch();
      }
      return;
    }
    key.preventDefault();
    const sb = scrollRef.current;
    switch (action) {
      case "pager.line-up":
        scrollByRows(-1);
        break;
      case "pager.line-down":
        scrollByRows(1);
        break;
      case "pager.page-up":
        if (source && artifactPage && (sb?.scrollTop ?? 0) <= 0 && artifactPage.offset > 0) {
          void loadArtifactPage(Math.max(0, artifactPage.offset - source.pageBytes));
        } else {
          scrollByRows(-(sb?.viewport.height ?? 10));
        }
        break;
      case "pager.page-down": {
        const atBottom = !sb || sb.scrollTop >= Math.max(0, sb.scrollHeight - sb.viewport.height);
        if (source && artifactPage && atBottom && artifactPage.nextOffset < artifactPage.totalBytes) {
          void loadArtifactPage(artifactPage.nextOffset);
        } else {
          scrollByRows(sb?.viewport.height ?? 10);
        }
        break;
      }
      case "pager.half-page-up":
        scrollByRows(-Math.max(1, Math.floor((sb?.viewport.height ?? 10) / 2)));
        break;
      case "pager.half-page-down":
        scrollByRows(Math.max(1, Math.floor((sb?.viewport.height ?? 10) / 2)));
        break;
      case "pager.top":
        // g — absolute start (first artifact page + scroll top).
        if (source && artifactPage?.offset) {
          void loadArtifactPage(0, "top");
        } else {
          sb?.scrollTo(0);
        }
        refreshScrollHint();
        break;
      case "pager.bottom":
        // G — absolute end (last artifact page + scroll bottom).
        if (source && artifactPage && artifactPage.pageNumber < artifactPage.pageCount) {
          void loadArtifactPage(
            Math.max(0, artifactPage.totalBytes - source.pageBytes),
            "bottom",
          );
        } else {
          const max = sb
            ? Math.max(0, sb.scrollHeight - (sb.viewport?.height ?? 0))
            : 0;
          sb?.scrollTo(max);
        }
        refreshScrollHint();
        break;
      case "pager.search":
        setSearchOpen(true);
        break;
      case "pager.next-match":
        if (source && hasQuery) void moveArtifactSearch(false);
        else if (matches.length > 0) jumpToMatch(nextPagerMatch(matches, matchIndex));
        break;
      case "pager.prev-match":
        if (source && hasQuery) void moveArtifactSearch(true);
        else if (matches.length > 0) jumpToMatch(prevPagerMatch(matches, matchIndex));
        break;
      case "pager.export-scrollback":
        void fullBody().then((full) => runExport(
          services.pagerExport.exportToScrollback(title, full),
          "exported to terminal scrollback (scroll up after exit)",
        )).catch((error) => setExportError(error instanceof Error ? error.message : String(error)));
        break;
      case "pager.export-editor":
        void fullBody().then((full) => runExport(services.pagerExport.exportToEditor(full), "opened in editor"))
          .catch((error) => setExportError(error instanceof Error ? error.message : String(error)));
        break;
      case "pager.copy":
        void fullBody()
          .then((full) => services.ports.clipboard.writeText(bodyOnlyForCopy(full)))
          .then(
            () => flash("copied all"),
            () => flash("copy failed"),
          );
        break;
      case "pager.close":
        // First Esc clears an active search highlight; second closes the pager.
        if (hasQuery) {
          clearSearch();
        } else {
          services.overlay.close();
        }
        break;
      default:
        break;
    }
  });

  const scrollLabel =
    scrollHint === "all"
      ? "all"
      : scrollHint === "top"
        ? "top"
        : scrollHint === "bottom"
          ? "bottom"
          : scrollHint;

  const matchStatus =
    hasQuery && matches.length > 0
      ? `${Math.max(0, matchIndex) + 1}/${matches.length}`
      : hasQuery
        ? "no matches"
        : "";

  const lineCountRight = artifactPage
    ? `${lines.length} lines · page ${artifactPage.pageNumber}/${artifactPage.pageCount}${pageBusy ? " · loading" : ""}`
    : `${lines.length} lines · ${scrollLabel}`;

  // While a find is active, prefer find status over the long help line so the
  // right-side line count always has room.
  const metaLeft = hasQuery
    ? fitOneLine(
        [
          statusFlash
            ? `${statusFlash}  ·  find:${query.trim()} ${matchStatus}`
            : `find:${query.trim()} ${matchStatus}`,
          `find:${matchStatus}`,
          matchStatus || "find",
        ],
        Math.max(8, Math.floor(chromeCols * 0.65)),
      )
    : fitOneLine(
        [
          statusFlash
            ? `${PAGER_HELP_SHORT}  ·  ${statusFlash}`
            : PAGER_HELP_FULL,
          PAGER_HELP_MED,
          PAGER_HELP_SHORT,
          PAGER_HELP_MIN,
          "↑↓ · ^r · q",
        ],
        Math.max(8, Math.floor(chromeCols * 0.65)),
      );

  const metaLine = padChromeRow(metaLeft, lineCountRight, chromeCols);

  const footerLeft = exportError
    ? `export failed: ${exportError}`
    : statusFlash
      ? statusFlash
      : hasQuery
        ? "n/N:next  ·  esc:clear-find  ·  q:close"
        : PAGER_FOOTER_FULL;
  const footerLine = padChromeRow(footerLeft, scrollLabel, chromeCols);

  const filterHint = fitOneLine(
    [
      matches.length > 0
        ? `${matchStatus}  ·  enter:next  ·  esc:cancel`
        : query.trim()
          ? "no matches · esc:cancel"
          : "type:filter  ·  esc:cancel",
      matches.length > 0 ? `${matchStatus} · enter · esc` : "esc:cancel",
      matches.length > 0 ? matchStatus : "esc",
    ],
    Math.max(6, Math.floor(chromeCols * 0.35)),
  );

  // Clip long titles so the border doesn't wrap/overflow.
  const borderTitle =
    title.length > 72 ? ` ${title.slice(0, 69)}… ` : ` ${title} `;

  return (
    <box
      border
      borderStyle="rounded"
      title={borderTitle}
      titleAlignment="left"
      titleColor={theme.cyan}
      style={{
        flexDirection: "column",
        // Larger than before — fills most of the terminal.
        width: "96%",
        height: "92%",
        borderColor: theme.border,
        backgroundColor: theme.statusBackground,
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 0,
        paddingBottom: 0,
      }}
    >
      {/* Single fixed-width meta row — never flex-overflow past the border. */}
      <box
        style={{
          flexDirection: "row",
          width: "100%",
          height: 1,
          flexShrink: 0,
          backgroundColor: theme.rowB,
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        {searchOpen ? (
          <box
            style={{
              flexDirection: "row",
              flexGrow: 1,
              flexShrink: 1,
              width: "100%",
              height: 1,
              minWidth: 0,
            }}
          >
            <text selectable={false} style={{ fg: theme.cyan, height: 1 }}>
              filter:{" "}
            </text>
            <input
              focused
              value={query}
              onInput={(value) => {
                setQuery(value);
                // Reset so Enter always lands on the first hit for a new query.
                setMatchIndex(-1);
              }}
              onSubmit={submitSearch}
              textColor={theme.foreground}
              backgroundColor={theme.rowB}
              style={{ flexGrow: 1, minWidth: 0 }}
            />
            <text
              selectable={false}
              content={fitOneLine([` ${filterHint}`], Math.max(8, Math.floor(chromeCols * 0.35)))}
              style={{ fg: theme.muted, flexShrink: 0, height: 1 }}
            />
          </box>
        ) : (
          <text
            selectable={false}
            content={metaLine}
            style={{ fg: theme.muted, height: 1, width: "100%" }}
          />
        )}
      </box>

      <scrollbox
        ref={scrollRef}
        viewportCulling
        scrollY
        scrollX={false}
        stickyScroll={false}
        scrollbarOptions={HIDDEN_SCROLLBARS}
        verticalScrollbarOptions={HIDDEN_SCROLLBARS}
        horizontalScrollbarOptions={HIDDEN_SCROLLBARS}
        style={{
          flexGrow: 1,
          flexShrink: 1,
          width: "100%",
          minHeight: 8,
          backgroundColor: theme.background,
          marginTop: 0,
          marginBottom: 0,
          paddingLeft: 1,
          paddingRight: 1,
          // File-diff modals stay dense; generic tool output keeps a little air.
          paddingTop: highlightPath ? 0 : 1,
        }}
        onMouseScroll={() => refreshScrollHint()}
      >
        {!highlightPath ? (
          <text content=" " style={{ height: 1 }} />
        ) : null}
        {lines.flatMap((line, index) => {
          // Don't wrap gutters into mid-line chunks — wrap code only when diff.
          const parsed = parseDiffLine(line);
          if (parsed) {
            // Soft-wrap code only; keep internal mark so parseDiffLine still
            // knows add/del tone. PagerLine does not paint +/-.
            const codeChunks = wrapPagerLine(
              parsed.code,
              Math.max(12, contentCols - (parsed.gutter.length + 3)),
            );
            return codeChunks.map((codeChunk, part) => {
              const mark =
                parsed.tone === "add"
                  ? "+"
                  : parsed.tone === "del"
                    ? "−"
                    : " ";
              const g =
                part === 0
                  ? parsed.gutter
                  : " ".repeat(parsed.gutter.length);
              const rebuilt =
                parsed.tone === "header"
                  ? `${g} │ ${codeChunk}`
                  : `${g} │ ${mark} ${codeChunk}`;
              return (
                <PagerLine
                  key={`${index}-${part}`}
                  line={rebuilt}
                  index={index}
                  theme={theme}
                  matches={matches}
                  activeMatchIndex={matchIndex}
                  hasQuery={hasQuery}
                  highlightPath={pathForHighlight}
                  carry={syntaxCarry}
                />
              );
            });
          }
          return wrapPagerLine(line, contentCols).map((chunk, part) => (
            <PagerLine
              key={`${index}-${part}`}
              line={chunk}
              index={index}
              theme={theme}
              matches={matches}
              activeMatchIndex={matchIndex}
              hasQuery={hasQuery}
              highlightPath={pathForHighlight}
              carry={syntaxCarry}
            />
          ));
        })}
        {!highlightPath ? (
          <text content=" " style={{ height: 1 }} />
        ) : null}
      </scrollbox>

      {/* Fixed-width footer row (same padChromeRow budget as meta). */}
      <box
        style={{
          flexDirection: "row",
          width: "100%",
          height: 1,
          flexShrink: 0,
          backgroundColor: theme.rowB,
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        <text
          selectable={false}
          content={footerLine}
          style={{
            fg: exportError ? theme.mode : theme.muted,
            height: 1,
            width: "100%",
          }}
        />
      </box>
    </box>
  );
}
