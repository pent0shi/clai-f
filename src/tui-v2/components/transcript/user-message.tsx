/** @jsxImportSource @opentui/react */
/** Renders a `UserItem` (CHAT-001, V2-051). */

import { useMemo, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { UserItem } from "../../state/transcript-types.js";
import type { Theme } from "../../rendering/theme.js";
import { wrapUserPrompt } from "../../rendering/user-message-wrap.js";
import { LinkableText } from "./linkable-text.js";
import { useClickWithoutDrag } from "./use-click-without-drag.js";

export function UserMessage(props: {
  item: UserItem;
  theme: Theme;
  onOpen: (prompt: string) => void;
  /** Chat-pane columns so long prompts reflow beside the plan/task pane. */
  contentWidth?: number | undefined;
}): ReactNode {
  const { item, theme, onOpen, contentWidth } = props;
  const { width: termWidth } = useTerminalDimensions();
  // Prefer shell chat width so prompts reflow when the tasks pane is open;
  // fall back to term−chrome when contentWidth is not threaded yet.
  const wrapBudget = Math.max(
    20,
    contentWidth != null ? contentWidth : Math.max(40, termWidth - 8),
  );
  const lines = useMemo(
    () => wrapUserPrompt(item.text, wrapBudget),
    [item.text, wrapBudget],
  );

  // Text is selectable for drag-copy; click (no drag) opens prompt actions.
  const click = useClickWithoutDrag(() => onOpen(item.text));

  return (
    <box
      id={item.id}
      border
      borderStyle="rounded"
      style={{
        flexDirection: "row",
        marginBottom: 1,
        borderColor: theme.userBorder,
        backgroundColor: theme.statusBackground,
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      }}
      onMouseDown={click.onMouseDown}
      onMouseUp={click.onMouseUp}
    >
      <text
        selectable
        style={{
          // White on darker amber plate; border stays lighter #f5b351.
          fg: theme.white,
          bg: theme.prompt,
          attributes: TextAttributes.BOLD,
          flexShrink: 0,
        }}
      >
        {" YOU "}
      </text>
      <text content=" " selectable style={{ flexShrink: 0 }} />
      <box
        style={{
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 0,
          flexDirection: "column",
          width: "100%",
        }}
      >
        {lines.map((line, i) => (
          // Pre-wrapped to chat width — never clip mid-sentence when the
          // tasks pane narrows the chat column.
          <LinkableText
            key={i}
            text={line}
            theme={theme}
            selectable
            wrapMode="none"
          />
        ))}
      </box>
    </box>
  );
}
