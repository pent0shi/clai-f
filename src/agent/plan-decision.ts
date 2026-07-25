import { input, select } from "@inquirer/prompts";
import chalk from "chalk";
import type { SessionPlan } from "../store/plan.js";
import { deletePlan, mutatePlan } from "../store/plan.js";
import { renderPlanDocument } from "../ui/plan-pane.js";
import { openPager } from "../ui/output-pane.js";
import { restoreInteractiveStdin } from "./confirm-port.js";

export type PlanDecision = "accept" | "discard" | "view" | "suggest";

export const IMPLEMENT_DIRECTIVE =
  "Plan approved. Execute it. " +
  "Work through pending tasks in dependency order. For each: mark in_progress → do real work → verify → mark done (or failed and recover). " +
  "Skip tasks already done. Adapt if reality differs from the plan; update the plan if scope grows. " +
  "Do not claim done without tool evidence. Deliver the user's success condition, not only the checklist. " +
  "For local apps: shell.start, leave the server running, report URL + port + job id.";

/** User feedback → plan mode revision turn (shared classic TUI + v2). */
export function buildPlanRevisionPrompt(
  feedback: string,
  opts?: { planVersion?: number | undefined },
): string {
  const version = opts?.planVersion ?? 1;
  const text = feedback.trim();
  return (
    `Plan revision request from the user (plan mode). Current plan version: ${version}. ` +
    "This is still a DRAFT awaiting accept — rewrite decisively. " +
    "Emit ONE plan.create with the COMPLETE intended goal, detail, and ordered tasks (full checklist, not a partial delta). " +
    "Omit obsolete tasks entirely (e.g. drop Prisma/JWT/API when the user wants frontend-only). " +
    "Reuse a prior task title only when that step still has the same intent (so ids can stay stable); otherwise use a clear new title. " +
    "Pick one coherent interpretation of the feedback and apply it — do not monologue long chains of alternatives. " +
    "If a foundational choice is truly ambiguous, ask ONE short clarifying question instead of plan.create. " +
    "Do not implement yet. After plan.create, STOP for accept / suggest / discard. " +
    `User feedback:\n${text}`
  );
}

/**
 * Plan-mode gather-only should block project mutation only while the plan is
 * still awaiting accept. Once approved, mutates must run even if mode string
 * briefly lags behind (defense in depth for implement).
 */
export function shouldBlockPlanModeMutate(
  isPlanMode: boolean,
  planApproved: boolean,
): boolean {
  return isPlanMode && !planApproved;
}

export async function promptPlanDecision(): Promise<PlanDecision> {
  try {
    const choice = await select({
      message: chalk.cyan("  plan ready — what next?"),
      choices: [
        { name: "Accept — switch to agent and implement", value: "accept" as const },
        { name: "Suggest changes — type feedback to revise", value: "suggest" as const },
        { name: "View full plan", value: "view" as const },
        { name: "Discard plan", value: "discard" as const },
      ],
      default: "accept",
    });
    return choice;
  } finally {
    restoreInteractiveStdin();
  }
}

export async function promptPlanSuggestion(): Promise<string> {
  try {
    return (
      await input({
        message: chalk.cyan("  plan changes (what should change?):"),
      })
    ).trim();
  } finally {
    restoreInteractiveStdin();
  }
}

export async function handleDraftPlanDecision(opts: {
  plan: SessionPlan;
  sessionId: string;
  setModeAgent: () => void;
  planApproved: { value: boolean };
}): Promise<
  | { action: "implement"; line: string }
  | { action: "suggest"; line: string }
  | { action: "discard" }
  | { action: "none" }
> {
  let plan = opts.plan;
  while (true) {
    const decision = await promptPlanDecision();
    if (decision === "view") {
      if (process.stdout.isTTY && process.stdin.isTTY) {
        await openPager({
          title: `plan · ${plan.goal}`,
          body: renderPlanDocument(plan),
        });
      } else {
        console.log(renderPlanDocument(plan));
      }
      continue;
    }
    if (decision === "discard") {
      await deletePlan(opts.sessionId).catch(() => undefined);
      opts.planApproved.value = false;
      console.log(
        chalk.yellow(`  ✗ plan discarded — "${plan.goal}"`) +
          chalk.dim("\n  later messages are independent of it.\n"),
      );
      return { action: "discard" };
    }
    if (decision === "suggest") {
      const feedback = await promptPlanSuggestion();
      if (!feedback) {
        console.log(chalk.dim("  no changes entered — plan unchanged"));
        continue;
      }
      return {
        action: "suggest",
        line: buildPlanRevisionPrompt(feedback, {
          planVersion: plan.version,
        }),
      };
    }
    // accept
    plan.status = "approved";
    // Status-only transition on fresh state.
    await mutatePlan(plan.sessionId, (draft) => {
      if (draft.status === "approved") return false;
      draft.status = "approved";
      return true;
    }).catch(() => undefined);
    opts.planApproved.value = true;
    opts.setModeAgent();
    console.log(
      chalk.cyan("  ✦ plan accepted — switching to agent mode to execute\n"),
    );
    return { action: "implement", line: IMPLEMENT_DIRECTIVE };
  }
}
