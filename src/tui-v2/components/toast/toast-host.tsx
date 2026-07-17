/** @jsxImportSource @opentui/react */
/**
 * Notification toasts — top-center, slide in / hold / slide out.
 *
 * Solid message-chip style (no border): intro "AGENT MODE" plate (`theme.mode`)
 * with white bold text. Roomier height + full message (no visual truncation).
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

/** Vertical gap between stacked toasts at rest. */
const TOAST_STACK_GAP = 1;

/** Animation repaint interval (~30 fps). */
const TICK_MS = 33;

/** Horizontal padding spaces each side of the label (larger readable chip). */
const H_PAD = 3;

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

/** Full label with side padding — never clips the message body. */
export function toastLabel(level: ToastLevel, message: string): string {
  const pad = " ".repeat(H_PAD);
  return `${pad}${levelGlyph(level)}  ${message}${pad}`;
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

  // Same plate as intro "AGENT MODE" badge; white bold label.
  const plate = theme.mode;
  const textFg = theme.white;
  const label = toastLabel(item.level, item.message);
  const dim = visibility < 0.85;
  const attrs = dim
    ? TextAttributes.BOLD | TextAttributes.DIM
    : TextAttributes.BOLD;
  // Vertical pad rows so the label sits centered in a taller chip.
  const blank = " ".repeat(Math.max(1, width));

  return (
    <box
      style={{
        position: "absolute",
        top,
        left,
        width,
        height: TOAST_BOX_HEIGHT,
        zIndex: 1000,
        backgroundColor: plate,
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "stretch",
        paddingLeft: 0,
        paddingRight: 0,
        paddingTop: 0,
        paddingBottom: 0,
      }}
    >
      <text
        selectable={false}
        content={blank}
        style={{ fg: plate, bg: plate, height: 1, width }}
      />
      <text
        selectable={false}
        content={label.padEnd(width).slice(0, width)}
        style={{
          fg: textFg,
          bg: plate,
          height: 1,
          width,
          attributes: attrs,
        }}
      />
      <text
        selectable={false}
        content={blank}
        style={{ fg: plate, bg: plate, height: 1, width }}
      />
    </box>
  );
}

export function ToastHost(props: ToastHostProps): ReactNode {
  const { toast, theme, termWidth, termHeight } = props;
  const items = useToastState(toast);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (items.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    (id as unknown as { unref?: () => void }).unref?.();
    return () => clearInterval(id);
  }, [items.length > 0]);

  if (items.length === 0) return null;

  // Wide enough for full messages; leave small terminal margins only.
  const maxWidth = Math.max(24, Math.min(termWidth - 4, termWidth));
  const ordered = [...items].reverse();
  const maxStack = Math.max(
    1,
    Math.min(3, Math.floor((termHeight - 4) / (TOAST_BOX_HEIGHT + TOAST_STACK_GAP))),
  );
  const visible = ordered.slice(0, maxStack);

  return (
    <>
      {visible.map((item, index) => {
        const label = toastLabel(item.level, item.message);
        // Size chip to the full label — do not shrink/truncate for maxWidth
        // unless the terminal is narrower than the text (then use full width).
        const toastWidth = Math.min(maxWidth, Math.max(label.length, 16));
        const left = Math.max(0, Math.floor((termWidth - toastWidth) / 2));
        const anim = toastAnimAt(now - item.createdAt, item.durationMs);
        if (anim.phase === "gone") return null;
        const stackOffset = index * (TOAST_BOX_HEIGHT + TOAST_STACK_GAP);
        const top = anim.top + stackOffset;
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
