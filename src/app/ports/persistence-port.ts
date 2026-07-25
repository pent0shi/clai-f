import type { ChatMessage } from "../../types.js";
import type { SessionPlan } from "../../store/plan.js";
import type { PersistedContextUsage } from "../../store/history.js";
import type { TranscriptItem } from "../../tui/state.js";

export interface SaveSessionOptions {
  /** When set, upsert this session id (continuous autosave) instead of minting a new row. */
  readonly sessionId?: string | undefined;
  /** Unique writer generation; compared before the per-writer revision. */
  readonly writerGeneration?: string | undefined;
  /**
   * Monotonic snapshot revision within one writer generation. Storage rejects
   * lower revisions so a slow autosave cannot overwrite a newer save.
   */
  readonly revision?: number | undefined;
  /** Optional display name. */
  readonly name?: string | undefined;
  /** Classic-shaped visual transcript for full /history restore. */
  readonly transcript?: readonly TranscriptItem[] | undefined;
  /** Token/context footer snapshot so /history resume matches the live count. */
  readonly contextUsage?: PersistedContextUsage | undefined;
}


export interface PersistencePort {
  saveSession(
    messages: readonly ChatMessage[],
    options?: SaveSessionOptions,
  ): Promise<void>;
  loadPlan(sessionId: string): Promise<SessionPlan | undefined>;
  savePlan(plan: SessionPlan): Promise<void>;
  /**
   * Transactional plan mutation (TASK-001). Optional so lightweight test
   * doubles can keep implementing only `savePlan`.
   */
  mutatePlan?(
    sessionId: string,
    reducer: (draft: SessionPlan) => boolean | void,
  ): Promise<{ ok: boolean; plan?: SessionPlan | undefined }>;
  deletePlan(sessionId: string): Promise<void>;
}
