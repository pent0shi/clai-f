import type { ChatMessage, Mode, ProviderId, TokenUsage } from "../../types.js";
import {
  compactMessagesWithSummary,
  estimateMessagesTokens,
  isCompactionMemoryMessage,
  type CompactResult,
} from "../../agent/context-manager.js";
import { repairToolProtocol } from "../../agent/tool-history.js";
import {
  applyUsageToSnapshot,
  formatContextChip,
  modelContextWindow,
  snapshotFromEstimate,
  type ContextUsageSnapshot,
} from "../../llm/token-usage.js";
import { createSessionPolicy, type SessionPolicy } from "../../agent/session-policy.js";
import { resolveTurnInput } from "../../attachments/service.js";
import { generateSessionTitle } from "../../agent/session-title.js";
import { clearTextOnlyModels } from "../../llm/tool-protocol.js";
import { getConfig, getProviderModel } from "../../store/config.js";
import {
  beginSessionWorkspace,
  getActiveSessionWorkspace,
  type SessionWorkspace,
} from "../../store/session-workspace.js";
import { summarizeForSessionCompact } from "./session-compact-helper.js";
import type { TranscriptItem as ClassicTranscriptItem } from "../../tui/state.js";
import {
  asSessionId,
  type AnyAppEvent,
  type SessionId,
  type TurnId,
} from "../events/app-event.js";
import {
  EventSequencer,
  type Clock,
  type IdFactory,
} from "../events/sequencer.js";
import { OutputSpool } from "../events/event-buffer.js";
import type { AgentPort, RunTurnRequest } from "../ports/agent-port.js";
import type { PersistencePort } from "../ports/persistence-port.js";
import type { ConfirmationPort } from "../ports/confirm-port.js";
import type { SecretPort } from "../ports/secret-port.js";
import { TurnController, type TurnResult } from "./turn-controller.js";
import { CompositeDisposable, type Disposable } from "./disposable.js";

export interface SessionState {
  readonly sessionId: SessionId;
  readonly mode: Mode;
  readonly provider: ProviderId | undefined;
  readonly model: string | undefined;
  readonly running: boolean;
  /** True while /compact is awaiting the summarizer (status strip). */
  readonly compacting: boolean;
  readonly historyLength: number;
  readonly queued: readonly string[];
  /** AI-generated (or last known) display name for this session. */
  readonly title: string | undefined;
  /**
   * Live context / token usage for the status strip under the composer.
   * `exact` is true when the last prompt size came from the provider API.
   */
  readonly contextUsage: ContextUsageSnapshot | undefined;
  /** Preformatted chip, e.g. `12,450 tok` or `~12.5k tok`. */
  readonly contextChip: string | undefined;
}

export type NoticeLevel = "info" | "warn";

export interface SessionControllerDeps {
  readonly agent: AgentPort;
  readonly persistence: PersistencePort;
  readonly emit: (event: AnyAppEvent) => void;
  readonly sessionId?: string | undefined;
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
  readonly mode?: Mode | undefined;
  readonly confirm?: ConfirmationPort | undefined;
  readonly requestSecret?: SecretPort["request"] | undefined;
  readonly idFactory?: IdFactory | undefined;
  readonly clock?: Clock | undefined;
  readonly mintTurnId?: (() => TurnId) | undefined;
  
  readonly getTranscriptSnapshot?: (() => ClassicTranscriptItem[] | undefined) | undefined;
  /** When true, never persist sessions or generate AI titles (CLI --no-history). */
  readonly noHistory?: boolean | undefined;
}


export type TurnEndListener = (result: TurnResult) => void;
export type SessionStateListener = () => void;

function mintSessionId(): string {
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SessionController implements Disposable {
  readonly spool = new OutputSpool();

  private sessionIdValue: SessionId;
  private readonly sequencer: EventSequencer;
  private readonly turn: TurnController;
  private policy: SessionPolicy;
  private readonly disposables = new CompositeDisposable();
  private readonly turnEndListeners = new Set<TurnEndListener>();
  private readonly stateListeners = new Set<SessionStateListener>();

  private history: ChatMessage[] = [];
  private readonly queue: string[] = [];
  /**
   * Prompt promoted by "Send now" while a turn was running. After the abort
   * settles, {@link continueQueue} runs this before any remaining queue items.
   */
  private priorityPrompt: string | undefined;
  /**
   * Display override for the next turn only (`null` = hide YOU bubble).
   * Used when implement/revision directives are queued while a turn is running.
   */
  private nextTurnDisplayPrompt: string | null | undefined = undefined;
  private nextTurnDisplayArmed = false;
  /** Re-entrancy guard for {@link continueQueue}. */
  private continuingQueue = false;
  private provider: ProviderId | undefined;
  private model: string | undefined;
  private mode: Mode;
  private compactingFlag = false;
  /** Display name written into history.db (AI title or explicit /save name). */
  private sessionTitle: string | undefined;
  /** User-message count at last successful AI title (classic refresh cadence). */
  private titledAtUserCount = 0;
  private titleInFlight = false;
  /** Throttle mid-turn history autosaves so abort/crash still keep tools on disk. */
  private lastAutosaveAt = 0;
  private autosaveInFlight = false;
  private static readonly AUTOSAVE_MIN_MS = 15_000;
  /** Last known context / session token totals for the status strip. */
  private contextUsage: ContextUsageSnapshot | undefined;

  constructor(private readonly deps: SessionControllerDeps) {
    this.sessionIdValue = asSessionId(deps.sessionId ?? mintSessionId());
    this.provider = deps.provider;
    this.model = deps.model;
    this.mode = deps.mode ?? "agent";
    this.policy = createSessionPolicy(this.sessionIdValue);
    // Isolate scratch + tool outputs for this session immediately.
    beginSessionWorkspace();
    this.sequencer = new EventSequencer(
      this.sessionIdValue,
      deps.idFactory,
      deps.clock,
    );
    this.turn = this.disposables.add(
      new TurnController({
        agent: deps.agent,
        sequencer: this.sequencer,
        spool: this.spool,
        emit: deps.emit,
        mintTurnId: deps.mintTurnId,
      }),
    );
  }

  /** Current per-session scratch/output workspace (always bound while live). */
  get workspace(): SessionWorkspace | undefined {
    return getActiveSessionWorkspace();
  }

  get sessionId(): SessionId {
    return this.sessionIdValue;
  }

  getState(): SessionState {
    const contextUsage = this.resolveContextUsage();
    return {
      sessionId: this.sessionIdValue,
      mode: this.mode,
      provider: this.provider,
      model: this.model,
      running: this.turn.running,
      compacting: this.compactingFlag,
      historyLength: this.history.length,
      queued: [...this.queue],
      title: this.sessionTitle,
      contextUsage,
      contextChip: contextUsage
        ? formatContextChip(contextUsage, { compact: false })
        : undefined,
    };
  }

  /**
   * Prefer last API prompt_tokens as context fill (exact); otherwise estimate
   * from current history so the footer always has a number.
   */
  private resolveContextUsage(): ContextUsageSnapshot | undefined {
    const limit = modelContextWindow(this.model, this.provider);
    if (this.contextUsage?.exact && this.contextUsage.contextTokens > 0) {
      return { ...this.contextUsage, contextLimit: limit };
    }
    if (this.history.length === 0 && !this.contextUsage) return undefined;
    return snapshotFromEstimate(
      this.history,
      this.model,
      this.provider,
      this.contextUsage,
    );
  }

  /** Record provider-reported usage (from agent token-usage events). */
  recordTokenUsage(usage: TokenUsage, model?: string): void {
    const limit = modelContextWindow(model ?? this.model, this.provider);
    this.contextUsage = applyUsageToSnapshot(this.contextUsage, usage, limit);
    if (model) this.model = model;
    this.notifyState();
  }

  /**
   * After /compact or auto-compact: history was replaced with a short memory
   * + recent turns. Drop stale exact prompt_tokens so the footer shows the
   * live context size until the next API usage report.
   */
  noteContextCompacted(afterTokens?: number): void {
    const limit = modelContextWindow(this.model, this.provider);
    const estimated =
      typeof afterTokens === "number" && afterTokens > 0
        ? afterTokens
        : estimateMessagesTokens(this.history);
    this.contextUsage = {
      contextTokens: estimated,
      contextLimit: limit,
      lastCompletionTokens: 0,
      sessionPromptTokens: this.contextUsage?.sessionPromptTokens ?? 0,
      sessionCompletionTokens: this.contextUsage?.sessionCompletionTokens ?? 0,
      exact: false,
    };
    this.notifyState();
  }

  /** After history loads, estimate fill until the next API usage report. */
  private refreshEstimatedContext(): void {
    this.contextUsage = snapshotFromEstimate(
      this.history,
      this.model,
      this.provider,
      undefined,
    );
  }

  get messages(): readonly ChatMessage[] {
    return this.history;
  }

  /** Subscribe to transient UI state such as running/queue status. */
  subscribe(listener: SessionStateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  setProvider(provider: ProviderId | undefined): void {
    this.provider = provider;
    clearTextOnlyModels();
    this.notifyState();
  }

  setModel(model: string | undefined): void {
    this.model = model;
    // Allow native tools again after /model switch (sticky text-only is process-global).
    clearTextOnlyModels();
    this.notifyState();
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.notifyState();
  }

  /**
   * Replace model history (and optionally rebind the session id so later
   * autosaves update the resumed history row).
   */
  loadHistory(
    messages: readonly ChatMessage[],
    options: {
      sessionId?: string;
      title?: string | undefined;
      /**
       * Restored from history so the footer matches the live session count.
       * Accepts partial snapshots (contextLimit optional).
       */
      contextUsage?:
        | ContextUsageSnapshot
        | {
            contextTokens: number;
            contextLimit?: number | undefined;
            lastCompletionTokens?: number | undefined;
            sessionPromptTokens?: number | undefined;
            sessionCompletionTokens?: number | undefined;
            exact: boolean;
          }
        | undefined;
      /** Per-session scratch/output folder (restored with history). */
      workspaceFolder?: string | undefined;
      workspaceCode?: string | undefined;
    } = {},
  ): void {
    if (this.turn.running) this.turn.abort();
    // Deep-copy then heal broken assistant/tool pairs from aborted turns so
    // /history resume + "continue" never dies on invalid native tool protocol.
    const healed: ChatMessage[] = messages.map((m) => ({ ...m }));
    repairToolProtocol(healed);
    this.history = healed;
    this.queue.length = 0;
    this.priorityPrompt = undefined;
    this.spool.clear();
    // Keep the resumed session's existing title; only refresh after the user
    // adds more turns (same cadence as classic TUI).
    this.sessionTitle = options.title;
    this.titledAtUserCount = messages.filter((m) => m.role === "user").length;
    this.titleInFlight = false;
    // Prefer the exact snapshot saved during the live turn; only estimate when
    // older sessions have no usage payload (would otherwise drop 39k → ~11k).
    if (
      options.contextUsage &&
      options.contextUsage.contextTokens > 0
    ) {
      const cu = options.contextUsage;
      this.contextUsage = {
        contextTokens: cu.contextTokens,
        contextLimit:
          typeof cu.contextLimit === "number" && cu.contextLimit > 0
            ? cu.contextLimit
            : modelContextWindow(this.model, this.provider),
        lastCompletionTokens: cu.lastCompletionTokens ?? 0,
        sessionPromptTokens: cu.sessionPromptTokens ?? 0,
        sessionCompletionTokens: cu.sessionCompletionTokens ?? 0,
        exact: cu.exact === true,
      };
    } else {
      this.contextUsage = undefined;
      this.refreshEstimatedContext();
    }
    if (options.sessionId) {
      this.sessionIdValue = asSessionId(options.sessionId);
      this.sequencer.rebind(this.sessionIdValue);
      this.policy = createSessionPolicy(this.sessionIdValue);
    }
    // Rebind (or mint) the per-session workspace so scratch + outputs
    // continue under the same folder when resuming history.
    beginSessionWorkspace({
      folderName: options.workspaceFolder,
      code: options.workspaceCode,
    });
    this.notifyState();
  }

  notice(level: NoticeLevel, text: string): void {
    this.deps.emit(this.sequencer.build("notice", { level, text }, undefined));
  }

  allowTool(name: string): void {
    this.policy.allow.add(name);
  }

  disallowTool(name: string): void {
    this.policy.allow.delete(name);
  }

  allowedTools(): readonly string[] {
    return [...this.policy.allow];
  }

  /**
   * Clear conversation state. When `mintNewId` is true (for `/new`/`/clean`),
   * remint the session id so subsequent autosave does not overwrite the prior
   * history row.
   */
  reset(options: { mintNewId?: boolean } = {}): void {
    if (this.turn.running) this.turn.abort();
    this.history = [];
    this.queue.length = 0;
    this.priorityPrompt = undefined;
    this.sessionTitle = undefined;
    this.titledAtUserCount = 0;
    this.titleInFlight = false;
    this.contextUsage = undefined;
    this.spool.clear();
    if (options.mintNewId) {
      this.sessionIdValue = asSessionId(mintSessionId());
      this.sequencer.rebind(this.sessionIdValue);
      // Fresh session identity → fresh isolated workspace.
      beginSessionWorkspace();
    }
    this.policy = createSessionPolicy(this.sessionIdValue);
    this.notifyState();
  }

  /** Roll back history after a rejected plan-implement compaction. */
  restoreMessages(messages: readonly ChatMessage[]): void {
    this.history = [...messages];
    this.refreshEstimatedContext();
    this.notifyState();
  }

  async compact(
    sessionTranscript?: string,
    keepRecent = 2,
    signal?: AbortSignal,
    options: {
      purpose?: "default" | "plan-implement" | undefined;
      /** Default true: emit compacted event + persist. */
      persist?: boolean | undefined;
    } = {},
  ): Promise<CompactResult> {
    if (this.turn.running) throw new Error("a turn is already running");
    if (this.compactingFlag) throw new Error("compaction already in progress");

    const cfg = getConfig();
    const provider = this.provider ?? (cfg.defaultProvider as ProviderId | undefined);
    const model = this.model ?? cfg.defaultModel;
    const persist = options.persist !== false;
    const historySnapshot = [...this.history];

    this.compactingFlag = true;
    this.notifyState();
    try {
      const result = await compactMessagesWithSummary(
        historySnapshot,
        (prompt) =>
          summarizeForSessionCompact(prompt, {
            provider,
            model,
            signal,
            purpose: options.purpose,
          }),
        { budgetTokens: 0, keepRecent, purpose: options.purpose },
        sessionTranscript,
      );
      this.history = result.messages;
      if (result.summarized) this.noteContextCompacted(result.afterTokens);
      this.notifyState();
      if (persist && result.summarized && result.after !== result.before) {
        // Re-compaction can encounter legacy memory in resumed histories.
        // Emit the newest inserted memory, never an older retained snapshot.
        const memo =
          [...result.messages]
            .reverse()
            .find((message) => isCompactionMemoryMessage(message))?.content ??
          "Compacted context";
        this.deps.emit(
          this.sequencer.build(
            "compacted",
            {
              summary: memo,
              beforeTokens: result.beforeTokens,
              afterTokens: result.afterTokens,
            },
            undefined,
          ),
        );
        await this.persistNow();
      }
      return result;
    } finally {
      this.compactingFlag = false;
      this.notifyState();
    }
  }

  /** Persist current messages (+ optional visual transcript) under this session id. */
  async persistNow(name?: string): Promise<void> {
    if (this.deps.noHistory || getConfig().privateMode) return;
    if (this.history.length === 0) return;
    // Only sessions with a real user turn belong in /history (classic parity).
    if (!this.history.some((m) => m.role === "user")) return;
    if (name) this.sessionTitle = name;
    const transcript = this.deps.getTranscriptSnapshot?.();
    const snap = this.resolveContextUsage();
    await this.deps.persistence.saveSession(this.history, {
      sessionId: this.sessionIdValue,
      name: name ?? this.sessionTitle,
      transcript,
      ...(snap && snap.contextTokens > 0
        ? {
            contextUsage: {
              contextTokens: snap.contextTokens,
              contextLimit: snap.contextLimit,
              lastCompletionTokens: snap.lastCompletionTokens,
              sessionPromptTokens: snap.sessionPromptTokens,
              sessionCompletionTokens: snap.sessionCompletionTokens,
              exact: snap.exact,
            },
          }
        : {}),
    });
  }

  
  async maybeRefreshTitle(): Promise<void> {
    if (this.deps.noHistory || getConfig().privateMode) return;
    if (this.titleInFlight) return;
    const userCount = this.history.filter((m) => m.role === "user").length;
    const hasAssistant = this.history.some(
      (m) => m.role === "assistant" && m.content.trim().length > 0,
    );
    if (userCount === 0 || !hasAssistant) return;
    const shouldGenerate =
      this.titledAtUserCount === 0 || userCount - this.titledAtUserCount >= 2;
    if (!shouldGenerate) return;

    const provider = this.provider ?? getConfig().defaultProvider;
    const model = this.model ?? getProviderModel(provider);
    if (!provider || !model) return;

    this.titleInFlight = true;
    const sessionIdAtStart = this.sessionIdValue;
    const targetCount = userCount;
    try {
      const title = await generateSessionTitle(this.history, {
        provider,
        model,
      });
      if (!title) return;
      // Discard if the user started / resumed another session while waiting.
      if (this.sessionIdValue !== sessionIdAtStart) return;
      this.titledAtUserCount = targetCount;
      this.sessionTitle = title;
      await this.persistNow(title);
      this.notifyState();
    } catch {
      // Title is best-effort; derived name from first user message remains.
    } finally {
      this.titleInFlight = false;
    }
  }

  estimateContext(): { messages: number; tokens: number } {
    const snap = this.resolveContextUsage();
    return {
      messages: this.history.length,
      tokens: snap?.contextTokens ?? estimateMessagesTokens(this.history),
    };
  }

  /**
   * Queue a prompt while a turn is running. Optional displayPrompt is applied
   * to the next dequeued turn (null hides the YOU bubble).
   */
  enqueue(
    prompt: string,
    opts?: { displayPrompt?: string | null | undefined },
  ): void {
    if (opts && "displayPrompt" in opts) {
      this.nextTurnDisplayPrompt = opts.displayPrompt;
      this.nextTurnDisplayArmed = true;
    }
    const text = prompt.trim();
    if (!text) return;
    this.queue.push(text);
    this.notifyState();
  }

  queued(): readonly string[] {
    return [...this.queue];
  }

  removeQueued(index: number): void {
    if (index >= 0 && index < this.queue.length) {
      this.queue.splice(index, 1);
      this.notifyState();
    }
  }

  
  takeQueued(index: number): string | undefined {
    if (index < 0 || index >= this.queue.length) return undefined;
    const [text] = this.queue.splice(index, 1);
    this.notifyState();
    return text;
  }

  /** Edit a queued draft in place before it runs (INPUT-007). */
  editQueued(index: number, text: string): void {
    if (index >= 0 && index < this.queue.length) {
      this.queue[index] = text;
      this.notifyState();
    }
  }

  /** Move a queued draft to a new position before it runs (INPUT-007). */
  reorderQueued(fromIndex: number, toIndex: number): void {
    if (
      fromIndex < 0 ||
      fromIndex >= this.queue.length ||
      toIndex < 0 ||
      toIndex >= this.queue.length ||
      fromIndex === toIndex
    ) {
      return;
    }
    const [moved] = this.queue.splice(fromIndex, 1);
    if (moved !== undefined) this.queue.splice(toIndex, 0, moved);
    this.notifyState();
  }

  
  sendQueuedNow(index: number): void {
    const text = this.takeQueued(index);
    if (text === undefined) return;
    if (this.turn.running) {
      this.priorityPrompt = text;
      this.turn.abort();
      this.notice("info", "interrupting · sending queued prompt now");
      return;
    }
    void this.submit(text).then(() => this.continueQueue());
  }

  abort(): void {
    this.turn.abort();
  }

 
  async continueQueue(): Promise<void> {
    if (this.continuingQueue || this.turn.running) return;
    this.continuingQueue = true;
    try {
      while (!this.turn.running) {
        let next: string | undefined;
        if (this.priorityPrompt !== undefined) {
          next = this.priorityPrompt;
          this.priorityPrompt = undefined;
        } else if (this.queue.length > 0) {
          next = this.queue.shift();
          this.notifyState();
        } else {
          break;
        }
        if (next === undefined || !next.trim()) continue;
        const displayOpts = this.consumeNextTurnDisplay();
        await this.runTurn(next, displayOpts);
      }
    } finally {
      this.continuingQueue = false;
    }
  }

  private consumeNextTurnDisplay():
    | { displayPrompt?: string | null | undefined }
    | undefined {
    if (!this.nextTurnDisplayArmed) return undefined;
    this.nextTurnDisplayArmed = false;
    const displayPrompt = this.nextTurnDisplayPrompt;
    this.nextTurnDisplayPrompt = undefined;
    return { displayPrompt };
  }

  /** In-memory plan-approval flag consumed by the agent gate (CORE-005). */
  setPlanApproved(value: boolean): void {
    this.policy.planApproved.value = value;
  }

  isPlanApproved(): boolean {
    return this.policy.planApproved.value;
  }

  /** Fires after every turn settles (completed/aborted/error), including drain. */
  onTurnEnd(listener: TurnEndListener): () => void {
    this.turnEndListeners.add(listener);
    return () => this.turnEndListeners.delete(listener);
  }

  async submit(
    prompt: string,
    opts?: { displayPrompt?: string | null | undefined },
  ): Promise<TurnResult> {
    if (this.turn.running) {
      throw new Error("a turn is already running; enqueue() while busy");
    }
    // Explicit submit opts win over any armed queue display override.
    if (opts && "displayPrompt" in opts) {
      this.nextTurnDisplayArmed = false;
      this.nextTurnDisplayPrompt = undefined;
      return this.runTurn(prompt, opts);
    }
    const displayOpts = this.consumeNextTurnDisplay();
    return this.runTurn(prompt, displayOpts ?? opts);
  }

  /**
   * Runs queued prompts one at a time while idle; stops on first
   * non-completion. Prefer {@link continueQueue} from the UI so priority
   * ("send now") prompts are honored too.
   */
  async drain(): Promise<TurnResult[]> {
    const results: TurnResult[] = [];
    while (this.queue.length > 0 && !this.turn.running) {
      const next = this.queue.shift();
      if (next === undefined) break;
      this.notifyState();
      const result = await this.runTurn(next);
      results.push(result);
      if (result.status !== "completed") break;
    }
    return results;
  }

  private async runTurn(
    prompt: string,
    opts?: { displayPrompt?: string | null | undefined },
  ): Promise<TurnResult> {
    const config = getConfig();
    const provider = this.provider ?? config.defaultProvider;
    const model = this.model ?? getProviderModel(provider);
    const resolved = resolveTurnInput({
      prompt,
      mode: this.mode,
      provider,
      model,
    });
    if (resolved.fallbackReason) this.notice("info", resolved.fallbackReason);
    const request: RunTurnRequest = {
      prompt: resolved.prompt,
      mode: resolved.mode,
      provider: resolved.provider,
      model: resolved.model,
      history: this.history,
      attachments: resolved.attachments,
      images: resolved.images,
      ...(opts?.displayPrompt !== undefined
        ? { displayPrompt: opts.displayPrompt }
        : {}),
    };
    const pending = this.turn.run(request, {
      confirm: this.deps.confirm,
      requestSecret: this.deps.requestSecret,
      session: this.policy,
      onMessages: (messages) => {
        this.history = messages;
        this.notifyState();
        // Periodic durable snapshot so Esc/kill mid-run does not wipe tools.
        this.scheduleAutosave();
      },
    });
  
    this.notifyState();
    const result = await pending;
    // Persist on every terminal outcome — aborted turns used to skip save,
    // so /history only showed "Aborted." while plans still had real work.
    if (
      result.status === "completed" ||
      result.status === "aborted" ||
      result.status === "error"
    ) {
      await this.persistNow();
    }
    if (result.status === "completed") {
      // Fire-and-forget AI title so the turn path is not blocked on a second
      // model call; classic TUI does the same after each completed exchange.
      void this.maybeRefreshTitle();
    }
    for (const listener of this.turnEndListeners) listener(result);
    this.notifyState();
    return result;
  }

  /**
   * Best-effort mid-turn autosave (throttled). Called from onMessages so a
   * long agent run still lands tools/messages on disk before abort/crash.
   */
  private scheduleAutosave(): void {
    if (this.deps.noHistory || getConfig().privateMode) return;
    if (!this.history.some((m) => m.role === "user")) return;
    const now = Date.now();
    if (now - this.lastAutosaveAt < SessionController.AUTOSAVE_MIN_MS) return;
    if (this.autosaveInFlight) return;
    this.lastAutosaveAt = now;
    this.autosaveInFlight = true;
    void this.persistNow()
      .catch(() => undefined)
      .finally(() => {
        this.autosaveInFlight = false;
      });
  }

  dispose(): void {
    this.turnEndListeners.clear();
    this.stateListeners.clear();
    this.disposables.dispose();
  }

  private notifyState(): void {
    for (const listener of this.stateListeners) listener();
  }
}
