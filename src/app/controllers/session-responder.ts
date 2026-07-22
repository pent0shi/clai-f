import { isPlanSuccessful, isPlanTerminal } from "../../store/plan.js";
import { asPlanId, type AnyAppEvent } from "../events/app-event.js";
import type { EventSequencer } from "../events/sequencer.js";
import type {
  JobManagerChange,
  JobsPort,
  ResponderNotification,
} from "../ports/jobs-port.js";
import type { PersistencePort } from "../ports/persistence-port.js";

interface ResponderTurnResult {
  readonly status: "completed" | "aborted" | "error";
}

interface SessionResponderDeps {
  readonly jobs: JobsPort;
  readonly persistence: PersistencePort;
  readonly sequencer: EventSequencer;
  readonly emit: (event: AnyAppEvent) => void;
  readonly sessionId: () => string;
  readonly isBusy: () => boolean;
  readonly hasQueuedWork: () => boolean;
  readonly continueQueue: () => Promise<void>;
  readonly runTurn: (prompt: string) => Promise<ResponderTurnResult>;
  readonly notifyState: () => void;
  readonly notifyDelivery?: ((summary: string) => void) | undefined;
}

export class SessionResponder {
  private generation = 0;
  private wakeRequested = false;
  private wakeDrain: Promise<void> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly analysisCompleted = new Set<string>();
  private readonly deliveryFailures = new Map<string, number>();
  private readonly settlementFailures = new Map<string, number>();
  private static readonly RETRY_MS = 750;
  private static readonly MAX_DELIVERY_ATTEMPTS = 3;
  private static readonly MAX_SETTLEMENT_ATTEMPTS = 8;

  constructor(private readonly deps: SessionResponderDeps) {}

  handleChange(change: JobManagerChange): void {
    this.deps.notifyState();
    if (change.type === "notification") this.scheduleWake();
  }

  rebind(): void {
    this.invalidateWake();
    this.scheduleWake();
  }

  invalidateWake(): void {
    this.generation += 1;
    this.wakeRequested = false;
    this.analysisCompleted.clear();
    this.deliveryFailures.clear();
    this.settlementFailures.clear();
    this.clearRetry();
  }

  scheduleWake(): void {
    this.wakeRequested = true;
    if (this.wakeDrain) return;
    const generation = this.generation;
    let drain: Promise<void>;
    drain = Promise.resolve()
      .then(() => this.drainWakes(generation))
      .catch(() => {
        this.wakeRequested = false;
        this.armRetry();
      })
      .finally(() => {
        if (this.wakeDrain !== drain) return;
        this.wakeDrain = undefined;
        if (this.wakeRequested) this.scheduleWake();
      });
    this.wakeDrain = drain;
  }

  private async drainWakes(generation: number): Promise<void> {
    while (generation === this.generation && this.wakeRequested) {
      this.wakeRequested = false;
      if (await this.runWake(generation)) {
        this.wakeRequested = false;
        return;
      }
    }
  }

  private taskSettlement(notification: ResponderNotification): {
    state: "done" | "failed";
    note: string;
    fingerprint: string;
  } {
    const job = this.deps.jobs.get(notification.jobId);
    const authoritativeJob =
      job && ["exited", "failed", "killed", "lost"].includes(job.status)
        ? job
        : undefined;
    const status = authoritativeJob?.status ?? notification.status;
    const exitCode = authoritativeJob?.exitCode ?? notification.exitCode;
    const signal = authoritativeJob?.signal ?? notification.signal;
    const artifact = authoritativeJob
      ? authoritativeJob.artifacts.stdout.chunks.at(-1) ??
        authoritativeJob.stdoutArtifact
      : notification.stdoutArtifact.chunks.at(-1) ??
        notification.stdoutArtifact.path;
    const state = status === "exited" && exitCode === 0 ? "done" : "failed";
    return {
      state,
      note:
        `job=${notification.jobId} status=${status} ` +
        `exit=${exitCode ?? "?"}` +
        `${signal ? ` signal=${signal}` : ""} ` +
        `artifact=${artifact}`,
      fingerprint: `${status}\0${exitCode ?? "?"}\0${signal ?? ""}\0${artifact}`,
    };
  }

  private async syncTask(notification: ResponderNotification): Promise<boolean> {
    if (notification.ownerSessionId !== this.deps.sessionId()) return true;
    let plan;
    try {
      plan = await this.deps.persistence.loadPlan(notification.ownerSessionId);
    } catch {
      return false;
    }
    if (!plan || this.deps.sessionId() !== notification.ownerSessionId) return true;
    const task = plan.tasks.find(
      (candidate) =>
        candidate.responderOwned && candidate.jobId === notification.jobId,
    );
    if (!task) return true;

    const job = this.deps.jobs.get(notification.jobId);
    if (
      job &&
      (job.taskId !== task.id ||
        (task.parentTaskId !== undefined &&
          job.parentTaskId !== task.parentTaskId))
    ) {
      const linked = this.deps.jobs.linkJob(notification.jobId, {
        taskId: task.id,
        ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
        responder: true,
        wakeOnCompletion: true,
      });
      if (!linked) return false;
    }

    const settlement = this.taskSettlement(notification);
    if (task.state === settlement.state && task.note === settlement.note) {
      return this.taskSettlement(notification).fingerprint === settlement.fingerprint;
    }
    task.state = settlement.state;
    task.note = settlement.note;
    plan.version = (plan.version ?? 1) + 1;
    plan.updatedAt = new Date().toISOString();
    if (isPlanTerminal(plan)) {
      plan.status = isPlanSuccessful(plan) ? "completed" : "abandoned";
    } else if (plan.status !== "draft") {
      plan.status = "in_progress";
    }
    try {
      await this.deps.persistence.savePlan(plan);
    } catch {
      return false;
    }
    if (this.taskSettlement(notification).fingerprint !== settlement.fingerprint) {
      return false;
    }
    if (this.deps.sessionId() !== notification.ownerSessionId) return true;
    this.deps.emit(
      this.deps.sequencer.build(
        "plan-updated",
        { planId: asPlanId(plan.sessionId), plan },
        undefined,
      ),
    );
    return true;
  }

  private async syncTasks(
    notifications: readonly ResponderNotification[],
    attempts: number,
  ): Promise<Set<string>> {
    const synced = new Set<string>();
    let remaining = [...notifications];
    for (let attempt = 0; attempt < attempts && remaining.length > 0; attempt += 1) {
      const failed: ResponderNotification[] = [];
      for (const notification of remaining) {
        if (await this.syncTask(notification)) synced.add(notification.id);
        else failed.push(notification);
      }
      remaining = failed;
      if (remaining.length > 0 && attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
    return synced;
  }

  private pending(sessionId: string): ResponderNotification[] {
    return this.deps.jobs
      .pendingNotifications(sessionId)
      .filter((notification) => notification.wakeOnCompletion);
  }

  private actionable(sessionId: string): ResponderNotification[] {
    return this.pending(sessionId).filter(
      (notification) =>
        !notification.analyzedAt &&
        !this.analysisCompleted.has(notification.id) &&
        (this.deliveryFailures.get(notification.id) ?? 0) <
          SessionResponder.MAX_DELIVERY_ATTEMPTS,
    );
  }

  private async settleAnalyzed(sessionId: string): Promise<boolean> {
    const analyzed = this.pending(sessionId).filter(
      (notification) =>
        Boolean(notification.analyzedAt) ||
        this.analysisCompleted.has(notification.id),
    );
    if (analyzed.length === 0) return false;
    const durable = analyzed.filter(
      (notification) =>
        Boolean(notification.analyzedAt) ||
        this.deps.jobs.markAnalyzed(notification.id),
    );
    const synced = await this.syncTasks(durable, 3);
    let retry = false;
    for (const notification of analyzed) {
      let settled = false;
      if (synced.has(notification.id)) {
        settled = this.deps.jobs.acknowledge(notification.id);
      }
      if (settled) {
        this.analysisCompleted.delete(notification.id);
        this.deliveryFailures.delete(notification.id);
        this.settlementFailures.delete(notification.id);
        continue;
      }
      const failures = (this.settlementFailures.get(notification.id) ?? 0) + 1;
      this.settlementFailures.set(notification.id, failures);
      if (failures < SessionResponder.MAX_SETTLEMENT_ATTEMPTS) retry = true;
    }
    return retry;
  }

  private async runWake(generation: number): Promise<boolean> {
    if (generation !== this.generation) return false;
    const sessionId = this.deps.sessionId();
    if (await this.settleAnalyzed(sessionId)) {
      this.armRetry();
      return true;
    }
    if (generation !== this.generation || sessionId !== this.deps.sessionId()) {
      return false;
    }

    const actionable = this.actionable(sessionId);
    if (actionable.length === 0) {
      this.clearRetry();
      return false;
    }
    if (this.deps.isBusy()) {
      this.armRetry();
      return true;
    }
    if (this.deps.hasQueuedWork()) {
      this.clearRetry();
      await this.deps.continueQueue();
      if (generation === this.generation && sessionId === this.deps.sessionId()) {
        this.wakeRequested = true;
      }
      return false;
    }

    await this.syncTasks(actionable, 1);
    if (
      generation !== this.generation ||
      sessionId !== this.deps.sessionId() ||
      this.deps.isBusy()
    ) {
      this.armRetry();
      return true;
    }

    const current = new Map(
      this.actionable(sessionId).map((notification) => [notification.id, notification]),
    );
    const delivered = actionable
      .map((notification) => current.get(notification.id))
      .filter((notification): notification is ResponderNotification => Boolean(notification))
      .filter((notification) => this.deps.jobs.markDelivered(notification.id));
    if (delivered.length === 0) {
      this.armRetry();
      return true;
    }

    this.clearRetry();
    this.deps.notifyDelivery?.(summarizeDelivery(delivered));
    const ids = delivered.map((notification) => notification.id).join(", ");
    let result: ResponderTurnResult;
    try {
      result = await this.deps.runTurn(
        `Responder completion ready (${ids}). Analyze the durable job artifacts now. ` +
          "Do not rerun completed work. Add evidence-driven follow-up tasks only when the result requires them. " +
          "Responder task settlement is automatic from the authoritative job result: if the artifacts are satisfactory, report the findings and continue or stop; do not call task.update for the Responder-owned task.",
      );
    } catch {
      result = { status: "error" };
    }
    if (result.status !== "completed") {
      let retry = false;
      for (const notification of delivered) {
        const failures = (this.deliveryFailures.get(notification.id) ?? 0) + 1;
        this.deliveryFailures.set(notification.id, failures);
        if (failures < SessionResponder.MAX_DELIVERY_ATTEMPTS) retry = true;
      }
      if (retry) this.armRetry();
      return retry;
    }
    if (generation !== this.generation || sessionId !== this.deps.sessionId()) {
      return false;
    }

    for (const notification of delivered) {
      this.analysisCompleted.add(notification.id);
      this.deps.jobs.markAnalyzed(notification.id);
    }
    if (await this.settleAnalyzed(sessionId)) {
      this.armRetry();
      return true;
    }
    return false;
  }

  private armRetry(): void {
    if (this.retryTimer) return;
    const timer = setTimeout(() => {
      this.retryTimer = undefined;
      this.scheduleWake();
    }, SessionResponder.RETRY_MS);
    (timer as { unref?: () => void }).unref?.();
    this.retryTimer = timer;
  }

  private clearRetry(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}

function summarizeDelivery(
  notifications: readonly ResponderNotification[],
): string {
  if (notifications.length === 1) {
    const only = notifications[0]!;
    const label = (only.commandDisplay || only.jobId)
      .replace(/\s+/g, " ")
      .trim();
    const short = label.length > 64 ? `${label.slice(0, 63)}…` : label;
    const outcome = only.status === "exited" ? "result" : `${only.status} result`;
    return `Responder → model · ${short} ${outcome}`;
  }
  return `Responder → model · ${notifications.length} job results delivered`;
}
