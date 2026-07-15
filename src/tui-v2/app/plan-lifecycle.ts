/**
 * Plan approval/implement/discard orchestration (PLAN-004, F-021/023, V2-070/073).
 *
 * Mirrors the classic TUI's `/implement` path: approve the persisted plan, flip
 * the session policy flag the agent gate reads, then run the implement prompt.
 * Kept out of `PlanController` (persistence only) and out of components.
 */

import type { SessionPlan } from "../../store/plan.js";
import type { AppServices } from "../bootstrap/composition-root.js";

/** Coding / build plans — scaffold + verify. */
export const IMPLEMENT_PROMPT_CODING =
  "I approve the plan. Execute it now in STRICT ORDER. " +
  "Start with the FIRST pending task that still needs work (skip only tasks already marked done). " +
  "For each task: call task.update {taskId, state:'in_progress'} → do the real work → VERIFY it succeeded → " +
  "call task.update {taskId, state:'done'}, then move to the NEXT task. " +
  "If a tool call FAILS, mark the task 'failed', fix the problem, and retry. Do NOT mark a task done when it failed. " +
  "Do NOT skip ahead to later tasks while earlier ones are still pending. " +
  "Build for real with fs.write / fs.writeMany when the plan requires files. " +
  "Run real commands when needed — do not claim anything ran without a successful tool call.";

/** Pentest / security plans — no local dev-server assumption. */
export const IMPLEMENT_PROMPT_PENTEST =
  "I approve the plan. Execute the engagement tasks in STRICT ORDER. " +
  "Start with the FIRST pending task; do NOT skip to later tasks while earlier ones are still pending. " +
  "For each task: task.update in_progress → do the recon/testing work with tools → task.update done (or failed with a note). " +
  "Prefer tool.batch / dns / http.fetch / net.scan for recon; continue when one lookup fails. " +
  "Do NOT start a local dev server, npm run dev, bun run, vite, next, or shell.start. " +
  "Do NOT list or read the clai workspace/package.json as a follow-up. Stay on the remote engagement target/scope. " +
  "When all tasks are done, write the report if needed and STOP with findings — no localhost step.";

export const IMPLEMENT_PROMPT = IMPLEMENT_PROMPT_CODING;

/**
 * When the user implements/discards from the plan pane, the chat plan-ready
 * confirm must not also run implement/discard (double-queue / double-discard).
 */
let planDecisionHandled = false;

function dismissPlanConfirmIfOpen(services: AppServices, asYes: boolean): void {
  const state = services.overlay.getState();
  if (state.kind === "confirm" && state.request.kind === "plan") {
    services.overlay.answerConfirm(asYes);
  }
}

export function buildImplementPrompt(plan: SessionPlan): string {
  if (plan.kind === "pentest") return IMPLEMENT_PROMPT_PENTEST;
  return IMPLEMENT_PROMPT_CODING;
}

export async function implementPlan(services: AppServices): Promise<void> {
  const plan = services.plan.current();
  if (!plan) return;
  if (plan.tasks.length > 0 && plan.tasks.every((t) => t.state === "done")) return;

  // Pane click wins: mark handled, close chat confirm so Y/N can't re-queue.
  planDecisionHandled = true;
  dismissPlanConfirmIfOpen(services, true);

  await services.plan.approve();
  services.session.setPlanApproved(true);

  const prompt = buildImplementPrompt(plan);
  if (services.session.getState().running) {
    services.session.enqueue(prompt);
  } else {
    await services.session.submit(prompt);
  }
}

export async function discardPlan(services: AppServices): Promise<void> {
  planDecisionHandled = true;
  dismissPlanConfirmIfOpen(services, false);
  await services.plan.discard();
  services.session.setPlanApproved(false);
}

/**
 * After a turn ends, if a draft plan is waiting, open the plan-ready confirm.
 * "P" views full plan detail via the suspended-over-confirm pager path.
 */
export async function promptPlanApprovalIfNeeded(services: AppServices): Promise<void> {
  if (services.session.isPlanApproved()) return;
  if (services.overlay.isOpen()) return;

  const plan = services.plan.current();
  if (!plan || plan.status !== "draft" || plan.tasks.length === 0) return;

  planDecisionHandled = false;

  const ok = await services.overlay.openConfirm(
    {
      kind: "plan",
      prompt: `Implement this plan now? "${plan.goal}" — ${plan.tasks.length} task(s). (Y to implement · N to discard)`,
    },
    async () => {
      const { formatPlanPagerDocument } = await import(
        "../rendering/plan-view.js"
      );
      services.overlay.openPager(
        `Plan · ${plan.goal}`,
        formatPlanPagerDocument(plan),
      );
    },
  );

  // Plan pane already implemented/discarded while this confirm was open.
  if (planDecisionHandled) return;

  if (ok) await implementPlan(services);
  else await discardPlan(services);
}
