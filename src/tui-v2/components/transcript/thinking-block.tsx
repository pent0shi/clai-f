/** @jsxImportSource @opentui/react */
/**
 * Renders a `ThinkingItem` (CHAT-006, V2-053).
 *
 * Live stream: while the model is still reasoning (`item.streaming`), the body
 * is shown only when the user asked for reasoning — thinking enabled
 * (`/variants`) or expanded with Ctrl+T. Models like MiniMax M3, GLM and Kimi
 * reason by default no matter what we request, and printing that chain
 * verbatim contradicts an explicit `/variants off`. After the block is
 * finalized, the body follows the global Ctrl+T toggle (or a per-block
 * override from clicking the header).
 *
 * Placement: thinking rows always precede the ◆ Response / tool cards for
 * the same model step (agent emits thinking-block before assistant-message
 * and tool-call). Violet accent distinguishes reasoning from green replies.
 */

import { useMemo, type ReactNode } from "react";
import { TextAttributes, type MouseEvent } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { ThinkingItem } from "../../state/transcript-types.js";
import type { Theme } from "../../rendering/theme.js";
import { SELECTABLE_LINE_STYLE } from "./selectable-line.js";
import { liveThinkingTail } from "../../rendering/thinking-tail.js";
import { wrapPagerLine } from "../../rendering/pager-chrome.js";

/** Body indent inside the block (paddingLeft below). */
const BODY_INDENT = 2;

export function ThinkingBlock(props: {
  item: ThinkingItem;
  theme: Theme;
  expanded: boolean;
  /**
   * Show reasoning as it streams. False when the user turned thinking off, so
   * an always-reasoning model does not paint its chain of thought anyway.
   */
  liveBody?: boolean | undefined;
  /** Chat-pane columns (plan split/overlay already subtracted). */
  contentWidth?: number | undefined;
  onToggle: () => void;
}): ReactNode {
  const { item, theme, expanded, liveBody = true, contentWidth, onToggle } = props;
  const { width: termWidth } = useTerminalDimensions();
  const showBody = expanded || (item.streaming && liveBody);
  const onMouseUp = (event: MouseEvent): void => {
    event.preventDefault();
    // Only allow collapse/expand once the block is complete.
    if (item.streaming) return;
    onToggle();
  };

  const header = item.streaming
    ? showBody
      ? "✦ thinking…"
      : "✦ thinking… · ctrl+t to view"
    : showBody
      ? "▾ thinking"
      : "▸ thinking · ctrl+t or click to view";

  const wrapWidth = Math.max(
    20,
    (contentWidth != null ? contentWidth : Math.max(40, termWidth - 8)) -
      BODY_INDENT,
  );
  const bodyLines = useMemo(() => {
    if (!showBody || !item.content) return [];
    const source = item.streaming
      ? liveThinkingTail(item.content)
      : item.content;
    return source
      .replace(/\r\n/g, "\n")
      .split("\n")
      .flatMap((line) => wrapPagerLine(line, wrapWidth));
  }, [showBody, item.content, item.streaming, wrapWidth]);

  return (
    <box id={item.id} style={{ flexDirection: "column", marginBottom: 1, width: "100%" }}>
      <box onMouseUp={onMouseUp} style={{ flexDirection: "row" }}>
        <text
          selectable
          style={{
            fg: theme.thinking,
            attributes: TextAttributes.ITALIC,
          }}
        >
          {header}
        </text>
      </box>
      {showBody && bodyLines.length > 0 ? (
        <box
          style={{
            flexDirection: "column",
            paddingLeft: BODY_INDENT,
            width: "100%",
            // Reasoning is the only body whose source text is unbounded, so
            // clip here as well as pre-wrapping: a stray overlong token must
            // never paint into cells outside this pane, which the renderer
            // does not repaint and would leave streaked with fragments.
            overflow: "hidden",
          }}
        >
          {bodyLines.map((content, index) => (
            // Pre-wrapped above, so OpenTUI must not re-wrap: its own wrap uses
            // the measured box which overflowed the pane by a few columns.
            <text
              key={index}
              content={content.length === 0 ? " " : content}
              selectable
              wrapMode="none"
              style={{
                ...SELECTABLE_LINE_STYLE,
                fg: theme.thinking,
                attributes: TextAttributes.ITALIC,
              }}
            />
          ))}
        </box>
      ) : null}
    </box>
  );
}
