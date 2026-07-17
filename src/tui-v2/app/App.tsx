/** @jsxImportSource @opentui/react */
/**
 * Responsive v2 shell (V2-032, Phase 7 plan/overlay host).
 *
 * Legacy-style layout: scrollable transcript (intro card + messages), optional
 * plan, completion menu + composer at the bottom, OverlayHost for pickers.
 *
 * Confirm/secret dock above the composer (in-flow). Pickers, pager, and jobs
 * live in a full-bleed absolute host so they never reflow the intro card.
 * Plan split/overlay reserves chat width so the agent card stays intact.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { MouseEvent } from "@opentui/core";
import {
  COMPOSER_MAX_HEIGHT,
  MIN_CHAT_ROWS,
  computeLayout,
} from "../layout/compute-layout.js";
import { ComposerEditor } from "../composer/composer-editor.js";
import { maxComposerTextRows } from "../composer/composer-height.js";
import { TranscriptView } from "../components/transcript/transcript-view.js";
import { PlanView } from "../components/plan/plan-view.js";
import { OverlayHost } from "../components/overlay/overlay-host.js";
import { QueuePanel } from "../components/queue/queue-panel.js";
import { chordFromKeyEvent } from "../actions/chord-from-key.js";
import { usePlan } from "../state/use-plan.js";
import { useOverlayState } from "../state/use-overlay.js";
import { useTranscriptState } from "../state/use-transcript-store.js";
import { useSessionState } from "../state/use-session-state.js";
import { useServices, useTheme } from "./providers.js";
import { promptPlanApprovalIfNeeded } from "./plan-lifecycle.js";
import { StatusLine } from "../components/status/status-line.js";
import { ToastHost } from "../components/toast/toast-host.js";
import {
  paneSlideTop,
  paneSlideWidth,
} from "../components/plan/plan-pane-anim.js";
import { usePanePresence } from "../components/plan/use-pane-presence.js";
import { transcriptScrollPort } from "../components/transcript/transcript-scroll-port.js";
import { composerActionPort } from "../composer/composer-action-port.js";
import { formatShortcutsReference } from "../actions/format-shortcuts.js";
import { formatCommandHelpMarkdown } from "../rendering/format-help.js";
import { notify, notifyWarn } from "../notify.js";

const CTRL_C_QUIT_WINDOW_MS = 1500;

/** Floating plan panel width — kept in sync with the overlay box style. */
function planOverlayWidth(termWidth: number): number {
  return Math.min(52, Math.max(34, Math.floor(termWidth * 0.4)));
}

export function App(): ReactNode {
  const { width, height } = useTerminalDimensions();
  const services = useServices();
  const theme = useTheme();
  const [focusContext, setFocusContext] = useState(services.focus.activeContext());
  /** User / auto request to show the task pane. */
  const [planVisible, setPlanVisible] = useState(false);
  const plan = usePlan(services.plan);
  const overlay = useOverlayState(services.overlay);
  const transcript = useTranscriptState(services.transcript);
  const lastCtrlC = useRef(0);
  const seenPlanKey = useRef<string | undefined>(undefined);
  /** Seed the composer when the user clicks Edit on a queued prompt. */
  const [composerSeed, setComposerSeed] = useState<
    { token: number; text: string } | undefined
  >(undefined);

  // Smooth enter/exit (~120ms in / ~100ms out); stays mounted through exit.
  const panePresence = usePanePresence(planVisible);
  /** Layout + focus treat the pane as present until exit finishes. */
  const planPresent = panePresence.mounted;

  useEffect(() => services.focus.onChange(setFocusContext), [services.focus]);

  useEffect(() => {
    return services.session.onTurnEnd((result) => {
      if (result.status === "completed") void promptPlanApprovalIfNeeded(services);
      // Drain "send now" priority + remaining queue after every settled turn
      // (including abort). Without this, queued prompts never auto-ran in v2.
      void services.session.continueQueue();
    });
  }, [services]);

  useEffect(() => {
    if (!plan) {
      seenPlanKey.current = undefined;
      setPlanVisible(false);
      return;
    }
    const key = `${plan.sessionId}:${plan.updatedAt}`;
    if (seenPlanKey.current === key) return;
    seenPlanKey.current = key;
    setPlanVisible(true);
  }, [plan]);

  // Reserve split/overlay space while the pane is mounted (incl. exit anim).
  const layout = computeLayout({
    columns: width,
    rows: height,
    planVisible: planPresent,
    splitEnabled: layoutSupportsSplit(width),
  });

  // Budget for multi-line input growth (Shift+Enter / wrap). Layout still
  // prefers a single idle row; the editor expands within this cap.
  const composerMaxTextRows = maxComposerTextRows({
    terminalRows: height,
    statusHeight: layout.status.height,
    minChatRows: MIN_CHAT_ROWS,
    maxCap: COMPOSER_MAX_HEIGHT,
  });

  const session = useSessionState(services.session);
  const horizontalPadding = width >= 56 ? 2 : width >= 28 ? 1 : 0;
  const completionRows = Math.max(6, Math.min(12, Math.floor(height / 3)));

  // Chat pane column budget (inside padded shell). Plan split and floating
  // overlay both shrink this so the intro card + messages reflow cleanly
  // instead of overflowing mid-border under Ctrl+H.
  const contentInnerWidth = Math.max(10, width - horizontalPadding * 2);
  // Breathing room between chat text and the plan/task pane border.
  const planChatGap =
    planPresent && layout.plan.placement === "split"
      ? 2
      : planPresent && layout.plan.placement === "overlay"
        ? 2
        : 0;
  // Split width tracks progress so the pane grows/shrinks with the animation.
  const splitPlanW =
    planPresent && layout.plan.placement === "split"
      ? paneSlideWidth(panePresence.progress, layout.plan.width)
      : 0;
  // Overlay keeps full horizontal reserve (motion is vertical slide from top).
  const overlayPlanW =
    planPresent && layout.plan.placement === "overlay"
      ? planOverlayWidth(width) + planChatGap
      : 0;
  const chatContentWidth = Math.max(24, contentInnerWidth - splitPlanW - overlayPlanW);

  useKeyboard((key) => {
    if (key.eventType === "release") return;

    const chord = chordFromKeyEvent(key);

    // Password / confirm overlays used to swallow ALL global keys (early return
    // when overlay !== none). Then Ctrl+C only aborted via SIGINT and left the
    // secret UI stuck; Esc never reached App if the hidden input lost focus.
    // Still allow cancel/interrupt while a blocking prompt is open.
    if (overlay.kind === "secret" || overlay.kind === "confirm" || overlay.kind === "scope-editor") {
      if (chord === "escape" || chord === "ctrl+c") {
        key.preventDefault();
        const dismissed = services.overlay.cancelBlockingPrompt();
        if (chord === "ctrl+c") {
          const now = Date.now();
          const doublePress =
            lastCtrlC.current > 0 &&
            now - lastCtrlC.current < CTRL_C_QUIT_WINDOW_MS;
          if (services.session.getState().running) {
            services.session.abort();
          }
          if (doublePress) {
            services.requestExit();
            return;
          }
          lastCtrlC.current = now;
          notifyWarn(
            services,
            dismissed
              ? "Prompt cancelled · Ctrl+C again to exit"
              : "Turn aborted · Ctrl+C again to exit",
            { key: "interrupt", durationMs: 2200 },
          );
          return;
        }
        // Esc: dismiss prompt + abort turn; never quit.
        if (services.session.getState().running) {
          services.session.abort();
        }
        return;
      }
      // Typing / y-n / etc. handled by the modal's own useKeyboard.
      return;
    }

    if (overlay.kind !== "none") return;

    // Tab belongs to the completion menu while the composer is active. The
    // previous global focus binding consumed it first, which made `/mod` + Tab
    // appear to freeze the input instead of completing `/model`.
    if (focusContext === "composer" && chord === "tab") return;
    const action = services.router.resolve(chord, focusContext);
    if (!action) return;
    switch (action) {
      case "app.cancel":
        // Esc: abort a live turn only. Never exit — multi-Esc used to quit
        // because it shared the double-press path with Ctrl+C.
        key.preventDefault();
        services.overlay.cancelBlockingPrompt();
        if (services.session.getState().running) {
          services.session.abort();
        }
        break;
      case "app.interrupt": {
        // Ctrl+C: first press aborts if running (and arms quit); second press
        // within the window exits. Idle: first arms, second exits.
        // Important: while a hung tool is still "running", a second Ctrl+C
        // must still exit — otherwise cancel that never settles traps the UI.
        key.preventDefault();
        services.overlay.cancelBlockingPrompt();
        const now = Date.now();
        const doublePress =
          lastCtrlC.current > 0 &&
          now - lastCtrlC.current < CTRL_C_QUIT_WINDOW_MS;
        if (services.session.getState().running) {
          services.session.abort();
          if (doublePress) {
            services.requestExit();
            break;
          }
          lastCtrlC.current = now;
          notifyWarn(services, "Turn aborted · Ctrl+C again to exit", {
            key: "interrupt",
            durationMs: 2200,
          });
          break;
        }
        if (doublePress) {
          services.requestExit();
        } else {
          lastCtrlC.current = now;
          notify(services, "Ctrl+C again to exit", {
            key: "interrupt",
            durationMs: 2200,
          });
        }
        break;
      }
      case "app.quit":
        key.preventDefault();
        services.requestExit();
        break;
      case "app.toggle-plan":
        key.preventDefault();
        toggleTasksPane();
        break;
      case "app.jobs":
        key.preventDefault();
        services.overlay.openJobs();
        notify(services, "Jobs panel", { key: "jobs", durationMs: 1200 });
        break;
      case "app.help":
        key.preventDefault();
        services.overlay.openPager(
          "Commands",
          formatCommandHelpMarkdown(services.commands.help()),
          undefined,
          undefined,
          "force",
        );
        notify(services, "Commands · /help", { key: "help", durationMs: 1200 });
        break;
      case "plan.toggle-detail":
        key.preventDefault();
        // Ctrl+P: full plan detail pager. Reload from disk if memory is empty
        // (e.g. after /history resume before the plan controller was refreshed).
        void (async () => {
          let live = services.plan.current() ?? plan;
          if (!live) {
            live = await services.plan
              .load(services.session.sessionId)
              .catch(() => undefined);
          }
          if (live) {
            const { formatPlanPagerDocument } = await import(
              "../rendering/plan-view.js"
            );
            services.overlay.openPager(
              `Plan · ${live.goal}`,
              formatPlanPagerDocument(live),
              undefined,
              undefined,
              "force",
            );
            notify(services, "Plan detail", { key: "plan-detail", durationMs: 1200 });
          } else {
            notify(services, "No active plan yet", {
              key: "plan-detail",
              level: "warn",
            });
          }
        })();
        break;
      case "transcript.toggle-thinking":
        key.preventDefault();
        toggleThinking();
        break;
      case "transcript.toggle-output":
        key.preventDefault();
        toggleOutput();
        break;
      case "transcript.top":
        // ^U on transcript/pager focus (not global — composer owns Ctrl+U for
        // line-delete / empty-draft jump in composer-editor).
        key.preventDefault();
        jumpChatTop();
        break;
      case "transcript.bottom":
        // ^D — absolute end of the chat (works from composer).
        key.preventDefault();
        jumpChatBottom();
        break;
      case "transcript.page-up":
        key.preventDefault();
        transcriptScrollPort.scrollBy(-12);
        break;
      case "transcript.page-down":
        key.preventDefault();
        transcriptScrollPort.scrollBy(12);
        break;
      case "focus.next-region": {
        key.preventDefault();
        const regions =
          planPresent && layout.plan.placement !== "hidden"
            ? (["composer", "transcript", "plan"] as const)
            : (["composer", "transcript"] as const);
        services.focus.cycleRegion([...regions]);
        const next = services.focus.activeContext();
        notify(services, `Focus · ${next}`, {
          key: "focus",
          durationMs: 1100,
        });
        break;
      }
      default:
        break;
    }
  });

  const planPaneWidth =
    layout.plan.placement === "split"
      ? Math.max(splitPlanW, 1)
      : planOverlayWidth(width);
  const planPanel =
    planPresent && layout.plan.placement !== "hidden" ? (
      <PlanView
        theme={theme}
        plan={plan}
        services={services}
        width={planPaneWidth}
      />
    ) : null;

  const overlayRestTop = Math.max(1, Math.floor(height * 0.08));
  const overlayPaneHeight = Math.max(12, Math.floor(height * 0.72));
  const overlayAnimTop = paneSlideTop(
    panePresence.progress,
    overlayRestTop,
    overlayPaneHeight,
  );

  // Composer only owns the keyboard when the focus region is composer.
  // Clicking the transcript leaves focus there so ↑/↓ scroll the chat instead
  // of walking prompt history in the textarea.
  const composerFocused = overlay.kind === "none" && focusContext === "composer";

  /**
   * Wheel outside focused regions that own their own scroll (plan pane)
   * scrolls the chat. Composer forwards wheel to chat itself (classic).
   */
  function onAppWheel(event: MouseEvent): void {
    if (!event.scroll || overlay.kind !== "none") return;
    // Plan owns its ScrollBox — never steal its wheel into chat.
    if (focusContext === "plan") return;
    event.preventDefault();
    event.stopPropagation();
    services.focus.focusRegion("transcript");
    const { direction, delta } = event.scroll;
    const step = Math.max(1, delta || 1) * 3;
    const dy =
      direction === "up" ? -step : direction === "down" ? step : 0;
    if (dy !== 0) transcriptScrollPort.scrollBy(dy);
  }

  /** Plan pane wheel: claim focus + stop bubble so chat does not scroll too. */
  function onPlanWheel(event: MouseEvent): void {
    if (!event.scroll) return;
    event.stopPropagation();
    services.focus.focusRegion("plan");
    // Native ScrollBox under PlanView handles the actual list motion.
  }

  /** Keep chat edge-scrolling while drag-selecting even over composer/status. */
  function onAppMouseDrag(event: MouseEvent): void {
    if (!event.isDragging || overlay.kind !== "none") return;
    transcriptScrollPort.updateAutoScroll(event.x, event.y);
  }

  function onAppMouseUp(): void {
    transcriptScrollPort.stopAutoScroll();
  }

  function toggleThinking(): void {
    services.transcript.toggleThinkingGlobal();
    const on = services.transcript.getState().expandThinkingGlobal;
    notify(services, on ? "Thinking expanded · ^T" : "Thinking collapsed · ^T", {
      key: "thinking",
      durationMs: 1500,
    });
  }

  function toggleOutput(): void {
    services.transcript.toggleOutputGlobal();
    const on = services.transcript.getState().expandOutputGlobal;
    notify(services, on ? "Tool output expanded · ^O" : "Tool output collapsed · ^O", {
      key: "output",
      durationMs: 1500,
    });
  }

  function jumpChatTop(): void {
    transcriptScrollPort.scrollToTop();
    notify(services, "Chat · top · ^U", { key: "scroll", durationMs: 1200 });
  }

  function jumpChatBottom(): void {
    transcriptScrollPort.scrollToBottom();
    notify(services, "Chat · end · ^D", { key: "scroll", durationMs: 1200 });
  }

  function clearDraft(): void {
    composerActionPort.clear();
    notify(services, "Draft cleared · ^X", { key: "draft", durationMs: 1400 });
  }

  function openShortcutsPager(): void {
    services.overlay.openPager(
      "Keyboard shortcuts",
      formatShortcutsReference(),
      undefined,
      undefined,
      "force",
    );
    notify(services, "Keyboard shortcuts", { key: "help", durationMs: 1200 });
  }

  function toggleTasksPane(): void {
    // Same path as Ctrl+H — opening loads the active plan from disk when the
    // in-memory projection is empty.
    setPlanVisible((visible) => {
      const next = !visible;
      if (next && !services.plan.current()) {
        void services.plan
          .load(services.session.sessionId)
          .then((loaded) => {
            if (!loaded) {
              notify(services, "No tasks for this session yet", {
                key: "tasks",
                level: "warn",
              });
            }
          })
          .catch(() => undefined);
      }
      notify(
        services,
        next ? "Tasks shown · ^H" : "Tasks hidden · ^H",
        { key: "tasks", durationMs: 1400 },
      );
      return next;
    });
  }

  return (
    <box
      style={{
        width,
        height,
        flexDirection: "column",
        backgroundColor: theme.background,
        position: "relative",
      }}
      onMouseScroll={onAppWheel}
      onMouseDrag={onAppMouseDrag}
      onMouseUp={onAppMouseUp}
      onMouseDragEnd={onAppMouseUp}
    >
      {/* Padded content column — overlays are siblings outside this box so
          absolute full-bleed hosts never inherit padding and clip chrome. */}
      <box
        style={{
          flexGrow: 1,
          flexDirection: "column",
          width: "100%",
          height: "100%",
          paddingLeft: horizontalPadding,
          paddingRight: horizontalPadding,
        }}
      >
        <box style={{ flexGrow: 1, flexDirection: "row", width: "100%" }}>
          <box
            style={{
              // Explicit width so OpenTUI does not let the plan panel steal
              // columns from under a flex-grown intro card mid-frame.
              width: chatContentWidth,
              flexGrow: layout.plan.placement === "split" || overlayPlanW > 0 ? 0 : 1,
              flexShrink: 1,
              backgroundColor: theme.background,
              // Keep transcript text off the plan border when the task pane is open.
              paddingRight: planChatGap > 0 ? planChatGap : 0,
            }}
          >
            <TranscriptView
              services={services}
              theme={theme}
              focused={focusContext === "transcript" && overlay.kind === "none"}
              contentWidth={Math.max(20, chatContentWidth - planChatGap)}
            />
          </box>
          {layout.plan.placement === "split" && planPresent && splitPlanW > 0 ? (
            <box
              title=" Tasks "
              titleColor={theme.inputBorder}
              border
              borderStyle="rounded"
              style={{
                width: splitPlanW,
                height: "100%",
                flexShrink: 0,
                // Same electric aqua as the composer input border.
                borderColor: theme.inputBorder,
                backgroundColor: theme.statusBackground,
              }}
              onMouseDown={() => services.focus.focusRegion("plan")}
              onMouseScroll={onPlanWheel}
            >
              {planPanel}
            </box>
          ) : null}
        </box>

        {/* Queued prompts (send after current turn; click Send now / Edit). */}
        <QueuePanel
          services={services}
          theme={theme}
          width={contentInnerWidth}
          onEdit={(text) => {
            setComposerSeed({ token: Date.now(), text });
            services.focus.focusRegion("composer");
          }}
        />

        {/* Confirm / secret docked above the input (no full-screen black wash). */}
        <OverlayHost
          services={services}
          theme={theme}
          width={contentInnerWidth}
          height={height}
          docked
        />

        {/* Completion menu + input live here; menu grows upward into flex space. */}
        <ComposerEditor
          services={services}
          theme={theme}
          width={contentInnerWidth}
          height={composerMaxTextRows}
          focused={composerFocused}
          maxSuggestions={completionRows}
          running={session.running}
          seedDraft={composerSeed}
        />

        <StatusLine
          session={services.session}
          mode={session.mode}
          theme={theme}
          activity={transcript.runningStatus}
          width={contentInnerWidth}
          hasActivePlan={Boolean(plan)}
          planVisible={planVisible}
          thinkingExpanded={transcript.expandThinkingGlobal}
          outputExpanded={transcript.expandOutputGlobal}
          onToggleThinking={toggleThinking}
          onToggleOutput={toggleOutput}
          onTogglePlan={toggleTasksPane}
          onJumpTop={jumpChatTop}
          onJumpBottom={jumpChatBottom}
          onClearDraft={clearDraft}
          onOpenShortcuts={openShortcutsPager}
        />
      </box>

      {layout.plan.placement === "overlay" && planPresent ? (
        <box
          title=" Tasks "
          titleColor={theme.inputBorder}
          border
          borderStyle="rounded"
          style={{
            position: "absolute",
            // Slide in from above (same ease as toasts), hold, slide out.
            top: overlayAnimTop,
            // Sit flush with the right edge of the padded content column
            // so the plan pane aligns with where the input box ends.
            right: horizontalPadding,
            width: planOverlayWidth(width),
            height: overlayPaneHeight,
            // Same electric aqua as the composer input border.
            borderColor: theme.inputBorder,
            backgroundColor: theme.statusBackground,
            zIndex: 50,
          }}
          onMouseDown={() => services.focus.focusRegion("plan")}
          onMouseScroll={onPlanWheel}
        >
          {planPanel}
        </box>
      ) : null}

      {/* Full-bleed overlay host (pickers, Ctrl+P pager, prompt actions, …).
          Sibling of the padded column so open/close never reflows the intro. */}
      <OverlayHost services={services} theme={theme} width={width} height={height} />

      {/* Right-edge copy/status toasts — outside padded column so they never
          reflow chat; z-index above plan overlay, below blocking overlays. */}
      <ToastHost
        toast={services.toast}
        theme={theme}
        termWidth={width}
        termHeight={height}
      />
    </box>
  );
}

function layoutSupportsSplit(columns: number): boolean {
  return columns >= 120;
}
