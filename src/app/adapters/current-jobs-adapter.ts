import { jobManager, type JobManager } from "../../tools/jobs.js";
import type { JobsPort } from "../ports/jobs-port.js";

/** Backs `JobsPort` with the shared background-job manager. */
export function createCurrentJobsPort(manager: JobManager = jobManager): JobsPort {
  return {
    list: (sessionId) => manager.listJobs(sessionId),
    running: (sessionId) => manager.getRunningJobs(sessionId),
    recent: (limit, sessionId) => manager.getRecentJobs(limit, sessionId),
    get: (id) => manager.getJob(id),
    tail: (id, bytes) => manager.tailJob(id, bytes),
    stop: (id) => manager.stopJob(id),
    start: (command, options) => manager.startJob(command, options),
    pendingNotifications: (sessionId) => manager.getPendingNotifications(sessionId),
    activateResponderLease: (sessionId) => manager.activateResponderLease(sessionId),
    getResponderLeaseId: (sessionId) => manager.getResponderLeaseId(sessionId),
    releaseResponderLease: (sessionId, leaseId) =>
      manager.releaseResponderLease(sessionId, leaseId),
    claimNextResponderNotification: (sessionId, leaseId) =>
      manager.claimNextResponderNotification(sessionId, leaseId),
    releaseResponderNotificationClaim: (notificationId) =>
      manager.releaseResponderNotificationClaim(notificationId),
    markDelivered: (notificationId) => manager.markDelivered(notificationId),
    markRead: (notificationId, sessionId) =>
      manager.markRead(notificationId, sessionId),
    markAnalyzed: (notificationId) => manager.markAnalyzed(notificationId),
    acknowledge: (notificationId) => manager.acknowledge(notificationId),
    subscribe: (listener) => manager.subscribe(listener),
    linkJob: (jobId, metadata) => manager.linkJob(jobId, metadata),
    cancelAll: (sessionId) => manager.cancelAll(sessionId),
  };
}
