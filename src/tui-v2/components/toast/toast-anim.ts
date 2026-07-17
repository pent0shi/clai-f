/**
 * Pure toast motion math — slide in from top-center, hold, slide out.
 * Terminal UIs animate by discrete row steps; ease curves keep it smooth-ish.
 */

import {
  TOAST_ENTER_MS,
  TOAST_EXIT_MS,
} from "../../controllers/toast-controller.js";
import { easeInCubic, easeOutCubic } from "../../motion/ease.js";

export { easeInCubic, easeOutCubic } from "../../motion/ease.js";

/**
 * Outer box height (includes heavy border rows) — keep in sync with host.
 * 5 = top border + padded content rows + bottom border (roomy, bold label).
 * Surface fill is on the outer box so grey covers the full interior.
 */
export const TOAST_BOX_HEIGHT = 5;

/** Resting top row when fully visible (1 = just under terminal top edge). */
export const TOAST_REST_TOP = 1;

/** Off-screen top when fully hidden above the viewport. */
export const TOAST_HIDDEN_TOP = -TOAST_BOX_HEIGHT;

export type ToastAnimPhase = "enter" | "hold" | "exit" | "gone";

export interface ToastAnimState {
  readonly phase: ToastAnimPhase;
  /** Absolute top row for absolute positioning. */
  readonly top: number;
  /**
   * 0..1 visibility for optional dimming (1 = fully shown).
   * Terminal cannot fade alpha; host may map low values to DIM.
   */
  readonly visibility: number;
}

/**
 * Compute motion for a toast at `ageMs` since createdAt.
 * @param holdMs time at rest (item.durationMs)
 */
export function toastAnimAt(ageMs: number, holdMs: number): ToastAnimState {
  const age = Math.max(0, ageMs);
  const hold = Math.max(0, holdMs);
  const enterEnd = TOAST_ENTER_MS;
  const holdEnd = enterEnd + hold;
  const exitEnd = holdEnd + TOAST_EXIT_MS;

  if (age < enterEnd) {
    const p = easeOutCubic(age / Math.max(1, TOAST_ENTER_MS));
    const top = Math.round(
      TOAST_HIDDEN_TOP + (TOAST_REST_TOP - TOAST_HIDDEN_TOP) * p,
    );
    return { phase: "enter", top, visibility: p };
  }
  if (age < holdEnd) {
    return { phase: "hold", top: TOAST_REST_TOP, visibility: 1 };
  }
  if (age < exitEnd) {
    const p = easeInCubic((age - holdEnd) / Math.max(1, TOAST_EXIT_MS));
    const top = Math.round(
      TOAST_REST_TOP + (TOAST_HIDDEN_TOP - TOAST_REST_TOP) * p,
    );
    return { phase: "exit", top, visibility: 1 - p };
  }
  return { phase: "gone", top: TOAST_HIDDEN_TOP, visibility: 0 };
}
