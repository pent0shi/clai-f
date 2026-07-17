/** @jsxImportSource @opentui/react */
/**
 * Bordered multi-line input chrome for the composer.
 * Simple flex layout so mouse clicks land on the expected character.
 */

import { type RefObject, type ReactNode } from "react";
import {
  TextAttributes,
  type KeyEvent,
  type MouseEvent,
  type TextareaRenderable,
} from "@opentui/core";
import type { Theme } from "../../rendering/theme.js";

export function ComposerInputBox(props: {
  readonly theme: Theme;
  readonly editorRef: RefObject<TextareaRenderable | null>;
  readonly focused: boolean;
  readonly running?: boolean | undefined;
  readonly inputWidth: number;
  readonly textRows: number;
  readonly boxHeight: number;
  readonly metaShown: string;
  readonly chromeFg: string;
  readonly keyBindings: never;
  readonly onMouseDown: () => void;
  readonly onMouseScroll: (event: MouseEvent) => void;
  readonly onSubmit: () => void;
  readonly onContentChange: () => void;
  readonly onCursorChange: () => void;
  readonly onKeyDown: (key: KeyEvent) => void;
}): ReactNode {
  const {
    theme,
    editorRef,
    focused,
    running,
    inputWidth,
    textRows,
    boxHeight,
    metaShown,
    chromeFg,
    keyBindings,
    onMouseDown,
    onMouseScroll,
    onSubmit,
    onContentChange,
    onCursorChange,
    onKeyDown,
  } = props;

  return (
    <box
      border
      // Heavy = thicker frame so focus/blur is easy to read.
      borderStyle="heavy"
      {...(metaShown
        ? {
            title: ` ${metaShown} `,
            titleAlignment: "right" as const,
            titleColor: focused ? theme.muted : theme.chip,
          }
        : {})}
      style={{
        height: boxHeight,
        width: "100%",
        maxWidth: inputWidth,
        // Clip long paste so content cannot tear the right border.
        overflow: "hidden",
        borderColor: chromeFg,
        backgroundColor: theme.statusBackground,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: "row",
        flexShrink: 0,
      }}
      onMouseDown={onMouseDown}
      onMouseScroll={onMouseScroll}
    >
      <text
        content="❯ "
        style={{
          fg: chromeFg,
          width: 2,
          flexShrink: 0,
          attributes: focused ? TextAttributes.BOLD : TextAttributes.DIM,
        }}
      />
      <textarea
        ref={editorRef}
        focused={focused}
        selectable={false}
        showCursor={focused}
        placeholder={
          running
            ? "type to queue a message…"
            : `ask anything · @ file or folder · Shift+Enter newline`
        }
        placeholderColor={theme.muted}
        textColor={theme.foreground}
        backgroundColor={theme.statusBackground}
        cursorColor={chromeFg}
        keyBindings={keyBindings}
        wrapMode="word"
        onSubmit={onSubmit}
        onContentChange={onContentChange}
        onCursorChange={onCursorChange}
        onKeyDown={onKeyDown}
        // Flex-only sizing — fixed width desyncs click hit-tests from the caret.
        style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, height: textRows }}
      />
    </box>
  );
}
