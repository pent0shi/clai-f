/**
 * Application boundary for conversation-owned interactive terminal sessions.
 *
 * Operation cancellation and owner cancellation are intentionally separate:
 * aborting one `terminal.send` does not close a child, while owner cancellation
 * closes every session the conversation owns.
 */

import type {
  CloseAllResult,
  CloseOwnerResult,
  TerminationReason,
} from "../../interactive-session/types.js";

export type { CloseAllResult, CloseOwnerResult };

export interface InteractiveSessionsPort {
  /** Close every live session for one owner with reason `cancelled`. */
  cancelOwner(ownerId: string): Promise<CloseOwnerResult>;
  /**
   * Fence the owner synchronously and begin one tracked close. Call this before
   * rebinding, replacing, resetting, or disposing a conversation id.
   */
  beginCloseOwner(
    ownerId: string,
    reason?: Extract<TerminationReason, "conversation-teardown">,
  ): Promise<CloseOwnerResult>;
  /** Await teardown already started for an owner. */
  awaitOwnerClose(ownerId: string): Promise<void>;
  closeAll(reason?: Extract<TerminationReason, "app-shutdown">): Promise<CloseAllResult>;
}
