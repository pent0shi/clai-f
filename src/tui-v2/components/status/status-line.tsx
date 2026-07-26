/** @jsxImportSource @opentui/react */
/**
 * Chrome under the composer — responsive density so chips never pile over
 * the token count / scroll badges on the right.
 *
 * Density (by content width):
 *  - xs  (<48):  MODE · tokens · ▲▼
 *  - sm  (<68):  MODE · ^H · tokens · ▲▼  (+ spinner/activity when running)
 *  - md  (<96):  MODE · core keys · ^H · tokens · ▲▼
 *  - lg  (≥96):  full shortcut row
 */

import { useEffect, useState, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type {
  SessionController,
} from "../../../app/controllers/session-controller.js";
import type { ResponderRuntimeState } from "../../../app/controllers/session-responder.js";
import type { Mode } from "../../../types.js";
import {
  formatContextChip,
  type ContextUsageSnapshot,
} from "../../../llm/token-usage.js";
import type { Theme } from "../../rendering/theme.js";
import { useSessionState } from "../../state/use-session-state.js";
import {
  EMPTY_SCROLL_METRICS,
  transcriptScrollPort,
  type ScrollMetrics,
} from "../transcript/transcript-scroll-port.js";

export interface StatusLineProps {
  readonly session: SessionController;
  readonly mode: Mode;
  readonly theme: Theme;
  readonly activity: string | undefined;
  readonly width: number;
  readonly hasActivePlan: boolean;
  readonly planVisible: boolean;
  readonly thinkingExpanded?: boolean | undefined;
  readonly outputExpanded?: boolean | undefined;
  readonly onToggleThinking?: (() => void) | undefined;
  readonly onToggleOutput?: (() => void) | undefined;
  readonly onTogglePlan?: (() => void) | undefined;
  readonly onJumpTop?: (() => void) | undefined;
  readonly onJumpBottom?: (() => void) | undefined;
  readonly onClearDraft?: (() => void) | undefined;
  readonly onOpenShortcuts?: (() => void) | undefined;
  readonly onCycleMode?: (() => void) | undefined;
  /** Arm/confirm cancellation — the same controller path Esc uses. */
  readonly onRequestCancel?: (() => void) | undefined;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface StatusHint {
  readonly short: string;
  readonly expand: string;
}

// One vocabulary for the busy row: the target is always the same double-Esc
// stop, spelled the same way at every density.
export function busyCancelHint(density: StatusDensity): StatusHint {
  return {
    short: density === "sm" ? "Esc×2" : "Esc×2 stop",
    expand: "stop turn, queue, and jobs",
  };
}

export type IdleHintId = "commands" | "thinking" | "output" | "shortcuts";

// Thin idle row: the chords users reach for, not every binding. The full list
// lives behind /shortcuts.
export function idleHintIds(density: StatusDensity): readonly IdleHintId[] {
  if (density === "xs" || density === "sm") return [];
  if (density === "md") return ["commands", "thinking", "output"];
  return ["commands", "thinking", "output", "shortcuts"];
}

// Hover must not change a chip's width, or every chip to its right shifts.
function hintWidth(short: string, expand: string): number {
  return Math.max(short.length, expand.length) + 2;
}

export type StatusDensity = "xs" | "sm" | "md" | "lg";

/** Map content width → chrome density. */
export function statusDensityForWidth(width: number): StatusDensity {
  if (width < 48) return "xs";
  if (width < 68) return "sm";
  if (width < 96) return "md";
  return "lg";
}

export interface ModeIndicatorPresentation {
  readonly label: string;
  readonly description: string;
}

export function modeIndicatorPresentation(mode: Mode): ModeIndicatorPresentation {
  return { label: mode.toUpperCase(), description: "" };
}

/**
 * Tasks pane toggle label by density.
 * - xs: hidden (caller skips chip)
 * - sm: `^H`
 * - md: `^H hide` / `^H show`
 * - lg: `^H · hide` / `^H · show`
 */
export function tasksToggleLabel(
  visible: boolean,
  density: StatusDensity | boolean = "lg",
): string {
  // Back-compat: tests/callers that pass `compact: true` map to sm.
  const d: StatusDensity =
    typeof density === "boolean" ? (density ? "sm" : "lg") : density;
  if (d === "xs" || d === "sm") return "^H";
  if (d === "md") return visible ? "^H hide" : "^H show";
  return visible ? "^H · hide" : "^H · show";
}

export function responderStatusText(
  state: ResponderRuntimeState,
  compact = false,
): string {
  if (state.mode === "idle") return compact ? "R: idle" : "Responder: idle";
  if (state.mode === "off") {
    const pending = state.running + state.ready + state.delivered + state.archived;
    const body = pending > 0 ? `off · ${pending} pending` : "off";
    return compact ? `R: ${body}` : `Responder: ${body}`;
  }
  const parts = [`${state.running} running`];
  if (state.ready > 0) parts.push(`${state.ready} ready`);
  if (state.delivered > 0) parts.push(`${state.delivered} delivered`);
  const body = `listening · ${parts.join(" · ")}`;
  return compact ? `R: ${body}` : `Responder: ${body}`;
}

function clip(value: string, max: number): string {
  if (max <= 1) return "…";
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Collapse router/agent status noise into a single clean activity phrase. */
function formatActivity(
  activity: string | undefined,
  elapsedSec: number,
  maxLen: number,
): string {
  let base =
    (activity ?? "waiting for model").replace(/\s+/g, " ").trim() || "working";
  base = base.replace(/^[⏳·•\s]+/, "").replace(/\n/g, " ").trim();
  if (
    /\/output\b|open full output|Ctrl\+O or|full output saved|\.clai\/outputs/i.test(
      base,
    )
  ) {
    base = "tool finished";
  }
  if (base.length > maxLen) {
    const toolish = base.match(/^[\w.-]+/);
    base = toolish ? toolish[0]! : `${base.slice(0, Math.max(0, maxLen - 1))}…`;
  }
  if (/rate limited|retrying in/i.test(base) && !base.startsWith("⏳")) {
    base = `⏳ ${base}`;
  }
  return `${base} · ${elapsedSec}s`;
}

/**
 * Context chip tiers (session fill, not cumulative billing):
 *  - xs: bare count (`12.4k` / `~12.4k`)
 *  - sm+: `ctx:12.4k` / `ctx:~12.4k`
 */
function contextChipForDensity(
  usage: ContextUsageSnapshot | undefined,
  density: StatusDensity,
): string | undefined {
  if (!usage) return undefined;
  const chip = formatContextChip(usage, {
    compact: density === "xs" || density === "sm" || density === "md",
  });
  if (density === "xs") {
    // Drop the `ctx:` prefix on the narrowest tier.
    return chip.replace(/^ctx:/i, "");
  }
  return chip;
}

function ContextChip(props: {
  chip: string;
  theme: Theme;
  exact: boolean;
}): ReactNode {
  const { chip, theme, exact } = props;
  return (
    <text
      selectable={false}
      content={chip}
      style={{
        fg: exact ? theme.cyan : theme.muted,
        attributes: exact ? TextAttributes.BOLD : TextAttributes.DIM,
        flexShrink: 0,
      }}
    />
  );
}

function sep(theme: Theme, tight = false): ReactNode {
  return (
    <text
      selectable={false}
      content={tight ? " │ " : " │ "}
      style={{ fg: theme.muted, flexShrink: 0 }}
    />
  );
}

/** Far-right amber remaining-line badges. */
function ScrollRemainderBadges(props: {
  theme: Theme;
  metrics: ScrollMetrics;
  compact?: boolean | undefined;
}): ReactNode {
  const { theme, metrics, compact = false } = props;
  if (metrics.linesAbove <= 0 && metrics.linesBelow <= 0) return null;
  return (
    <box style={{ flexDirection: "row", alignItems: "center", flexShrink: 0 }}>
      {metrics.linesAbove > 0 ? (
        <>
          <text selectable={false} content=" " />
          <text
            selectable={false}
            content={compact ? `▲${metrics.linesAbove}` : ` ▲ ${metrics.linesAbove} `}
            style={{
              fg: theme.white,
              bg: theme.queued,
              attributes: TextAttributes.BOLD,
            }}
          />
        </>
      ) : null}
      {metrics.linesBelow > 0 ? (
        <>
          <text selectable={false} content=" " />
          <text
            selectable={false}
            content={compact ? `▼${metrics.linesBelow}` : ` ▼ ${metrics.linesBelow} `}
            style={{
              fg: theme.white,
              bg: theme.queued,
              attributes: TextAttributes.BOLD,
            }}
          />
        </>
      ) : null}
    </box>
  );
}

/**
 * Compact chip that expands on hover.
 * Idle: short chord (`^T`). Hover: full action (`show thinking`).
 * `accent`: cyan emphasis for primary actions (Esc · cancel while running).
 */
function ClickableHint(props: {
  /** Short label when not hovered (e.g. `^T`). */
  readonly short: string;
  /** Expanded label on hover (e.g. `show thinking`). Defaults to short. */
  readonly expand?: string | undefined;
  readonly active: boolean;
  readonly theme: Theme;
  readonly onClick?: (() => void) | undefined;
  /** Cyan/bold when idle — used for cancel while agent is running. */
  readonly accent?: boolean | undefined;
  /** Reserve the widest label so hover never reflows neighbours. */
  readonly fixedWidth?: boolean | undefined;
}): ReactNode {
  const { short, expand, active, theme, onClick, accent = false, fixedWidth = false } = props;
  const [hovered, setHovered] = useState(false);
  const full = expand ?? short;
  // Hover always shows the expanded phrase (with padding so the chip reads).
  const label = hovered ? ` ${full} ` : accent || fixedWidth ? ` ${short} ` : short;
  const content = fixedWidth
    ? label.padEnd(hintWidth(short, full), " ")
    : label;

  const fg = hovered
    ? theme.white
    : active || accent
      ? theme.cyan
      : theme.muted;
  const bg = hovered
    ? theme.selection
    : accent
      ? theme.chip
      : theme.background;
  const attributes =
    hovered || active || accent ? TextAttributes.BOLD : TextAttributes.NONE;

  return (
    <box
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick?.();
      }}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        flexShrink: 0,
        backgroundColor: bg,
      }}
    >
      <text
        selectable={false}
        content={content}
        style={{ fg, bg, attributes }}
      />
    </box>
  );
}

function ModeBadge(props: {
  mode: Mode;
  theme: Theme;
  /** When true, omit the trailing "MODE" word (saves ~5 cols). */
  short?: boolean | undefined;
}): ReactNode {
  const { mode, theme, short = false } = props;
  const label = modeIndicatorPresentation(mode).label;
  const bg =
    mode === "plan"
      ? theme.mode
      : mode === "ask"
        ? theme.chipIndigo
        : theme.chipTeal;
  return (
    <text
      selectable={false}
      content={short ? ` ${label} ` : ` ${label} MODE `}
      style={{
        fg: theme.white,
        bg,
        attributes: TextAttributes.BOLD,
        flexShrink: 0,
      }}
    />
  );
}

export function StatusLine(props: StatusLineProps): ReactNode {
  const {
    session,
    mode,
    theme,
    activity,
    width,
    hasActivePlan,
    planVisible,
    thinkingExpanded = false,
    outputExpanded = false,
    onToggleThinking,
    onToggleOutput,
    onTogglePlan,
    onJumpTop,
    onJumpBottom,
    onClearDraft,
    onOpenShortcuts,
    onCycleMode,
    onRequestCancel,
  } = props;
  const state = useSessionState(session);
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined);
  const [scrollMetrics, setScrollMetrics] = useState<ScrollMetrics>(
    EMPTY_SCROLL_METRICS,
  );

  const queued = state.queued.length;
  const density = statusDensityForWidth(width);
  const busy = state.running || state.compacting;
  const showTasks = (hasActivePlan || planVisible) && density !== "xs";
  const shortMode = density === "xs" || density === "sm";

  useEffect(() => transcriptScrollPort.onMetrics(setScrollMetrics), []);

  useEffect(() => {
    if (!busy) {
      setFrame(0);
      setElapsed(0);
      setStartedAt(undefined);
      return;
    }
    const origin = Date.now();
    setStartedAt(origin);
    setElapsed(0);
    const spinner = setInterval(
      () => setFrame((current) => (current + 1) % SPINNER_FRAMES.length),
      100,
    );
    const clock = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - origin) / 1000)));
    }, 250);
    return () => {
      clearInterval(spinner);
      clearInterval(clock);
    };
  }, [busy, state.compacting, state.running]);

  useEffect(() => {
    if (!busy || startedAt === undefined) return;
    setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
  }, [busy, startedAt, activity]);

  const ctxChip = contextChipForDensity(state.contextUsage, density);
  const scrollCompact = density === "xs" || density === "sm";
  const idleHints = idleHintIds(density);

  // ── Running / compacting ──────────────────────────────────────────────
  if (busy) {
    // Left:  MODE · spinner · activity·timer · Esc:cancel · ^H · queue
    // Right: tokens · ▲▼  (never sandwich Esc between tokens and scroll)
    const activityMax =
      density === "xs"
        ? 0
        : density === "sm"
          ? Math.max(8, width - 40)
          : Math.max(12, width - 52);
    const activityText =
      density === "xs"
        ? undefined
        : state.compacting
          ? `compacting · ${elapsed}s`
          : formatActivity(activity, elapsed, activityMax);

    return (
      <box
        style={{
          flexDirection: "row",
          width: "100%",
          height: 1,
          alignItems: "center",
          justifyContent: "space-between",
          backgroundColor: theme.background,
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        <box
          style={{
            flexDirection: "row",
            alignItems: "center",
            flexShrink: 1,
            minWidth: 0,
          }}
        >
          <ModeBadge mode={mode} theme={theme} short={shortMode} />
          <text selectable={false} content=" " />
          <text
            selectable={false}
            content={`${SPINNER_FRAMES[frame]} `}
            style={{ fg: theme.spinner, flexShrink: 0 }}
          />
          {activityText ? (
            <text
              selectable={false}
              content={clip(activityText, activityMax)}
              style={{ fg: theme.activity, flexShrink: 1 }}
            />
          ) : null}
          {density !== "xs" && !state.compacting ? (
            <>
              <text
                selectable={false}
                content=" "
                style={{ flexShrink: 0 }}
              />
              <ClickableHint
                short={busyCancelHint(density).short}
                expand={busyCancelHint(density).expand}
                active={false}
                theme={theme}
                accent
                fixedWidth
                // Same arm/confirm ladder as pressing Esc — a click must not
                // skip the confirmation the keyboard path requires.
                onClick={onRequestCancel}
              />
            </>
          ) : null}
          {showTasks ? (
            <>
              <text selectable={false} content=" " />
              <ClickableHint
                short={tasksToggleLabel(planVisible, density)}
                expand={planVisible ? "hide tasks" : "show tasks"}
                active={planVisible}
                theme={theme}
                onClick={onTogglePlan}
              />
            </>
          ) : null}
          {queued > 0 && density !== "xs" ? (
            <>
              <text selectable={false} content=" " />
              <text
                selectable={false}
                content={`${queued}q`}
                style={{ fg: theme.mode, flexShrink: 0 }}
              />
            </>
          ) : null}
        </box>
        <box
          style={{
            flexDirection: "row",
            alignItems: "center",
            flexShrink: 0,
            justifyContent: "flex-end",
          }}
        >
          {ctxChip ? (
            <>
              <ContextChip
                chip={ctxChip}
                theme={theme}
                exact={state.contextUsage?.exact === true}
              />
            </>
          ) : null}
          <ScrollRemainderBadges
            theme={theme}
            metrics={scrollMetrics}
            compact={scrollCompact}
          />
        </box>
      </box>
    );
  }

  // ── Idle ─────────────────────────────────────────────────────────────
  // Left: mode (+ optional center chips that may shrink)
  // Right: tokens + scroll (never shrink away)
  return (
    <box
      style={{
        flexDirection: "row",
        width: "100%",
        height: 1,
        alignItems: "center",
        justifyContent: "space-between",
        backgroundColor: theme.background,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <box
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexShrink: 1,
          minWidth: 0,
          overflow: "hidden",
        }}
      >
        <ModeBadge mode={mode} theme={theme} short={shortMode} />

        {/* Shift+Tab mode cycle hint (click to cycle ask → agent → plan) */}
        {density !== "xs" ? (
          <>
            <text selectable={false} content=" " />
            <ClickableHint
              short="⇧⇥"
              expand="cycle mode"
              active={false}
              theme={theme}
              onClick={onCycleMode}
            />
          </>
        ) : null}

        {/* Thin idle row — full binding list lives behind /shortcuts. */}
        {idleHints.includes("commands") ? (
          <>
            {sep(theme)}
            <text
              selectable={false}
              content={density === "lg" ? "/:commands" : "/"}
              style={{ fg: theme.muted, flexShrink: 0 }}
            />
          </>
        ) : null}
        {idleHints.includes("thinking") ? (
          <>
            {sep(theme)}
            <ClickableHint
              short="^T"
              expand={thinkingExpanded ? "hide thinking" : "show thinking"}
              active={thinkingExpanded}
              theme={theme}
              fixedWidth
              onClick={onToggleThinking}
            />
          </>
        ) : null}
        {idleHints.includes("output") ? (
          <>
            {sep(theme)}
            <ClickableHint
              short="^O"
              expand={outputExpanded ? "hide output" : "show output"}
              active={outputExpanded}
              theme={theme}
              fixedWidth
              onClick={onToggleOutput}
            />
          </>
        ) : null}
        {idleHints.includes("shortcuts") ? (
          <>
            {sep(theme)}
            <ClickableHint
              short="/shortcuts"
              expand="keyboard shortcuts"
              active={false}
              theme={theme}
              fixedWidth
              onClick={onOpenShortcuts}
            />
          </>
        ) : null}

        {showTasks ? (
          <>
            {sep(theme)}
            <ClickableHint
              short={tasksToggleLabel(planVisible, density)}
              expand={planVisible ? "hide tasks" : "show tasks"}
              active={planVisible}
              theme={theme}
              onClick={onTogglePlan}
            />
          </>
        ) : null}

        {queued > 0 && density !== "xs" ? (
          <>
            {sep(theme)}
            <text
              selectable={false}
              content={density === "sm" ? `${queued}q` : `${queued} queued`}
              style={{ fg: theme.mode, flexShrink: 0 }}
            />
          </>
        ) : null}
      </box>

      {/* Right rail: tokens + scroll — never overwritten by left chips */}
      <box
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexShrink: 0,
          justifyContent: "flex-end",
        }}
      >
        {ctxChip ? (
          <>
            <text selectable={false} content=" " />
            <ContextChip
              chip={ctxChip}
              theme={theme}
              exact={state.contextUsage?.exact === true}
            />
          </>
        ) : null}
        <ScrollRemainderBadges
          theme={theme}
          metrics={scrollMetrics}
          compact={scrollCompact}
        />
      </box>
    </box>
  );
}
