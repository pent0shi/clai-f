/** @jsxImportSource @opentui/react */
/**
 * File-diff UI for tool cards: collapse chips, code rows, single-file and
 * writeMany previews. Kept separate so tool-card.tsx stays under the line budget.
 */

import { useMemo, useState, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { MouseEvent } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { Theme } from "../../rendering/theme.js";
import {
  collapsedFileChangesLabel,
  presentFileChangePreview,
  relativeDisplayPath,
  rowBackground,
  syntaxColor,
} from "../../rendering/file-diff-view.js";
import type { FileChange } from "../../../tools/file-diff.js";
import { useClickWithoutDrag } from "./use-click-without-drag.js";
import { renderMarkdownLines } from "../../rendering/render-markdown-lines.js";
import {
  isMarkdownPath,
  isPureAddFileChange,
} from "../../rendering/pager-view-policy.js";

/** Default preview rows for a single-file edit card. */
const SINGLE_FILE_PREVIEW_ROWS = 40;
/** Cap per file in writeMany so multi-file scaffolds stay scannable. */
const WRITE_MANY_PREVIEW_ROWS = 8;

/**
 * Hover chip for collapse / collapse-all. Stops propagation so parent
 * header click does NOT open the file modal.
 */
export function DiffActionButton(props: {
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
        style={{
          fg,
          bg,
          attributes: hovered ? TextAttributes.BOLD : TextAttributes.NONE,
        }}
      />
    </box>
  );
}

/** One compact row: solid gutter · full-width code tint · height 1. */
function DiffCodeRow(props: {
  gutter: string;
  spans: readonly {
    kind: import("../../rendering/syntax-highlight.js").SyntaxKind;
    text: string;
  }[];
  displayText: string;
  tone: "context" | "add" | "del" | "gap" | "header";
  theme: Theme;
}): ReactNode {
  const { gutter, spans, displayText, tone, theme } = props;
  const bg = rowBackground(tone, theme);
  const isGap = tone === "gap" || tone === "header";
  const gutterFg = theme.diffGutter;
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
  maxRows?: number;
}): ReactNode {
  const {
    change,
    showPath,
    theme,
    onOpen,
    maxRows = SINGLE_FILE_PREVIEW_ROWS,
  } = props;
  const { width: termWidth } = useTerminalDimensions();
  const wrapWidth = Math.max(24, termWidth - 12);
  const open = useClickWithoutDrag(() => onOpen(change));
  const mark =
    change.kind === "create" ? "+" : change.kind === "overwrite" ? "~" : "·";
  const markFg =
    change.kind === "create"
      ? theme.success
      : change.kind === "overwrite"
        ? theme.activity
        : theme.toolOutput;

  // Pure-create / green-only .md: show rendered markdown in the card (not red/green).
  const mdSource = change.afterText ?? "";
  const showMarkdown =
    isPureAddFileChange(change) &&
    isMarkdownPath(change.path) &&
    Boolean(mdSource.trim());

  const mdLines = useMemo(() => {
    if (!showMarkdown) return [];
    return renderMarkdownLines(mdSource, {
      width: wrapWidth,
      defaultFg: theme.foreground,
      stripOuterIndent: true,
    }).slice(0, maxRows);
  }, [showMarkdown, mdSource, wrapWidth, theme.foreground, maxRows]);

  if (showMarkdown && mdLines.length > 0) {
    return (
      <box
        style={{ flexDirection: "column", width: "100%" }}
        onMouseDown={open.onMouseDown}
        onMouseUp={open.onMouseUp}
      >
        {showPath ? (
          <text selectable style={{ height: 1 }}>
            <span style={{ fg: markFg }}>{` ${mark} `}</span>
            <span style={{ fg: theme.inputBorder }}>
              {relativeDisplayPath(change.path)}
            </span>
            <span style={{ fg: theme.muted }}> · formatted</span>
          </text>
        ) : null}
        {mdLines.map((content, ri) => (
          <text
            key={ri}
            content={content ?? " "}
            selectable
            wrapMode="none"
          />
        ))}
      </box>
    );
  }

  const rows = presentFileChangePreview(change, { maxRows });
  return (
    <box
      style={{ flexDirection: "column", width: "100%" }}
      onMouseDown={open.onMouseDown}
      onMouseUp={open.onMouseUp}
    >
      {showPath ? (
        <text selectable style={{ height: 1 }}>
          <span style={{ fg: markFg }}>{` ${mark} `}</span>
          <span style={{ fg: theme.inputBorder }}>
            {relativeDisplayPath(change.path)}
          </span>
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

/** Collapsed writeMany path row (one file). */
function WriteManyCollapsedRow(props: {
  change: FileChange;
  theme: Theme;
  onOpen: (change: FileChange) => void;
}): ReactNode {
  const { change, theme, onOpen } = props;
  const open = useClickWithoutDrag(() => onOpen(change));
  const mark =
    change.kind === "create" ? "+" : change.kind === "overwrite" ? "~" : "·";
  const markFg =
    change.kind === "create"
      ? theme.success
      : change.kind === "overwrite"
        ? theme.activity
        : theme.toolOutput;
  return (
    <text
      selectable
      style={{ height: 1 }}
      onMouseDown={open.onMouseDown}
      onMouseUp={open.onMouseUp}
    >
      <span style={{ fg: markFg }}>{` ${mark} `}</span>
      <span style={{ fg: theme.inputBorder }}>
        {relativeDisplayPath(change.path)}
      </span>
    </text>
  );
}

export function FileDiffBody(props: {
  changes: readonly FileChange[];
  theme: Theme;
  diffExpanded: boolean;
  onOpen: (change: FileChange) => void;
  /** writeMany: multi-file path headers + compact per-file hunks when expanded. */
  multiFilePreview?: boolean;
}): ReactNode {
  const {
    changes,
    theme,
    diffExpanded,
    onOpen,
    multiFilePreview = false,
  } = props;

  const label = collapsedFileChangesLabel(changes);
  const openPrimary = useClickWithoutDrag(() => {
    if (changes[0]) onOpen(changes[0]!);
  });

  const showHunks = diffExpanded;
  const maxRows = multiFilePreview
    ? WRITE_MANY_PREVIEW_ROWS
    : SINGLE_FILE_PREVIEW_ROWS;

  return (
    <box style={{ flexDirection: "column", width: "100%", marginTop: 0 }}>
      {!multiFilePreview ? (
        <box
          style={{
            flexDirection: "row",
            width: "100%",
            height: 1,
            flexShrink: 0,
          }}
          onMouseDown={openPrimary.onMouseDown}
          onMouseUp={openPrimary.onMouseUp}
        >
          <text
            selectable
            style={{
              height: 1,
              fg: theme.foreground,
              attributes: TextAttributes.BOLD,
            }}
          >
            {label}
          </text>
        </box>
      ) : null}

      {showHunks
        ? changes.map((change, ci) => (
            <FileDiffHunks
              key={`${change.path}-${ci}`}
              change={change}
              showPath={multiFilePreview || changes.length > 1}
              theme={theme}
              onOpen={onOpen}
              maxRows={maxRows}
            />
          ))
        : multiFilePreview
          ? changes.map((change, ci) => (
              <WriteManyCollapsedRow
                key={`wm-c-${ci}`}
                change={change}
                theme={theme}
                onOpen={onOpen}
              />
            ))
          : null}
    </box>
  );
}
