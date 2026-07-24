/**
 * Plan/task bookkeeping tools: success stays out of the main chat (Tasks pane
 * already shows the plan). Failures/blocked still surface so the user can act.
 */

export const QUIET_META_TOOL_NAMES = new Set([
  "plan.create",
  "task.add",
  "task.move",
  "task.read",
  "task.update",
]);

export function isQuietMetaTool(name: string): boolean {
  return name === "plan.create" || name.startsWith("task.");
}

/**
 * True when a quiet meta tool card should not appear in the chat transcript.
 * Every task.* call is pure bookkeeping surfaced in the Tasks pane, so it stays
 * out of chat whether it succeeds, fails, or is blocked. plan.create is hidden
 * on success but still surfaces on failure/blocked so the user knows no plan
 * landed.
 */
export function shouldHideQuietMetaToolInChat(
  name: string,
  status: string,
): boolean {
  if (!isQuietMetaTool(name)) return false;
  if (name.startsWith("task.")) return true;
  return status !== "failed" && status !== "blocked";
}
