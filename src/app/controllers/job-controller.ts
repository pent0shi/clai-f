import type { ToolResult } from "../../types.js";
import type {
  BackgroundJob,
  JobLinkMetadata,
  JobManagerListener,
  JobsPort,
  ResponderNotification,
  StartJobOptions,
} from "../ports/jobs-port.js";
import type { Disposable } from "./disposable.js";

export class JobController implements Disposable {
  constructor(private readonly jobs: JobsPort) {}

  list(sessionId?: string): ToolResult {
    return this.jobs.list(sessionId);
  }

  running(sessionId?: string): BackgroundJob[] {
    return this.jobs.running(sessionId);
  }

  get(id: string): BackgroundJob | undefined {
    return this.jobs.get(id);
  }

  tail(id: string, bytes?: number): Promise<ToolResult> {
    return this.jobs.tail(id, bytes);
  }

  stop(id: string): Promise<ToolResult> {
    return this.jobs.stop(id);
  }

  start(command: string, options?: StartJobOptions): Promise<ToolResult> {
    return this.jobs.start(command, options);
  }

  pendingNotifications(sessionId?: string): ResponderNotification[] {
    return this.jobs.pendingNotifications(sessionId);
  }

  activateResponderLease(sessionId: string): string {
    return this.jobs.activateResponderLease(sessionId);
  }

  getResponderLeaseId(sessionId: string): string | undefined {
    return this.jobs.getResponderLeaseId(sessionId);
  }

  releaseResponderLease(sessionId: string, leaseId?: string): void {
    this.jobs.releaseResponderLease(sessionId, leaseId);
  }

  claimNextResponderNotification(
    sessionId: string,
    leaseId: string,
  ): ResponderNotification | undefined {
    return this.jobs.claimNextResponderNotification(sessionId, leaseId);
  }

  markDeliveryStarted(notificationId: string, sessionId?: string): boolean {
    return this.jobs.markDeliveryStarted(notificationId, sessionId);
  }

  markDelivered(notificationId: string, sessionId?: string): boolean {
    return this.jobs.markDelivered(notificationId, sessionId);
  }

  markRead(notificationId: string, sessionId: string): boolean {
    return this.jobs.markRead(notificationId, sessionId);
  }

  markAnalyzed(notificationId: string, sessionId?: string): boolean {
    return this.jobs.markAnalyzed(notificationId, sessionId);
  }

  acknowledge(notificationId: string, sessionId?: string): boolean {
    return this.jobs.acknowledge(notificationId, sessionId);
  }

  subscribe(listener: JobManagerListener): () => void {
    return this.jobs.subscribe(listener);
  }

  linkJob(jobId: string, metadata: JobLinkMetadata): BackgroundJob | undefined {
    return this.jobs.linkJob(jobId, metadata);
  }

  cancelAll(sessionId: string): Promise<ToolResult> {
    return this.jobs.cancelAll(sessionId);
  }

  hasRunning(sessionId?: string): boolean {
    return this.running(sessionId).length > 0;
  }

  dispose(): void {
    // Jobs intentionally outlive the UI; nothing to tear down here.
  }
}
