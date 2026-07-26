import type {
  ChatMessage,
  Mode,
  ProviderId,
  TokenUsage,
  ToolResult,
} from "../../types.js";
import {
  compactMessagesWithSummary,
  estimateMessagesTokens,
  isCompactionMemoryMessage,
  type CompactResult,
} from "../../agent/context-manager.js";
import { repairToolProtocol } from "../../agent/tool-history.js";
import {
  formatContextChip,
  snapshotFromEstimate,
  type ContextUsageSnapshot,
} from "../../llm/token-usage.js";
import {
  compactedUsageSnapshot,
  contextUsageLimit,
  recordUsageSnapshot,
  resolveContextUsageSnapshot,
  createContextProjector,
  type ContextProjection,
  type ContextUsageTarget,
} from "./session-context-usage.js";
import { createSessionPolicy, type SessionPolicy } from "../../agent/session-policy.js";
import { resolveTurnInput } from "../../attachments/service.js";
import { generateSessionTitle } from "../../agent/session-title.js";
import { clearTextOnlyModels } from "../../llm/tool-protocol.js";
import { getConfig, getProviderModel } from "../../store/config.js";
import { beginSessionWorkspace, getActiveSessionWorkspace, type SessionWorkspace } from "../../store/session-workspace.js";
import { materializeHistoryImages } from "../../store/history.js";
import { summarizeForSessionCompact } from "./session-compact-helper.js";
import { settlePersistedResponderResults } from "./responder-settlement.js";
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
import type { JobsPort } from "../ports/jobs-port.js";
import type { PersistencePort } from "../ports/persistence-port.js";
import type { ConfirmationPort } from "../ports/confirm-port.js";
import type { SecretPort } from "../ports/secret-port.js";
import { TurnController, type TurnResult } from "./turn-controller.js";
import { CompositeDisposable, type Disposable } from "./disposable.js";
import {
  persistedContextUsage,
  SessionPersistenceQueue,
} from "./session-persistence.js";
import {
  SessionPromptQueue,
  type TurnDisplayOptions,
} from "./session-prompt-queue.js";
import {
  SessionResponder,
  type ResponderRuntimeState,
} from "./session-responder.js";

export interface SessionState {
  readonly sessionId: SessionId;
  readonly mode: Mode;
  readonly provider: ProviderId | undefined;
  readonly model: string | undefined;
  readonly running: boolean;
  readonly compacting: boolean;
  readonly historyLength: number;
  readonly queued: readonly string[];
  readonly responder: ResponderRuntimeState;
  readonly title: string | undefined;
  readonly contextUsage: ContextUsageSnapshot | undefined;
  readonly contextChip: string | undefined;
}

export type NoticeLevel = "info" | "warn";

export interface SessionControllerDeps {
  readonly agent: AgentPort;
  readonly persistence: PersistencePort;
  readonly jobs?: JobsPort | undefined;
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
  readonly notifyResponderDelivery?: ((summary: string) => void) | undefined;
}


export type TurnEndListener = (result: TurnResult) => void;
export type SessionStateListener = () => void;

function mintSessionId(): string {
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function pathBackedMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (!message.images?.length) return { ...message };
    const images = message.images.flatMap((image) =>
      image.path
        ? [{ mediaType: image.mediaType, dataBase64: "", path: image.path }]
        : [],
    );
    const { images: _images, ...rest } = message;
    return images.length > 0 ? { ...rest, images } : rest;
  });
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
  private readonly prompts: SessionPromptQueue;
  private readonly responder: SessionResponder | undefined;
  private provider: ProviderId | undefined;
  private model: string | undefined;
  private mode: Mode;
  private compactingFlag = false;
  private compactAbort: AbortController | undefined; // cancels in-flight /compact
  /** Display name written into history.db (AI title or explicit /save name). */
  private sessionTitle: string | undefined;
  /** User-message count at last successful AI title (classic refresh cadence). */
  private titledAtUserCount = 0;
  private titleInFlight = false;
  /** Throttle mid-turn history autosaves so abort/crash still keep tools on disk. */
  private lastAutosaveAt = 0;
  private autosaveInFlight = false;
  /** Orders autosave, terminal, compaction, title, switch, and shutdown writes. */
  private readonly persistence: SessionPersistenceQueue;
  private static readonly AUTOSAVE_MIN_MS = 15_000;
  /** Last known context / session token totals for the status strip. */
  private contextUsage: ContextUsageSnapshot | undefined;
  private readonly projectContext = createContextProjector((snapshot) =>
    formatContextChip(snapshot, { compact: false }),
  );

  constructor(private readonly deps: SessionControllerDeps) {
    this.sessionIdValue = asSessionId(deps.sessionId ?? mintSessionId());
    this.persistence = new SessionPersistenceQueue(deps.persistence);
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
    this.prompts = new SessionPromptQueue({
      isRunning: () => this.turn.running,
      abort: (reason) => this.abort(reason),
      notifyState: () => this.notifyState(),
      notice: (text) => this.notice("info", text),
      runTurn: (prompt, options) => this.runTurn(prompt, options),
    });
    if (deps.jobs) {
      this.responder = new SessionResponder({
        jobs: deps.jobs,
        persistence: deps.persistence,
        sessionId: () => this.sessionIdValue,
        isBusy: () => this.turn.running || this.compactingFlag,
        hasQueuedWork: () => this.prompts.hasPending(),
        continueQueue: () => this.prompts.continue(),
        runTurn: (prompt, onStarted) =>
          this.runTurn(prompt, {
            displayPrompt: null,
            materializeHistoryImages: false,
            onStarted,
          }),
        notifyState: () => this.notifyState(),
        ...(deps.notifyResponderDelivery
          ? { notifyDelivery: deps.notifyResponderDelivery }
          : {}),
      });
      const unsubscribe = deps.jobs.subscribe((change) => {
        this.responder?.handleChange(change);
      });
      this.disposables.add({ dispose: unsubscribe });
    } else {
      this.responder = undefined;
    }
  }

  /** Current per-session scratch/output workspace (always bound while live). */
  get workspace(): SessionWorkspace | undefined {
    return getActiveSessionWorkspace();
  }

  get sessionId(): SessionId {
    return this.sessionIdValue;
  }

  getState(): SessionState {
    const { contextUsage, contextChip } = this.contextUsageProjection();
    return {
      sessionId: this.sessionIdValue,
      mode: this.mode,
      provider: this.provider,
      model: this.model,
      running: this.turn.running,
      compacting: this.compactingFlag,
      historyLength: this.history.length,
      queued: this.prompts.snapshot(),
      responder: this.responder?.getState() ?? {
        mode: "off",
        running: 0,
        ready: 0,
        delivered: 0,
        archived: 0,
        failed: 0,
      },
      title: this.sessionTitle,
      contextUsage,
      contextChip,
    };
  }

  private contextUsageProjection(): ContextProjection {
    return this.projectContext(this.usageTarget, this.history, this.contextUsage);
  }

  private get usageTarget(): ContextUsageTarget {
    return { provider: this.provider, model: this.model };
  }

  private resolveContextUsage(): ContextUsageSnapshot | undefined {
    return resolveContextUsageSnapshot(
      this.usageTarget,
      this.history,
      this.contextUsage,
    );
  }

  /** Record provider-reported usage (from agent token-usage events). */
  recordTokenUsage(usage: TokenUsage, model?: string): void {
    const target = { provider: this.provider, model: model ?? this.model };
    this.contextUsage = recordUsageSnapshot(target, this.contextUsage, usage);
    if (model) this.model = model;
    this.notifyState();
  }

  /** After /compact or auto-compact, report the post-compaction context size. */
  noteContextCompacted(afterTokens?: number): void {
    this.contextUsage = compactedUsageSnapshot(
      this.usageTarget,
      this.contextUsage,
      this.history,
      afterTokens,
    );
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
      /** Loaded durable revision; resume advances to a fresh writer generation. */
      persistenceRevision?: number | undefined;
      /** Per-session scratch/output folder (restored with history). */
      workspaceFolder?: string | undefined;
      workspaceCode?: string | undefined;
    } = {},
  ): void {
    if (this.turn.running) this.turn.abort();
    this.responder?.invalidateWake();
    // Deep-copy then heal broken assistant/tool pairs from aborted turns so
    // /history resume + "continue" never dies on invalid native tool protocol.
    const healed: ChatMessage[] = messages.map((m) => ({ ...m }));
    repairToolProtocol(healed);
    this.history = healed;
    this.prompts.clear();
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
            : contextUsageLimit({ provider: this.provider, model: this.model }),
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
      this.persistence.rebind(options.persistenceRevision);
    }
    // Rebind (or mint) the per-session workspace so scratch + outputs
    // continue under the same folder when resuming history.
    beginSessionWorkspace({
      folderName: options.workspaceFolder,
      code: options.workspaceCode,
    });
    this.settlePersistedResponderResults();
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
    this.responder?.invalidateWake();
    this.history = [];
    this.prompts.clear();
    this.sessionTitle = undefined;
    this.titledAtUserCount = 0;
    this.titleInFlight = false;
    this.contextUsage = undefined;
    this.spool.clear();
    if (options.mintNewId) {
      this.sessionIdValue = asSessionId(mintSessionId());
      this.sequencer.rebind(this.sessionIdValue);
      this.persistence.newSession();
      // Fresh session identity → fresh isolated workspace.
      beginSessionWorkspace();
    }
    this.policy = createSessionPolicy(this.sessionIdValue);
    this.notifyState();
  }

  /** Roll back history after a rejected plan-implement compaction. */
  restoreMessages(
    messages: readonly ChatMessage[],
    contextUsage?: ContextUsageSnapshot | undefined,
  ): void {
    this.history = [...messages];
    if (contextUsage) {
      this.contextUsage = { ...contextUsage };
    } else {
      this.refreshEstimatedContext();
    }
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
    const compactAc = new AbortController();
    this.compactAbort = compactAc;
    if (signal?.aborted) compactAc.abort();
    else signal?.addEventListener("abort", () => compactAc.abort(), { once: true });
    this.notifyState();
    try {
      const result = await compactMessagesWithSummary(
        historySnapshot,
        (prompt) =>
          summarizeForSessionCompact(prompt, {
            provider,
            model,
            signal: compactAc.signal,
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
      this.compactAbort = undefined;
      this.notifyState();
      // Becoming idle after compaction is an idle transition just like a turn
      // ending: a responder completion that arrived while compactingFlag was
      // set had its wake suppressed by isBusy(). Re-arm it here or the agent
      // stays stranded (job exited, no wake, no delivery) until the next turn.
      this.responder?.scheduleWake();
    }
  }

  private settlePersistedResponderResults(): void {
    settlePersistedResponderResults({
      jobs: this.deps.jobs,
      sessionId: this.sessionIdValue,
      history: this.history,
    });
  }

  async persistNow(name?: string): Promise<void> {
    if (this.deps.noHistory || getConfig().privateMode) {
      this.settlePersistedResponderResults();
      return;
    }
    if (this.history.length === 0) {
      return;
    }
    if (!this.history.some((m) => m.role === "user" || isCompactionMemoryMessage(m))) {
      return;
    }
    if (name) this.sessionTitle = name;

    const contextUsage = persistedContextUsage(this.resolveContextUsage());
    await this.persistence.save(this.history, {
      sessionId: this.sessionIdValue,
      name: name ?? this.sessionTitle,
      transcript: this.deps.getTranscriptSnapshot?.(),
      ...(contextUsage ? { contextUsage } : {}),
    });
    this.settlePersistedResponderResults();
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

  async cancelAll(): Promise<ToolResult> {
    this.responder?.invalidateWake();
    this.turn.abort();
    this.compactAbort?.abort(); // cancel in-flight /compact alongside the turn
    this.prompts.clear(true);
    this.notifyState();
    if (!this.deps.jobs) {
      return { ok: true, output: "Turn cancelled; no background-job service is configured." };
    }
    return this.deps.jobs.cancelAll(this.sessionIdValue);
  }

  enqueue(prompt: string, opts?: TurnDisplayOptions): void {
    this.prompts.enqueue(prompt, opts);
  }

  queued(): readonly string[] {
    return this.prompts.snapshot();
  }

  removeQueued(index: number): void {
    this.prompts.remove(index);
  }

  takeQueued(index: number): string | undefined {
    return this.prompts.take(index);
  }

  editQueued(index: number, text: string): void {
    this.prompts.edit(index, text);
  }

  reorderQueued(fromIndex: number, toIndex: number): void {
    this.prompts.reorder(fromIndex, toIndex);
  }

  sendQueuedNow(index: number): void {
    this.prompts.sendNow(index);
  }

  abort(reason?: string): void {
    this.responder?.deactivate();
    this.turn.abort(reason);
    this.compactAbort?.abort(); // also cancel in-flight /compact (outside a turn)
  }

  async continueQueue(): Promise<void> {
    await this.prompts.continue();
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
    opts?: TurnDisplayOptions,
  ): Promise<TurnResult> {
    this.responder?.activate();
    return this.prompts.submit(prompt, opts);
  }

  async drain(): Promise<TurnResult[]> {
    return this.prompts.drain();
  }

  private async runTurn(
    prompt: string,
    opts?: {
      displayPrompt?: string | null | undefined;
      materializeHistoryImages?: boolean | undefined;
      onStarted?: (() => void) | undefined;
    },
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
      history:
        opts?.materializeHistoryImages === false
          ? this.history
          : materializeHistoryImages(this.history),
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
        this.history = pathBackedMessages(messages);
        this.notifyState();
        // Periodic durable snapshot so Esc/kill mid-run does not wipe tools.
        this.scheduleAutosave();
      },
      onStarted: opts?.onStarted,
    });
    this.notifyState();
    const result = await pending;
    this.notifyState();
    this.responder?.scheduleWake();
    try {
      if (
        result.status === "completed" ||
        result.status === "aborted" ||
        result.status === "error"
      ) {
        await this.persistNow();
      }
      if (result.status === "completed") {
        void this.maybeRefreshTitle();
      }
      for (const listener of this.turnEndListeners) listener(result);
      return result;
    } finally {
      this.responder?.scheduleWake();
    }
  }

  /**
   * Best-effort mid-turn autosave (throttled). Called from onMessages so a
   * long agent run still lands tools/messages on disk before abort/crash.
   */
  private scheduleAutosave(): void {
    if (this.deps.noHistory || getConfig().privateMode) return;
    if (!this.history.some((m) => m.role === "user" || isCompactionMemoryMessage(m))) return;
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
    this.responder?.invalidateWake();
    this.turnEndListeners.clear();
    this.stateListeners.clear();
    this.disposables.dispose();
  }

  private notifyState(): void {
    for (const listener of this.stateListeners) listener();
  }
}
