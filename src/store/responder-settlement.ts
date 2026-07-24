import {
  isPlanSuccessful,
  isPlanTerminal,
  loadPlan,
  savePlan,
  type SessionPlan,
} from "./plan.js";
import type { BackgroundJob } from "../tools/jobs.js";

export type ResponderSettlementResult =
  | "applied"
  | "noop"
  | "missing"
  | "retry";

function artifactPath(job: BackgroundJob): string {
  return job.artifacts.stdout.chunks.at(-1) ?? job.stdoutArtifact;
}

function settlement(job: BackgroundJob): {
  state: "done" | "failed";
  note: string;
} {
  const state = job.status === "exited" && job.exitCode === 0 ? "done" : "failed";
  return {
    state,
    note:
      `job=${job.id} status=${job.status} exit=${job.exitCode ?? "?"}` +
      `${job.signal ? ` signal=${job.signal}` : ""} artifact=${artifactPath(job)}`,
  };
}

function updatePlanStatus(plan: SessionPlan): void {
  if (isPlanTerminal(plan)) {
    plan.status = isPlanSuccessful(plan) ? "completed" : "abandoned";
  } else if (plan.status !== "draft") {
    plan.status = "in_progress";
  }
}

export async function settleResponderJob(
  job: BackgroundJob,
): Promise<ResponderSettlementResult> {
  if (!job.responder || !["exited", "failed", "killed", "lost"].includes(job.status)) {
    return "noop";
  }

  let plan: SessionPlan | undefined;
  try {
    plan = await loadPlan(job.ownerSessionId);
  } catch {
    return "retry";
  }
  if (!plan) return "missing";

  const task = plan.tasks.find(
    (candidate) =>
      candidate.responderOwned &&
      (candidate.jobId === job.id || candidate.id === job.taskId),
  );
  if (!task) return "missing";

  const next = settlement(job);
  if (
    task.state === next.state &&
    task.note === next.note &&
    task.jobId === job.id
  ) {
    return "noop";
  }

  task.state = next.state;
  task.note = next.note;
  task.jobId = job.id;
  task.processId = job.pid;
  task.responderOwned = true;
  plan.version = (plan.version ?? 1) + 1;
  plan.updatedAt = new Date().toISOString();
  updatePlanStatus(plan);
  try {
    await savePlan(plan);
  } catch {
    return "retry";
  }
  return "applied";
}
