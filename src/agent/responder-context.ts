import type {
  BackgroundJob,
  ResponderNotification,
} from "../tools/jobs.js";

export const RESPONDER_CONTEXT_PREFIX = "RESPONDER / DURABLE JOB INBOX";

function oneLine(value: string, max = 120): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function receiptPath(notification: ResponderNotification): string {
  return (
    notification.stdoutArtifact.chunks.at(-1) ??
    notification.stdoutArtifact.path
  );
}

export function responderContextMessage(input: {
  running: readonly BackgroundJob[];
  pending: readonly ResponderNotification[];
}): string | undefined {
  if (input.running.length === 0 && input.pending.length === 0) return undefined;
  const lines = [RESPONDER_CONTEXT_PREFIX];
  if (input.running.length > 0) {
    lines.push("Active monitored jobs:");
    for (const job of input.running.slice(0, 10)) {
      lines.push(
        `- job=${job.id} pid=${job.pid ?? "?"} status=${job.status}` +
          `${job.taskId ? ` task=${job.taskId}` : ""}` +
          `${job.parentTaskId ? ` parent=${job.parentTaskId}` : ""}` +
          ` command=${oneLine(job.commandDisplay)}`,
      );
    }
  }
  if (input.pending.length > 0) {
    lines.push("Unacknowledged completions (durable until a completed turn persists analysis):");
    for (const notification of input.pending.slice(0, 12)) {
      lines.push(
        `- notification=${notification.id} job=${notification.jobId} status=${notification.status}` +
          ` exit=${notification.exitCode ?? "?"}` +
          `${notification.signal ? ` signal=${notification.signal}` : ""}` +
          `${notification.taskId ? ` task=${notification.taskId}` : ""}` +
          `${notification.parentTaskId ? ` parent=${notification.parentTaskId}` : ""}` +
          ` stdout=${receiptPath(notification)}` +
          ` bytes=${notification.stdoutArtifact.bytes}` +
          ` stderr=${notification.stderrArtifact.path}`,
      );
    }
  }
  lines.push(
    "FIRE AND CONTINUE: after launching, move to the next task immediately. Do NOT sleep, shell.jobs-poll, repeat shell.tail, or fs.read the job log to watch progress — this inbox delivers each completion to you automatically between turns.",
    "PARENT-DONE RULE: a parent task is done when its own non-Responder work is done; Responder-owned child subtasks advance from the real process lifecycle — never mark, block on, or wait for them.",
    "TASK SETTLEMENT: Responder-owned tasks reconcile automatically from the latest authoritative job result after analysis. If the artifacts are satisfactory, report the findings and continue or stop; do not call task.update for that child.",
    "ON COMPLETION (delivered here): read result lines from the artifact with a filter (grep the log / shell.tail byte window), never a full fs.read of a noisy scanner log; analyze; task.add new surfaces/follow-ups; then test them. Never launch a duplicate while a job is live.",
    "ONLY when every other task is finished and nothing else remains may you call shell.jobs ONCE. If jobs are still live, STOP and report what you did plus which jobs are running — do not enter a sleep/poll/tail loop.",
  );
  return lines.join("\n");
}

export function upsertResponderContextMessage(
  messages: Array<{ role: string; content: string }>,
  content: string | undefined,
): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (
      message.role === "system" &&
      message.content.startsWith(RESPONDER_CONTEXT_PREFIX)
    ) {
      messages.splice(index, 1);
    }
  }
  if (content) messages.push({ role: "system", content });
}
