/** @jsxImportSource @opentui/react */
/**
 * Notification toasts — top-right stack.
 *
 * Thick (heavy) amber border matching the YOU badge plate. Outer shell draws
 * only the frame on the app background; inner box holds the whitish surface so
 * fill never paints outside the border characters.
 */

import type { ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type {
  ToastController,
  ToastItem,
  ToastLevel,
} from "../../controllers/toast-controller.js";
import type { Theme } from "../../rendering/theme.js";
import { useToastState } from "../../state/use-toast.js";

export interface ToastHostProps {
  readonly toast: ToastController;
  readonly theme: Theme;
  readonly termWidth: number;
  readonly termHeight: number;
}

/** Soft elevated surface — slight whitish shade on near-black. */
const TOAST_SURFACE_DARK = "#1c2028";
const TOAST_SURFACE_LIGHT = "#f4f5f7";

/** Outer box height (includes heavy border rows). */
const TOAST_HEIGHT = 5;
/** Gap between stacked toasts. */
const TOAST_STRIDE = 6;

function toastSurface(theme: Theme): string {
  const bg = theme.background.toLowerCase();
  const isDark =
    bg.startsWith("#0") ||
    bg.startsWith("#1") ||
    bg === "#0b0e14" ||
    bg === "#11151c";
  return isDark ? TOAST_SURFACE_DARK : TOAST_SURFACE_LIGHT;
}

function levelGlyph(level: ToastLevel): { glyph: string; fg: string } {
  switch (level) {
    case "success":
      return { glyph: "✓", fg: "#4ADE80" };
    case "warn":
      return { glyph: "!", fg: "#FACC15" };
    case "error":
      return { glyph: "✗", fg: "#F87171" };
    default:
      return { glyph: "·", fg: "#F8FAFC" };
  }
}

function ToastPill(props: {
  item: ToastItem;
  theme: Theme;
  top: number;
  left: number;
  width: number;
}): ReactNode {
  const { item, theme, top, left, width } = props;
  const { glyph, fg: glyphFg } = levelGlyph(item.level);
  const surface = toastSurface(theme);
  // Border = YOU badge plate (prompt bg).
  const border = theme.prompt;
  const label = `${glyph}  ${item.message}`;

  return (
    // Outer: heavy frame only. Background matches the app so no whitish
    // fill bleeds outside the border cells.
    <box
      border
      borderStyle="heavy"
      style={{
        position: "absolute",
        top,
        left,
        width,
        height: TOAST_HEIGHT,
        zIndex: 1000,
        borderColor: border,
        backgroundColor: theme.background,
        flexDirection: "column",
        paddingLeft: 0,
        paddingRight: 0,
        paddingTop: 0,
        paddingBottom: 0,
      }}
    >
      {/* Inner: whitish surface strictly inside the border. */}
      <box
        style={{
          flexGrow: 1,
          width: "100%",
          minHeight: 1,
          backgroundColor: surface,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          paddingLeft: 2,
          paddingRight: 2,
        }}
      >
        <text
          selectable={false}
          content={label}
          style={{
            fg: glyphFg,
            attributes: TextAttributes.BOLD,
          }}
        />
      </box>
    </box>
  );
}

export function ToastHost(props: ToastHostProps): ReactNode {
  const { toast, theme, termWidth, termHeight } = props;
  const items = useToastState(toast);
  if (items.length === 0) return null;

  const maxWidth = Math.min(56, Math.max(34, Math.floor(termWidth * 0.52)));
  const ordered = [...items].reverse();
  const maxStack = Math.max(
    1,
    Math.min(3, Math.floor((termHeight - 8) / TOAST_STRIDE)),
  );
  const visible = ordered.slice(0, maxStack);

  return (
    <>
      {visible.map((item, index) => {
        const toastWidth = Math.min(
          maxWidth,
          Math.max(30, item.message.length + 10),
        );
        const left = Math.max(0, termWidth - toastWidth - 2);
        const top = 1 + index * TOAST_STRIDE;
        return (
          <ToastPill
            key={item.id}
            item={item}
            theme={theme}
            top={top}
            left={left}
            width={toastWidth}
          />
        );
      })}
    </>
  );
}
