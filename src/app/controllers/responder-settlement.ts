import { isResponderResultLedgerMessage } from "../../agent/responder-context.js";
import type { ChatMessage } from "../../types.js";
import type { SessionId } from "../events/app-event.js";
import type { JobsPort } from "../ports/jobs-port.js";

export function settlePersistedResponderResults(input: {
  jobs: JobsPort | undefined;
  sessionId: SessionId;
  history: readonly ChatMessage[];
}): void {
  if (!input.jobs) return;
  const ledger = input.history
    .filter(isResponderResultLedgerMessage)
    .map((message) => message.content)
    .join("\n");
  for (const notification of input.jobs.pendingNotifications(input.sessionId)) {
    if (
      !notification.deliveredAt ||
      !ledger.includes(`notification=${notification.id} `)
    ) {
      continue;
    }
    if (!notification.analyzedAt && !input.jobs.markAnalyzed(notification.id, input.sessionId)) {
      continue;
    }
    input.jobs.acknowledge(notification.id, input.sessionId);
  }
}
