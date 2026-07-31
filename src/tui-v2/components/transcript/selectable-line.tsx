/** @jsxImportSource @opentui/react */
/**
 * Full-width selectable text row.
 *
 * OpenTUI only starts drag-select when the pointer is inside the renderable's
 * layout box. Shrink-wrapped `<text>` is only as wide as its glyphs, so users
 * had to aim precisely at characters. Forcing `width: "100%"` makes the whole
 * row a hit target while copy still trims trailing whitespace.
 */

import type { ReactNode } from "react";

export const SELECTABLE_LINE_STYLE = {
  width: "100%" as const,
  // Keep a one-cell tall hit strip even for empty/spacer rows.
  height: 1 as const,
};

/**
 * Row style that also repaints its full width.
 *
 * A row narrower than its container leaves the cells to its right untouched,
 * so glyphs from whatever previously occupied that screen line survive — text
 * appears to duplicate down the column while scrolling. Pass the colour of the
 * surface the row sits on (chat pane vs card) so the fill is invisible.
 */
export function selectableRowStyle(surface: string): {
  width: "100%";
  height: 1;
  bg: string;
} {
  return { ...SELECTABLE_LINE_STYLE, bg: surface };
}

export function SelectableLine(props: {
  content?: string | undefined;
  children?: ReactNode;
  fg?: string | undefined;
  bg?: string | undefined;
  attributes?: number | undefined;
  wrapMode?: "none" | "char" | "word" | undefined;
}): ReactNode {
  const { content, children, fg, bg, attributes, wrapMode = "none" } = props;
  if (content !== undefined) {
    return (
      <text
        content={content.length === 0 ? " " : content}
        selectable
        wrapMode={wrapMode}
        style={{
          ...SELECTABLE_LINE_STYLE,
          ...(fg ? { fg } : {}),
          ...(bg ? { bg } : {}),
          ...(attributes !== undefined ? { attributes } : {}),
        }}
      />
    );
  }
  return (
    <text
      selectable
      wrapMode={wrapMode}
      style={{
        ...SELECTABLE_LINE_STYLE,
        ...(fg ? { fg } : {}),
        ...(bg ? { bg } : {}),
        ...(attributes !== undefined ? { attributes } : {}),
      }}
    >
      {children}
    </text>
  );
}
