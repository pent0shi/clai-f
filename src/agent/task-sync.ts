import type { ToolCall } from "../types.js";

// Soft, model-driven guards that keep task.update in lockstep with real work.
// These never hard-fail a turn: they surface one clear reminder and let the
// model confirm by re-issuing the identical call(s). No regex/state gates.

export type TaskUpdateState =
  | "pending"
  | "in_progress"
  | "done"
  | "failed"
  | "skipped";

export interface TaskUpdateIntent {
  readonly call: ToolCall;
  readonly taskId: string;
  readonly state: string;
}

export interface BatchTaskDescriptor {
  readonly taskId: string;
  readonly title: string;
  readonly targetState: string;
}

export interface DependencyReminderInput {
  readonly taskId: string;
  readonly title: string;
  readonly targetState: string;
  readonly blockers: readonly { readonly id: string; readonly title: string }[];
}

// States that represent forward progress and therefore must stay in sync with
// verified work. The canonical handoff — closing one task (done) while opening
// the next (in_progress) — is healthy sync and stays allowed. What the reminder
// catches is the risky "fire-and-forget" pattern: completing several tasks at
// once, or opening several at once, without verifying each in turn.
const ADVANCING_STATES: ReadonlySet<string> = new Set(["done", "in_progress"]);

const MAX_LISTED_TASKS = 12;

/** Read the taskId/state pair a task.update call is asserting (raw, unresolved). */
export function readTaskUpdateArgs(
  call: ToolCall,
): { taskId: string; state: string } | undefined {
  if (call.name !== "task.update") return undefined;
  const args = call.args ?? {};
  const taskId =
    typeof args.taskId === "string"
      ? args.taskId.trim()
      : typeof args.id === "string"
        ? args.id.trim()
        : "";
  const state = typeof args.state === "string" ? args.state.trim() : "";
  if (!taskId || !state) return undefined;
  return { taskId, state };
}

/** Distinct task ids advanced to done/in_progress across the given intents. */
export function distinctAdvancingTaskIds(
  intents: readonly TaskUpdateIntent[],
): string[] {
  const ids = new Set<string>();
  for (const intent of intents) {
    if (ADVANCING_STATES.has(intent.state)) ids.add(intent.taskId);
  }
  return [...ids];
}

/** Distinct task ids per advancing state in one message. */
export function advancingStateCounts(
  intents: readonly TaskUpdateIntent[],
): { done: number; inProgress: number } {
  const done = new Set<string>();
  const inProgress = new Set<string>();
  for (const intent of intents) {
    if (intent.state === "done") done.add(intent.taskId);
    else if (intent.state === "in_progress") inProgress.add(intent.taskId);
  }
  return { done: done.size, inProgress: inProgress.size };
}

/**
 * True only when a single message advances too many tasks to be a healthy
 * lockstep handoff. Closing one task and opening the next (≤1 done AND ≤1
 * in_progress) is allowed; completing several at once, or opening several at
 * once, is what we hold for verification.
 */
export function isSimultaneousTaskAdvance(
  intents: readonly TaskUpdateIntent[],
): boolean {
  const { done, inProgress } = advancingStateCounts(intents);
  return done > 1 || inProgress > 1;
}

/** Stable signature for a set of intents so an identical re-issue confirms it. */
export function batchUpdateSignature(
  intents: readonly TaskUpdateIntent[],
): string {
  const parts = intents
    .map((intent) => `${intent.taskId}:${intent.state}`)
    .sort();
  return `batch:${parts.join("|")}`;
}

/** Stable signature for opening a single task before its dependencies land. */
export function dependencySignature(
  taskId: string,
  state: string,
  blockerIds: readonly string[],
): string {
  return `dep:${taskId}:${state}:${[...blockerIds].sort().join(",")}`;
}

function formatTaskLine(descriptor: BatchTaskDescriptor, index: number): string {
  const title = descriptor.title.trim() || "(untitled task)";
  return `  ${index + 1}. [${descriptor.taskId}] ${title} → ${descriptor.targetState}`;
}

/**
 * Model-facing reminder for a simultaneous multi-task update. Instructs the
 * model to confirm by re-issuing the identical calls, or to sync one by one.
 */
export function buildMultiUpdateReminder(
  descriptors: readonly BatchTaskDescriptor[],
): string {
  const shown = descriptors.slice(0, MAX_LISTED_TASKS);
  const extra = descriptors.length - shown.length;
  const list = shown.map(formatTaskLine).join("\n");
  const overflow = extra > 0 ? `\n  …and ${extra} more` : "";
  return (
    `HELD — one message advances several tasks at once:\n` +
    `${list}${overflow}\n\n` +
    "Nothing was changed. Closing one task and opening the next in the same message is fine — " +
    "this hold only fires when you complete several tasks at once or start several at once. " +
    "That is only valid when EVERY one is truly finished (or truly started) and you have already read the tool results proving it. " +
    "If you are certain all of these are complete and verified, re-issue these exact task.update calls again to CONFIRM and they will be applied. " +
    "If even one is not done, do NOT batch: work in sync — set one task in_progress, do its work, read and verify the results, mark it done, then open the next. One task at a time."
  );
}

/**
 * Model-facing reminder when a task is opened before its dependencies finish.
 * Confirmed by re-issuing the identical task.update.
 */
export function buildDependencyReminder(input: DependencyReminderInput): string {
  const title = input.title.trim() || "(untitled task)";
  const blockers = input.blockers
    .map((blocker) => `[${blocker.id}] ${blocker.title.trim() || "(untitled)"}`)
    .join(", ");
  return (
    `HELD — [${input.taskId}] "${title}" was set ${input.targetState}, ` +
    `but its prerequisite task(s) are not complete: ${blockers}. ` +
    "Nothing was changed. Normally you finish dependencies first so work stays in order. " +
    `If [${input.taskId}] genuinely does not depend on them or they are already effectively satisfied, ` +
    "re-issue this exact task.update to CONFIRM and it will be opened. " +
    "Otherwise complete the prerequisite(s) first (in_progress → verify → done), then open this task."
  );
}

/** Short, identifiable toast for a batched multi-task update. */
export function multiUpdateToast(count: number): string {
  return `${count} task updates batched · verify & sync one by one`;
}

/** Short, identifiable toast for opening a task before its dependencies. */
export function dependencyToast(taskId: string): string {
  return `[${taskId}] opened early · confirm or finish prerequisites first`;
}
