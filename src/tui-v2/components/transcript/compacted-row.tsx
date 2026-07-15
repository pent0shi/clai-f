/** @jsxImportSource @opentui/react */
/**
 * Compacted-context card — compact summary strip; full memory opens in the
 * pager modal (same as tool OUTPUT), not an in-chat mega-expand.
 */

import { useMemo, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { CompactedItem } from "../../state/transcript-types.js";
import type { Theme } from "../../rendering/theme.js";
import type { AppServices } from "../../bootstrap/composition-root.js";
import { displayCompactSummary } from "../../state/transcript-hydrate.js";
import { renderMarkdownLines } from "../../rendering/render-markdown-lines.js";
import { useClickWithoutDrag } from "./use-click-without-drag.js";

const PREVIEW_LINES = 4;

export function CompactedRow(props: {
  item: CompactedItem;
  theme: Theme;
  services: AppServices;
  /** Chat-pane columns (plan split/overlay already subtracted). */
  contentWidth?: number | undefined;
  /** Kept for Ctrl+O parity — still opens the pager, does not dump in-chat. */
  expanded: boolean;
  onToggle: () => void;
}): ReactNode {
  const { item, theme, services, contentWidth } = props;
  const { width: termWidth } = useTerminalDimensions();
  const wrapWidth = Math.max(
    20,
    contentWidth != null
      ? Math.max(20, contentWidth - 4)
      : Math.max(40, termWidth - 10),
  );
  const summary = displayCompactSummary(item.summary);

  const allLines = useMemo(
    () =>
      renderMarkdownLines(summary, {
        width: wrapWidth,
        defaultFg: theme.foreground,
        stripOuterIndent: true,
      }),
    [summary, wrapWidth, theme.foreground],
  );

  const preview = allLines.slice(0, PREVIEW_LINES);
  const hidden = Math.max(0, allLines.length - PREVIEW_LINES);

  const tokenLabel =
    item.beforeTokens > 0 || item.afterTokens > 0
      ? `~${item.beforeTokens.toLocaleString()} → ~${item.afterTokens.toLocaleString()} tokens`
      : "";

  const openPager = (): void => {
    const title = tokenLabel
      ? `Compacted context · ${tokenLabel}`
      : "Compacted context";
    services.overlay.openPager(title, summary);
  };

  const click = useClickWithoutDrag(openPager);

  const borderFg = theme.activity;

  return (
    <box
      id={item.id}
      border
      borderStyle="rounded"
      style={{
        flexDirection: "column",
        width: "100%",
        marginBottom: 1,
        borderColor: borderFg,
        backgroundColor: theme.statusBackground,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
      }}
      onMouseDown={click.onMouseDown}
      onMouseUp={click.onMouseUp}
    >
      <box
        style={{
          flexDirection: "row",
          width: "100%",
          paddingTop: 0,
          paddingBottom: 0,
        }}
      >
        <text selectable style={{ fg: borderFg, attributes: TextAttributes.BOLD }}>
          ✦ Compacted context
        </text>
        <text content=" " selectable />
        <text
          selectable
          style={{
            fg: borderFg,
            bg: theme.chip,
            attributes: TextAttributes.BOLD,
          }}
        >
          {" memory "}
        </text>
        {tokenLabel ? (
          <>
            <text content=" " selectable />
            <text selectable style={{ fg: theme.muted, attributes: TextAttributes.DIM }}>
              {tokenLabel}
            </text>
          </>
        ) : null}
      </box>

      {preview.length > 0 ? (
        <box
          style={{
            flexDirection: "column",
            width: "100%",
            marginTop: 0,
            flexShrink: 1,
          }}
        >
          <text
            selectable
            style={{
              fg: theme.white,
              bg: theme.chipTeal,
              attributes: TextAttributes.BOLD,
            }}
          >
            {" SUMMARY "}
          </text>
          {preview.map((content, i) => (
            <box key={`l-${i}`} style={{ flexDirection: "row", width: "100%" }}>
              <text selectable style={{ fg: theme.muted }}>
                {"│ "}
              </text>
              <text content={content} selectable />
            </box>
          ))}
          {hidden > 0 ? (
            <text selectable>
              <span style={{ fg: theme.muted }}>{"│ "}</span>
              <span style={{ fg: theme.muted, attributes: TextAttributes.DIM }}>
                {`··· ${hidden} more lines ···`}
              </span>
            </text>
          ) : null}
        </box>
      ) : null}

      <box style={{ flexDirection: "row", width: "100%", marginTop: 0 }}>
        <text selectable={false} style={{ fg: theme.cyan }}>
          {"› "}
        </text>
        <text
          selectable={false}
          style={{ fg: theme.cyan, attributes: TextAttributes.DIM }}
        >
          click or Ctrl+O to open full memory in pager
        </text>
      </box>
    </box>
  );
}
