/**
 * Soft plan-mode research reminders.
 *
 * Attached to existing tool-result payloads at milestones (15, 25, 35, …).
 * Informational only — never aborts the turn, never forbids more tools,
 * never injects as a separate user message (keeps tool-call pairs intact).
 */

/** First reminder after this many productive tool steps. */
export const PLAN_REMINDER_FIRST_STEP = 15;
/** Subsequent reminders every N productive steps. */
export const PLAN_REMINDER_STEP_INTERVAL = 10;

export interface PlanReminderGate {
  readonly isPlanMode: boolean;
  readonly planApproved: boolean;
  /** True when a draft plan with tasks already exists (stop nags after plan.create). */
  readonly hasDraftPlan: boolean;
  /** Productive tool-step index after recording this result (1-based). */
  readonly productiveStep: number;
  /** Milestones already fired this turn. */
  readonly alreadyRemindedAt: ReadonlySet<number>;
}

/** True when this productive step is a reminder milestone (15, 25, 35, …). */
export function isPlanReminderMilestone(step: number): boolean {
  if (!Number.isFinite(step) || step < PLAN_REMINDER_FIRST_STEP) return false;
  return (step - PLAN_REMINDER_FIRST_STEP) % PLAN_REMINDER_STEP_INTERVAL === 0;
}

/**
 * Whether to append a plan-mode research note to this tool result.
 * Call once per completed productive step; track `alreadyRemindedAt` in the turn.
 */
export function shouldAttachPlanModeReminder(opts: PlanReminderGate): boolean {
  if (!opts.isPlanMode) return false;
  if (opts.planApproved) return false;
  if (opts.hasDraftPlan) return false;
  if (!isPlanReminderMilestone(opts.productiveStep)) return false;
  if (opts.alreadyRemindedAt.has(opts.productiveStep)) return false;
  return true;
}

export interface PlanReminderTextOpts {
  readonly step: number;
  readonly kindHint?: "pentest" | "coding" | "general" | undefined;
}

/**
 * Short, calm note — not a stop order. Appended under the tool result body.
 * Kept well under ~400 chars to avoid context bloat.
 */
export function planModeResearchReminder(opts: PlanReminderTextOpts): string {
  const step = Math.max(0, Math.floor(opts.step));
  const pentest =
    opts.kindHint === "pentest"
      ? " Map surfaces/stack/interesting areas; put remaining auth’d tests, exploits, and report polish in tasks."
      : "";
  return (
    `\n\n[plan-mode note · step ${step}] ` +
    `Research may continue as long as useful. Plan mode’s deliverable is a comprehensive plan.create ` +
    `(goal, evidence-backed detail, ordered tasks for post-accept work). ` +
    `When you have enough context to design that roadmap, present the plan and await accept.` +
    pentest
  );
}

/** Append reminder suffix when the gate passes; otherwise return content unchanged. */
export function maybeAppendPlanModeReminder(
  toolContent: string,
  opts: PlanReminderGate & PlanReminderTextOpts,
): { content: string; reminded: boolean } {
  if (!shouldAttachPlanModeReminder(opts)) {
    return { content: toolContent, reminded: false };
  }
  const note = planModeResearchReminder({
    step: opts.productiveStep,
    kindHint: opts.kindHint,
  });
  return { content: toolContent + note, reminded: true };
}
