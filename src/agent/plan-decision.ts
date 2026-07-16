import { input, select } from "@inquirer/prompts";
import chalk from "chalk";
import type { SessionPlan } from "../store/plan.js";
import { deletePlan, savePlan } from "../store/plan.js";
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
    "Treat task ids, dependencies, resource locks, and completed states as structured authority; preserve stable ids. " +
    "If the feedback is clear and possible without ambiguity, apply the smallest add/edit/remove/supersede/split/merge/dependency change that satisfies it, then persist one revised plan.create snapshot and stop for the next user decision. " +
    "If the feedback is unclear or has multiple valid interpretations, ask concise clarifying questions instead of guessing — do not implement yet. " +
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
    plan.version = (plan.version ?? 1) + 1;
    await savePlan(plan).catch(() => undefined);
    opts.planApproved.value = true;
    opts.setModeAgent();
    console.log(
      chalk.cyan("  ✦ plan accepted — switching to agent mode to execute\n"),
    );
    return { action: "implement", line: IMPLEMENT_DIRECTIVE };
  }
}
