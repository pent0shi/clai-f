/**
 * Plan/task bookkeeping tools: success stays out of the main chat (Tasks pane
 * already shows the plan). Failures/blocked still surface so the user can act.
 */

export const QUIET_META_TOOL_NAMES = new Set([
  "plan.create",
  "task.update",
]);

export function isQuietMetaTool(name: string): boolean {
  return QUIET_META_TOOL_NAMES.has(name);
}

/** True when a quiet meta tool card should not appear in the chat transcript. */
export function shouldHideQuietMetaToolInChat(
  name: string,
  status: string,
): boolean {
  if (!isQuietMetaTool(name)) return false;
  return status !== "failed" && status !== "blocked";
}
