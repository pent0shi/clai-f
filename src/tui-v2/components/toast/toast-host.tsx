/** @jsxImportSource @opentui/react */
/**
 * Notification toasts — top-center, slide in / hold / slide out.
 *
 * Heavy aqua frame + yellowish prompt-boundary text. Motion is discrete row
 * steps (terminal); ease curves + 30fps tick keep it feeling smooth.
 */

import { useEffect, useState, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type {
  ToastController,
  ToastItem,
  ToastLevel,
} from "../../controllers/toast-controller.js";
import type { Theme } from "../../rendering/theme.js";
import { useToastState } from "../../state/use-toast.js";
import {
  TOAST_BOX_HEIGHT,
  toastAnimAt,
} from "./toast-anim.js";

export interface ToastHostProps {
  readonly toast: ToastController;
  readonly theme: Theme;
  readonly termWidth: number;
  readonly termHeight: number;
}

/** Soft elevated surface — slight whitish shade on near-black. */
const TOAST_SURFACE_DARK = "#1c2028";
const TOAST_SURFACE_LIGHT = "#f4f5f7";

/** Vertical gap between stacked toasts at rest. */
const TOAST_STACK_GAP = 1;

/** Animation repaint interval (~30 fps). */
const TICK_MS = 33;

function toastSurface(theme: Theme): string {
  const bg = theme.background.toLowerCase();
  const isDark =
    bg.startsWith("#0") ||
    bg.startsWith("#1") ||
    bg === "#0b0e14" ||
    bg === "#11151c";
  return isDark ? TOAST_SURFACE_DARK : TOAST_SURFACE_LIGHT;
}

function levelGlyph(level: ToastLevel): string {
  switch (level) {
    case "success":
      return "✓";
    case "warn":
      return "!";
    case "error":
      return "✗";
    default:
      return "·";
  }
}

function ToastPill(props: {
  item: ToastItem;
  theme: Theme;
  top: number;
  left: number;
  width: number;
  visibility: number;
}): ReactNode {
  const { item, theme, top, left, width, visibility } = props;
  if (visibility <= 0.02) return null;
  const surface = toastSurface(theme);
  const border = theme.inputBorder;
  const textFg = theme.userBorder;
  const label = `${levelGlyph(item.level)}  ${item.message}`;
  // Approximate “fade” with DIM when sliding in/out — always keep BOLD.
  const dim = visibility < 0.85;

  // OpenTUI paints backgroundColor on EVERY cell of the box, including the
  // border character cells. If surface is on the outer box, grey fills under
  // the aqua glyphs and looks like a grey rect with an inset border.
  // Outer = app background (invisible under border) + aqua frame.
  // Inner = surface well; row + alignItems center vertically centers the label.
  return (
    <box
      border
      borderStyle="rounded"
      style={{
        position: "absolute",
        top,
        left,
        width,
        height: TOAST_BOX_HEIGHT,
        zIndex: 1000,
        borderColor: border,
        backgroundColor: theme.background,
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "stretch",
        paddingLeft: 0,
        paddingRight: 0,
        paddingTop: 0,
        paddingBottom: 0,
      }}
    >
      <box
        style={{
          flexGrow: 1,
          width: "100%",
          minHeight: 1,
          backgroundColor: surface,
          flexDirection: "row",
          // Vertical + horizontal center of the single label line.
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
            fg: textFg,
            bg: surface,
            height: 1,
            attributes: dim
              ? TextAttributes.BOLD | TextAttributes.DIM
              : TextAttributes.BOLD,
          }}
        />
      </box>
    </box>
  );
}

export function ToastHost(props: ToastHostProps): ReactNode {
  const { toast, theme, termWidth, termHeight } = props;
  const items = useToastState(toast);
  const [now, setNow] = useState(() => Date.now());

  // Drive enter/hold/exit motion while any toast is alive.
  useEffect(() => {
    if (items.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    (id as unknown as { unref?: () => void }).unref?.();
    return () => clearInterval(id);
  }, [items.length > 0]);

  if (items.length === 0) return null;

  // Wide enough for full messages (up to controller cap); slightly compact.
  const maxWidth = Math.min(64, Math.max(32, Math.floor(termWidth * 0.58)));
  // Newest on top of stack (drawn first in reverse so later paint on top).
  const ordered = [...items].reverse();
  const maxStack = Math.max(
    1,
    Math.min(3, Math.floor((termHeight - 4) / (TOAST_BOX_HEIGHT + TOAST_STACK_GAP))),
  );
  const visible = ordered.slice(0, maxStack);

  return (
    <>
      {visible.map((item, index) => {
        // +8 for glyph, spaces, and border/pad — prefer full message width.
        const toastWidth = Math.min(
          maxWidth,
          Math.max(32, item.message.length + 8),
        );
        // Top-center horizontally.
        const left = Math.max(0, Math.floor((termWidth - toastWidth) / 2));
        const anim = toastAnimAt(now - item.createdAt, item.durationMs);
        if (anim.phase === "gone") return null;
        // Stack older toasts below the primary (rest) slot.
        const stackOffset =
          index * (TOAST_BOX_HEIGHT + TOAST_STACK_GAP);
        const top = anim.top + stackOffset;
        // Skip if fully above the viewport after stack offset.
        if (top + TOAST_BOX_HEIGHT < 0) return null;
        return (
          <ToastPill
            key={item.id}
            item={item}
            theme={theme}
            top={top}
            left={left}
            width={toastWidth}
            visibility={anim.visibility}
          />
        );
      })}
    </>
  );
}
