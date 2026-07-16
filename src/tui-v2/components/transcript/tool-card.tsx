/** @jsxImportSource @opentui/react */
/**
 * Tool card: flat single-border pane (classic parity — no 3D depth / outer plate).
 *
 * Click (body or footer) opens the full-output pager modal — unless the card is
 * already expanded in place via Ctrl+O. Ctrl+O expands every card to show the
 * full cleaned body; click does not toggle expand (classic: keyboard expands,
 * click opens the unbounded viewer).
 *
 * tool.batch: parent card nests one mini-card per sub-tool. Click the parent
 * (header/footer) for the full batch; click a sub-card for that call only.
 * Ctrl+O expands sub-bodies in place the same as a normal tool.
 *
 * File diffs: compact single-height rows; chevron collapses hunks to a one-line
 * title (verb + relative path). Collapse-all applies to every file-diff card.
 */

import { useState, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { MouseEvent } from "@opentui/core";
import type { OutputSpool } from "../../../app/events/event-buffer.js";
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { ToolItem } from "../../state/transcript-types.js";
import type { Theme } from "../../rendering/theme.js";
import {
  batchSummaryLine,
  formatBatchSectionForPager,
  isBatchToolName,
  parseBatchLiveProgress,
  parseBatchSections,
  presentBatchSection,
  type BatchSection,
} from "../../rendering/batch-sections.js";
import { presentOutput, presentTool } from "../../rendering/tool-presenter.js";
import { openToolOutputPager } from "../../rendering/open-tool-output.js";
import {
  collapsedFileChangesLabel,
  presentFileChangePreview,
  relativeDisplayPath,
  rowBackground,
  syntaxColor,
} from "../../rendering/file-diff-view.js";
import type { FileChange } from "../../../tools/file-diff.js";
import { LinkableText } from "./linkable-text.js";
import { useClickWithoutDrag } from "./use-click-without-drag.js";

const STATUS_COLOR: Record<ToolItem["status"], keyof Theme> = {
  queued: "muted",
  running: "activity",
  ok: "response",
  failed: "mode",
  blocked: "mode",
};

function OutputLines(props: {
  lines: readonly string[];
  theme: Theme;
  gutterFg: string;
}): ReactNode {
  const { lines, theme, gutterFg } = props;
  // Tool/output body: CLAI wordmark magenta (same as task-pane border / logo "I").
  const bodyFg = theme.magenta;
  return (
    <>
      {lines.map((line, i) => {
        const isGap = line.startsWith("···");
        return (
          // Selectable so drag-select includes tool output in the copy range.
          <text key={i} selectable>
            <span style={{ fg: isGap ? theme.muted : gutterFg }}>{"│ "}</span>
            <span
              style={{
                fg: isGap ? theme.muted : bodyFg,
                attributes: isGap ? TextAttributes.DIM : TextAttributes.NONE,
              }}
            >
              {line}
            </span>
          </text>
        );
      })}
    </>
  );
}

/**
 * Hover chip for collapse / collapse-all. Stops propagation so parent
 * header click does NOT open the file modal.
 */
function DiffActionButton(props: {
  label: string;
  theme: Theme;
  onClick: () => void;
}): ReactNode {
  const { label, theme, onClick } = props;
  const [hovered, setHovered] = useState(false);
  const fg = hovered ? theme.white : theme.muted;
  const bg = hovered ? theme.selection : theme.statusBackground;
  return (
    <box
      onMouseDown={(event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      onMouseUp={(event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        flexShrink: 0,
        height: 1,
        backgroundColor: bg,
        marginLeft: 1,
      }}
    >
      <text
        selectable={false}
        content={hovered ? ` ${label} ` : ` ${label} `}
        style={{ fg, bg, attributes: hovered ? TextAttributes.BOLD : TextAttributes.NONE }}
      />
    </box>
  );
}

/** One compact row: solid gutter · full-width code tint · height 1. */
function DiffCodeRow(props: {
  gutter: string;
  spans: readonly { kind: import("../../rendering/syntax-highlight.js").SyntaxKind; text: string }[];
  displayText: string;
  tone: "context" | "add" | "del" | "gap" | "header";
  theme: Theme;
}): ReactNode {
  const { gutter, spans, displayText, tone, theme } = props;
  const bg = rowBackground(tone, theme);
  const isGap = tone === "gap" || tone === "header";
  const gutterFg = theme.diffGutter;
  // Single-height row: solid "│" (not a box border — avoids dashed gaps).
  return (
    <box
      style={{
        flexDirection: "row",
        width: "100%",
        height: 1,
        flexShrink: 0,
      }}
    >
      <text selectable={false} style={{ height: 1 }}>
        <span style={{ fg: gutterFg }}>{gutter}</span>
        <span style={{ fg: gutterFg }}>{" │ "}</span>
      </text>
      <box
        style={{
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 0,
          height: 1,
          ...(bg ? { backgroundColor: bg } : {}),
        }}
      >
        <text
          selectable={!isGap}
          style={{
            height: 1,
            attributes: isGap ? TextAttributes.DIM : TextAttributes.NONE,
          }}
        >
          {isGap ? (
            <span style={{ fg: theme.muted }}>{displayText}</span>
          ) : spans.length > 0 ? (
            spans.map((sp, si) => (
              <span key={si} style={{ fg: syntaxColor(sp.kind, theme) }}>
                {sp.text}
              </span>
            ))
          ) : (
            <span style={{ fg: theme.foreground }}>{displayText || " "}</span>
          )}
        </text>
      </box>
    </box>
  );
}

function FileDiffHunks(props: {
  change: FileChange;
  showPath: boolean;
  theme: Theme;
  onOpen: (change: FileChange) => void;
}): ReactNode {
  const { change, showPath, theme, onOpen } = props;
  const rows = presentFileChangePreview(change);
  const open = useClickWithoutDrag(() => onOpen(change));
  return (
    <box
      style={{ flexDirection: "column", width: "100%" }}
      onMouseDown={open.onMouseDown}
      onMouseUp={open.onMouseUp}
    >
      {showPath ? (
        <text
          selectable={false}
          style={{ height: 1, fg: theme.muted, attributes: TextAttributes.DIM }}
        >
          {relativeDisplayPath(change.path)}
        </text>
      ) : null}
      {rows.map((row, ri) => (
        <DiffCodeRow
          key={ri}
          gutter={row.gutter}
          spans={row.spans}
          displayText={row.displayText}
          tone={row.tone}
          theme={theme}
        />
      ))}
    </box>
  );
}

function FileDiffBody(props: {
  changes: readonly FileChange[];
  theme: Theme;
  diffExpanded: boolean;
  onOpen: (change: FileChange) => void;
}): ReactNode {
  const { changes, theme, diffExpanded, onOpen } = props;

  const label = collapsedFileChangesLabel(changes);
  const openPrimary = useClickWithoutDrag(() => {
    if (changes[0]) onOpen(changes[0]!);
  });

  // Title row only — collapse buttons live beside the status "done" pill.
  return (
    <box style={{ flexDirection: "column", width: "100%", marginTop: 0 }}>
      <box
        style={{ flexDirection: "row", width: "100%", height: 1, flexShrink: 0 }}
        onMouseDown={openPrimary.onMouseDown}
        onMouseUp={openPrimary.onMouseUp}
      >
        <text
          selectable
          style={{ height: 1, fg: theme.foreground, attributes: TextAttributes.BOLD }}
        >
          {label}
        </text>
      </box>

      {diffExpanded
        ? changes.map((change, ci) => (
            <FileDiffHunks
              key={`${change.path}-${ci}`}
              change={change}
              showPath={changes.length > 1}
              theme={theme}
              onOpen={onOpen}
            />
          ))
        : null}
    </box>
  );
}

function BatchSubCard(props: {
  section: BatchSection;
  theme: Theme;
  expanded: boolean;
  parentExpanded: boolean;
  onOpen: (section: BatchSection) => void;
}): ReactNode {
  const { section, theme, expanded, parentExpanded, onOpen } = props;
  const presented = presentBatchSection(section, expanded);
  const borderFg = section.ok ? theme.response : theme.mode;
  const statusFg = borderFg;

  // Click (no drag) opens pager; drag-select copies output lines.
  const click = useClickWithoutDrag(() => {
    if (parentExpanded) return;
    onOpen(section);
  });

  let footerHint: string | undefined;
  if (presented.hasBody) {
    if (expanded) {
      footerHint = "expanded · Ctrl+O to collapse";
    } else if (presented.hiddenAboveCount > 0) {
      footerHint = `+${presented.hiddenAboveCount} more · click for full · Ctrl+O to expand`;
    } else {
      footerHint = "click for full · Ctrl+O to expand";
    }
  }

  return (
    <box
      border
      borderStyle="rounded"
      style={{
        flexDirection: "column",
        width: "100%",
        marginTop: 1,
        marginBottom: 0,
        borderColor: borderFg,
        // Match parent face — no second elevated plate.
        backgroundColor: theme.statusBackground,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
      }}
      onMouseDown={click.onMouseDown}
      onMouseUp={click.onMouseUp}
    >
      <box style={{ flexDirection: "row", width: "100%" }}>
        <text selectable style={{ fg: statusFg, attributes: TextAttributes.BOLD }}>
          {presented.glyph} {presented.name}
        </text>
        <text content=" " selectable />
        <text selectable style={{ fg: statusFg, bg: theme.chip, attributes: TextAttributes.BOLD }}>
          {` ${presented.statusLabel} `}
        </text>
        <text content=" " selectable />
        <text selectable style={{ fg: theme.muted, attributes: TextAttributes.DIM }}>
          #{section.index}
        </text>
      </box>

      {presented.lines.length > 0 ? (
        <box
          style={{
            flexDirection: "column",
            width: "100%",
            marginTop: 0,
            flexShrink: 1,
          }}
        >
          <OutputLines lines={presented.lines} theme={theme} gutterFg={borderFg} />
        </box>
      ) : null}

      {footerHint ? (
        <box style={{ flexDirection: "row", width: "100%", marginTop: 0 }}>
          <text selectable={false} style={{ fg: theme.cyan }}>{"› "}</text>
          <text selectable={false} style={{ fg: theme.cyan, attributes: TextAttributes.DIM }}>{footerHint}</text>
        </box>
      ) : null}
    </box>
  );
}

export function ToolCard(props: {
  item: ToolItem;
  theme: Theme;
  spool: OutputSpool;
  expanded: boolean;
  services: AppServices;
  onToggle: () => void;
  /** File-diff hunks visible (vs one-line collapsed title). */
  fileDiffExpanded?: boolean;
  onToggleFileDiff?: () => void;
  onCollapseAllFileDiffs?: () => void;
  onExpandAllFileDiffs?: () => void;
}): ReactNode {
  const {
    item,
    theme,
    spool,
    expanded,
    services,
    fileDiffExpanded = true,
    onToggleFileDiff,
    onCollapseAllFileDiffs,
    onExpandAllFileDiffs,
  } = props;
  const { glyph, statusLabel, name, argsLabel, argsDisplay, detail, pathLine, isFileDiff } =
    presentTool(item);
  const tail = spool.tail(item.toolCallId);
  const spoolState = spool.state(item.toolCallId);
  const fileChanges = item.fileChanges;

  const isBatchName = isBatchToolName(item.name);
  const batchSections =
    isBatchName && item.status !== "running" && tail
      ? parseBatchSections(tail)
      : [];
  const isBatch = batchSections.length > 0;
  const liveBatch =
    isBatchName && item.status === "running" && tail
      ? parseBatchLiveProgress(tail)
      : { lines: [] as const, summary: "" };
  const isBatchLive = isBatchName && item.status === "running";

  const { lines, hiddenAboveCount, truncatedNotice } =
    isBatch || isBatchLive || isFileDiff
      ? {
          lines: [] as string[],
          hiddenAboveCount: 0,
          truncatedNotice: undefined as string | undefined,
        }
      : presentOutput(tail, spoolState, expanded, item.name);

  const statusFg = theme[STATUS_COLOR[item.status]];
  const highlight =
    item.status === "running"
      ? theme.activity
      : item.status === "queued"
        ? theme.muted
        : item.status === "ok"
          ? theme.toolBorder
          : theme.mode;

  const hasBody =
    isBatch ||
    isBatchLive ||
    isFileDiff ||
    lines.length > 0 ||
    item.outputBytes > 0 ||
    Boolean(item.artifactPath);

  /** Open unbounded pager for the whole tool (or full batch / file diff). */
  const openFull = (): void => {
    if (expanded) return;
    if (item.status === "running" && !hasBody) return;
    void openToolOutputPager(services, item);
  };
  // Click without drag opens pager; drag-select includes output text.
  const openFullClick = useClickWithoutDrag(openFull);

  const openFileChange = (change: FileChange): void => {
    if (expanded) return;
    void openToolOutputPager(services, item, { fileChange: change });
  };

  const openSection = (section: BatchSection): void => {
    void openToolOutputPager(
      services,
      {
        toolCallId: item.toolCallId,
        name: section.name,
        argsDisplay: `#${section.index}`,
        artifactPath: undefined,
        fileChanges: undefined,
      },
      {
        bodyOverride: formatBatchSectionForPager(section),
        titleOverride: `${section.name} · #${section.index}`,
        skipArtifact: true,
      },
    );
  };

  // Footer: shorter for file diffs (title already carries the path).
  let footerHint: string | undefined;
  if (isFileDiff && item.status !== "running") {
    footerHint = fileDiffExpanded
      ? "click hunk · open file"
      : "click title · open file";
  } else if (item.status !== "running" && hasBody) {
    if (expanded) {
      footerHint = isBatch
        ? "sub-calls expanded · click batch or sub-tool for pager · Ctrl+O collapses"
        : "expanded · Ctrl+O to collapse";
    } else if (isBatch) {
      footerHint =
        "click batch = all output · click sub-tool = that call · Ctrl+O expands all";
    } else if (hiddenAboveCount > 0) {
      footerHint = `+${hiddenAboveCount} more · click for full · Ctrl+O to expand`;
    } else {
      footerHint = "click for full · Ctrl+O to expand";
    }
  } else if (isBatchLive) {
    footerHint = "live sub-calls · finishes into nested cards";
  } else if (item.status === "running" && hasBody && !expanded) {
    footerHint = "click for full · Ctrl+O to expand";
  }

  const summary = isBatch
    ? batchSummaryLine(batchSections)
    : isBatchLive
      ? liveBatch.summary
      : undefined;
  const summaryFg =
    isBatch && batchSections.some((s) => !s.ok) ? theme.mode : theme.muted;

  return (
    <box
      id={item.id}
      border
      borderStyle="rounded"
      style={{
        flexDirection: "column",
        width: "100%",
        marginBottom: 1,
        borderColor: highlight,
        // Flat face only — no layered header/well plate outside the border.
        backgroundColor: theme.statusBackground,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
      }}
    >
      {/* Header: name + status pill. Collapse chips sit beside "done" (file diffs only). */}
      <box
        style={{
          flexDirection: "row",
          width: "100%",
          paddingTop: 0,
          paddingBottom: 0,
          alignItems: "center",
        }}
      >
        <box
          style={{ flexDirection: "row", flexShrink: 0 }}
          onMouseDown={openFullClick.onMouseDown}
          onMouseUp={openFullClick.onMouseUp}
        >
          <text selectable style={{ fg: statusFg, attributes: TextAttributes.BOLD }}>
            {/* File diffs put the verb+path in the body title — avoid a second tall name. */}
            {isFileDiff ? `${glyph}` : `${glyph} ${name}`}
          </text>
          <text content=" " selectable={false} />
          <text selectable={false} style={{ fg: statusFg, bg: theme.chip, attributes: TextAttributes.BOLD }}>
            {` ${statusLabel} `}
          </text>
        </box>
        {isFileDiff ? (
          <>
            <DiffActionButton
              label={fileDiffExpanded ? "collapse" : "expand"}
              theme={theme}
              onClick={() => onToggleFileDiff?.()}
            />
            <DiffActionButton
              label={fileDiffExpanded ? "collapse all" : "expand all"}
              theme={theme}
              onClick={() =>
                fileDiffExpanded
                  ? onCollapseAllFileDiffs?.()
                  : onExpandAllFileDiffs?.()
              }
            />
          </>
        ) : null}
        {isBatch || isBatchLive ? (
          <>
            <text content=" " selectable={false} />
            <text selectable={false} style={{ fg: theme.muted, attributes: TextAttributes.DIM }}>
              batch
            </text>
          </>
        ) : null}
      </box>

      {argsDisplay && argsLabel ? (
        <box style={{ flexDirection: "row", width: "100%", marginTop: 0 }}>
          <text selectable style={{ fg: theme.muted }}>{argsLabel}: </text>
          {/* Aqua input/command text — stands out from muted labels + white output. */}
          <text selectable style={{ fg: theme.cyan }}>{argsDisplay}</text>
        </box>
      ) : null}
      {pathLine && !isFileDiff ? (
        <box style={{ flexDirection: "row", width: "100%", marginTop: 0 }}>
          <LinkableText text={pathLine} theme={theme} fg={theme.muted} selectable />
        </box>
      ) : null}
      {detail ? <LinkableText text={detail} theme={theme} fg={theme.mode} selectable /> : null}

      {summary ? (
        <text selectable style={{ fg: summaryFg, attributes: TextAttributes.DIM }}>{summary}</text>
      ) : null}

      {/* Live batch progress (compact, no collapsed “N lines more” log). */}
      {isBatchLive && liveBatch.lines.length > 0 ? (
        <box style={{ flexDirection: "column", width: "100%", marginTop: 0 }}>
          {liveBatch.lines.map((line, i) => {
            const fg =
              line.tone === "ok"
                ? theme.response
                : line.tone === "fail"
                  ? theme.mode
                  : line.tone === "running"
                    ? theme.activity
                    : theme.muted;
            return (
              <text key={`live-${i}`} selectable style={{ fg }}>
                {`  ${line.tone === "ok" ? "✓" : line.tone === "fail" ? "✗" : line.tone === "running" ? "●" : "·"} ${line.text}`}
              </text>
            );
          })}
        </box>
      ) : null}

      {/* Nested sub-tools for tool.batch */}
      {isBatch
        ? batchSections.map((section) => (
            <BatchSubCard
              key={`${item.id}-sub-${section.index}`}
              section={section}
              theme={theme}
              expanded={expanded}
              parentExpanded={expanded}
              onOpen={openSection}
            />
          ))
        : null}

      {/* File mutation diffs — compact rows; chevron collapses to title. */}
      {!isBatch && !isBatchLive && isFileDiff && fileChanges ? (
        <box
          style={{
            flexDirection: "column",
            width: "100%",
            marginTop: 0,
            flexShrink: 1,
          }}
        >
          <FileDiffBody
            changes={fileChanges}
            theme={theme}
            diffExpanded={fileDiffExpanded}
            onOpen={openFileChange}
          />
        </box>
      ) : null}

      {/* Normal (non-batch) output body — click opens pager; drag selects. */}
      {!isBatch && !isBatchLive && !isFileDiff && lines.length > 0 ? (
        <box
          style={{
            flexDirection: "column",
            width: "100%",
            paddingLeft: 0,
            paddingRight: 0,
            paddingTop: 0,
            paddingBottom: 0,
            marginTop: 0,
            flexShrink: 1,
          }}
          onMouseDown={openFullClick.onMouseDown}
          onMouseUp={openFullClick.onMouseUp}
        >
          <text selectable style={{ fg: theme.white, bg: theme.chipTeal, attributes: TextAttributes.BOLD }}>
            {" OUTPUT "}
          </text>
          <OutputLines lines={lines} theme={theme} gutterFg={theme.muted} />
        </box>
      ) : null}

      {/* Skip SAVED line for file diffs — path is already in the title. */}
      {item.artifactPath && !isFileDiff ? (
        <box style={{ flexDirection: "row", width: "100%", marginTop: 0 }}>
          <text selectable style={{ fg: theme.white, bg: theme.chipTeal, attributes: TextAttributes.BOLD }}>
            {" SAVED "}
          </text>
          <text content=" " selectable />
          <LinkableText text={item.artifactPath} theme={theme} fg={theme.cyan} selectable />
        </box>
      ) : null}
      {truncatedNotice ? (
        <text selectable style={{ fg: theme.muted, attributes: TextAttributes.ITALIC }}>
          {truncatedNotice}
        </text>
      ) : null}
      {footerHint ? (
        <box
          style={{
            flexDirection: "row",
            width: "100%",
            marginTop: 0,
            marginBottom: 0,
            paddingBottom: 0,
          }}
          {...(expanded
            ? {}
            : {
                onMouseDown: openFullClick.onMouseDown,
                onMouseUp: openFullClick.onMouseUp,
              })}
        >
          <text selectable={false} style={{ fg: theme.cyan }}>{"› "}</text>
          <text selectable={false} style={{ fg: theme.cyan, attributes: TextAttributes.DIM }}>{footerHint}</text>
        </box>
      ) : null}
    </box>
  );
}
