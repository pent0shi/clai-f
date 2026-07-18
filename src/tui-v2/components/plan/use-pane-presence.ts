/**
 * Task/plan pane presence — instant show/hide (no slide animation).
 *
 * Animation was removed: enter/exit slides felt laggy on pane open/close.
 */

import type { PaneAnimState } from "./plan-pane-anim.js";

/**
 * Drive mounted state from a boolean `open` request.
 * progress is always 0 or 1 — no intermediate frames.
 */
export function usePanePresence(open: boolean): PaneAnimState {
  return {
    phase: open ? "open" : "closed",
    progress: open ? 1 : 0,
    mounted: open,
  };
}
