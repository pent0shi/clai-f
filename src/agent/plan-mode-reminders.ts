/**
 * Soft plan-mode research reminders.
 *
 * Attached to existing tool-result payloads at milestones (15, 25, 35, …).
 * Informational only — never aborts the turn, never forbids more tools,
 * never injects as a separate user message (keeps tool-call pairs intact).
 * Host may toast "reminder sent" when `reminded` is true.
 */

/** First reminder after this many productive tool steps. */
export const PLAN_REMINDER_FIRST_STEP = 15;
/** Subsequent reminders every N productive steps. */
export const PLAN_REMINDER_STEP_INTERVAL = 10;

/** Short UI toast when a plan-mode research note was attached. */
export const PLAN_REMINDER_TOAST = "reminder sent · plan mode";

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
 * Calm note — not a stop order. Appended under the tool result body.
 * Explicitly tells the model to keep researching without hurrying.
 */
export function planModeResearchReminder(opts: PlanReminderTextOpts): string {
  const step = Math.max(0, Math.floor(opts.step));
  const domain =
    opts.kindHint === "pentest"
      ? "context, attack surface, stack/fingerprint, and juicy findings"
      : opts.kindHint === "coding"
        ? "workspace/stack context, constraints, and architecture facts"
        : "context and discovery that will improve the plan";

  return (
    `\n\n[plan-mode reminder · step ${step}] ` +
    `This is only a reminder — do NOT stop, limit, or cut research short because of this note. ` +
    `Continue and take as much time as you need. Do not miss important ${domain} by hurrying. ` +
    `Keep gathering until you honestly believe nothing material is left to discover for a strong plan. ` +
    `Plan mode’s deliverable is still one comprehensive plan.create (goal, evidence-backed detail, ordered tasks for post-accept work). ` +
    `When research is truly complete, present the plan and await accept — put remaining implement/test/exploit work in tasks.`
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
