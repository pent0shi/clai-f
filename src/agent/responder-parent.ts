import type { SessionPlan } from "../store/plan.js";
import type { ToolCall } from "../types.js";

// responder ownership is declared by the caller, never inferred from
// titles. `parentTaskId` names the foreground task that owns the delegation;
// the child task id is generated at launch and is not caller-supplied.

const RESPONDER_PARENT_ARG = "parentTaskId";

export interface ResponderParentAccepted {
  readonly ok: true;
  readonly taskId: string | undefined;
  readonly source: "declared" | "active-fallback" | "none";
}

export interface ResponderParentRejected {
  readonly ok: false;
  readonly reason: string;
}

export type ResponderParentResolution =
  | ResponderParentAccepted
  | ResponderParentRejected;

/** Read a declared responder parent from a tool call, if the model supplied one. */
export function readDeclaredParentTaskId(call: ToolCall): string | undefined {
  const raw = call.args?.[RESPONDER_PARENT_ARG];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Validate the declared parent against the live plan. Omission falls back to the
 * single active foreground task; ambiguity is reported instead of guessed.
 */
export function resolveResponderParent(input: {
  readonly plan: SessionPlan | undefined;
  readonly declared: string | undefined;
  readonly activeForegroundTaskIds: readonly string[];
}): ResponderParentResolution {
  const { plan, declared, activeForegroundTaskIds } = input;
  if (!declared) {
    if (activeForegroundTaskIds.length === 1) {
      return { ok: true, taskId: activeForegroundTaskIds[0]!, source: "active-fallback" };
    }
    return { ok: true, taskId: undefined, source: "none" };
  }
  if (!plan) {
    return {
      ok: false,
      reason: `${RESPONDER_PARENT_ARG} "${declared}" cannot be verified: this session has no plan yet. Omit it or create the plan first.`,
    };
  }
  const target = plan.tasks.find((task) => task.id === declared);
  if (!target) {
    const known = plan.tasks
      .filter((task) => !task.responderOwned)
      .map((task) => `${task.id}="${task.title}"`)
      .join("; ");
    return {
      ok: false,
      reason: `unknown ${RESPONDER_PARENT_ARG} "${declared}". Use a current foreground task id: ${known || "(none)"}.`,
    };
  }
  if (target.responderOwned) {
    return {
      ok: false,
      reason: `${RESPONDER_PARENT_ARG} "${declared}" is a Responder-owned child task. Name the foreground task that owns the work instead.`,
    };
  }
  if (target.state === "done" || target.state === "skipped") {
    return {
      ok: false,
      reason: `${RESPONDER_PARENT_ARG} "${declared}" is already ${target.state}. Delegate under the task that is actually doing this work, or add a new task for it first.`,
    };
  }
  return { ok: true, taskId: target.id, source: "declared" };
}


const RESPONDER_DELEGATING_TOOLS: ReadonlySet<string> = new Set([
  "shell.exec",
  "shell.start",
  "net.scan",
  "pentest.recon",
]);

/**
 * True when the call itself asks for Responder delegation. Only these
 * calls get a delegation record before launch; jobs that the registry promotes
 * to a durable job on its own are reconciled by the idempotent post-launch
 * upsert instead, because their delegation is not knowable in advance.
 */
export function isExplicitResponderDelegation(call: ToolCall): boolean {
  return (
    RESPONDER_DELEGATING_TOOLS.has(call.name) && call.args?.responder === true
  );
}

/** Stable, readable child-task title for a delegated command. */
export function delegationTaskTitle(call: ToolCall): string {
  const command =
    typeof call.args?.command === "string"
      ? call.args.command
      : typeof call.args?.target === "string"
        ? `${call.name} ${call.args.target}`
        : call.name;
  return `Responder · ${command.slice(0, 96)}`;
}
