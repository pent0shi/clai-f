/**
 * Keep a pane mounted through enter/exit so OpenTUI can paint slide motion.
 */

import { useEffect, useState } from "react";
import {
  PLAN_PANE_ENTER_MS,
  PLAN_PANE_EXIT_MS,
  paneMounted,
  panePhaseComplete,
  paneProgress,
  type PaneAnimPhase,
  type PaneAnimState,
} from "./plan-pane-anim.js";

const TICK_MS = 33;

/**
 * Drive enter → open → exit → closed from a boolean `open` request.
 * Snappy timing (~120ms in / ~100ms out) with ease curves in paneProgress.
 */
export function usePanePresence(open: boolean): PaneAnimState {
  const [phase, setPhase] = useState<PaneAnimPhase>(() =>
    open ? "enter" : "closed",
  );
  const [phaseAt, setPhaseAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  // Respond to open/close requests.
  useEffect(() => {
    if (open) {
      if (phase === "closed" || phase === "exit") {
        setPhase("enter");
        setPhaseAt(Date.now());
        setNow(Date.now());
      }
    } else if (phase === "open" || phase === "enter") {
      setPhase("exit");
      setPhaseAt(Date.now());
      setNow(Date.now());
    }
  }, [open, phase]);

  // Tick during enter/exit; promote phase when the segment completes.
  useEffect(() => {
    if (phase !== "enter" && phase !== "exit") return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      const next = panePhaseComplete(
        phase,
        t - phaseAt,
        PLAN_PANE_ENTER_MS,
        PLAN_PANE_EXIT_MS,
      );
      if (next) {
        setPhase(next);
        setPhaseAt(t);
      }
    }, TICK_MS);
    (id as unknown as { unref?: () => void }).unref?.();
    return () => clearInterval(id);
  }, [phase, phaseAt]);

  const age = now - phaseAt;
  const progress = paneProgress(
    phase,
    age,
    PLAN_PANE_ENTER_MS,
    PLAN_PANE_EXIT_MS,
  );

  return {
    phase,
    progress,
    mounted: paneMounted(phase),
  };
}
