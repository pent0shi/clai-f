/**
 * Interactive session manager: the single owner of persistent interactive
 * process lifecycle.
 *
 * Ownership is conversation-scoped. Every operation requires an owner id, and a
 * lookup for another owner is indistinguishable from a missing session so the
 * manager cannot be used as an existence oracle. Direct user-terminal handoff is
 * outside this contract by design.
 */

import { safeCwd } from "../os/cwd.js";
import { classifyShellCommand } from "../safety/classifier.js";
import type { EngagementScope } from "../store/scope.js";
import { createArtifactWriter } from "./artifact-writer.js";
import {
  clampReadWait,
  resolveDeadline,
  resolveDimensions,
  resolveInteractiveSessionConfig,
  resolveOptionalTimeout,
  resolveQuietInterval,
  type InteractiveSessionConfig,
  type InteractiveSessionOverrides,
} from "./config.js";
import { CleanupCoordinator } from "./cleanup.js";
import {
  ApprovalTokenVault,
  classifyInteractiveInput,
  describeInput,
} from "./input-policy.js";
import { OutputStore, type PageOutcome } from "./output-store.js";
import { RecoveryJournal, hashOwner, type ReconciliationEntry } from "./recovery-journal.js";
import { SessionRegistry } from "./registry.js";
import { systemClock, type Clock, type Unsubscribe } from "./runtime.js";
import { SessionRuntime } from "./session-runtime.js";
import { SessionTelemetry } from "./telemetry.js";
import { defaultTransportFactory } from "./transport-factory.js";
import {
  LaunchFailure,
  encodeTextInput,
  ptyControlBytes,
  pipeControlAction,
  type SessionTransportFactory,
} from "./transport.js";
import {
  artifactReference,
  asStableError,
  isTerminalState,
  sessionError,
  SessionErrorException,
  throwSessionError,
  toSummary,
  type ArtifactReceipt,
  type CloseAllResult,
  type CloseOwnerResult,
  type CloseRequest,
  type CloseResult,
  type InteractiveSessionRecord,
  type ListResult,
  type OutputView,
  type ProcessOutcome,
  type ReadRequest,
  type ReadResult,
  type ResizeRequest,
  type ResizeResult,
  type SendRequest,
  type SendResult,
  type SessionInput,
  type SessionOperation,
  type SessionTransportKind,
  type StableError,
  type StartRequest,
  type StartResult,
  type StatusResult,
  type TerminalMode,
  type TerminationReason,
} from "./types.js";

/** Confirmation surface for a `confirm`-level action. Previews are redacted. */
export type ConfirmPreview = (request: {
  readonly title: string;
  readonly description: string;
  readonly reason: string;
}) => Promise<boolean>;

export interface ManagerRequestExtras {
  readonly confirm?: ConfirmPreview | undefined;
  readonly scope?: EngagementScope | undefined;
}

export interface InteractiveSessionManagerDeps {
  readonly config?: InteractiveSessionOverrides | undefined;
  readonly transports?: SessionTransportFactory | undefined;
  readonly clock?: Clock | undefined;
  readonly journal?: RecoveryJournal | undefined;
  readonly telemetry?: SessionTelemetry | undefined;
  readonly artifactBaseDir?: string | undefined;
}

type GatherStop = "quiet" | "deadline" | "exit" | "cancelled";

export class InteractiveSessionManager {
  private readonly registry = new SessionRegistry();
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly approvals = new ApprovalTokenVault();
  private readonly telemetry: SessionTelemetry;
  private readonly journal: RecoveryJournal;
  private readonly cleanup: CleanupCoordinator;
  private readonly transports: SessionTransportFactory;
  private readonly clock: Clock;
  private readonly baseConfig: InteractiveSessionConfig;
  private readonly artifactBaseDir: string | undefined;
  private readonly ownerCloses = new Map<string, Promise<CloseOwnerResult>>();

  constructor(deps: InteractiveSessionManagerDeps = {}) {
    this.baseConfig = resolveInteractiveSessionConfig(deps.config ?? {});
    this.transports = deps.transports ?? defaultTransportFactory;
    this.clock = deps.clock ?? systemClock;
    this.telemetry = deps.telemetry ?? new SessionTelemetry();
    this.journal = deps.journal ?? new RecoveryJournal();
    this.artifactBaseDir = deps.artifactBaseDir;
    this.cleanup = new CleanupCoordinator({
      registry: this.registry,
      journal: this.journal,
      onFinalized: (runtime) => {
        this.runtimes.delete(runtime.record.id);
      },
    });
  }

  get config(): InteractiveSessionConfig {
    return this.baseConfig;
  }

  /** Reconcile crashed-session records. Must run before tools are enabled. */
  reconcileOrphans(): ReconciliationEntry[] {
    return this.journal.reconcile();
  }

  async ptyCapability(): Promise<{ available: boolean; reason?: string | undefined }> {
    const capability = await this.transports.capability();
    return capability.available
      ? { available: true }
      : { available: false, reason: capability.reason };
  }

  // --- Start ------------------------------------------------------------

  async start(request: StartRequest & ManagerRequestExtras): Promise<StartResult> {
    const startedAt = Date.now();
    const config = this.baseConfig;
    this.assertOwner(request.ownerId, "start");
    this.assertEnabled(config, "start");
    if (typeof request.command !== "string" || request.command.trim().length === 0) {
      throwSessionError({
        code: "INVALID_REQUEST",
        operation: "start",
        message: "A non-empty command is required to start an interactive session.",
        details: { field: "command" },
      });
    }

    const deadlineMs = resolveDeadline("startDeadlineMs", request.deadlineMs, config, "start");
    const idleTimeoutMs = resolveOptionalTimeout(
      "idleTimeoutMs",
      request.idleTimeoutMs,
      config,
      "start",
    );
    const lifetimeTimeoutMs = resolveOptionalTimeout(
      "lifetimeTimeoutMs",
      request.lifetimeTimeoutMs,
      config,
      "start",
    );
    const mode: TerminalMode = request.terminalMode ?? "preferred";
    if (mode !== "required" && mode !== "preferred" && mode !== "pipe") {
      throwSessionError({
        code: "INVALID_REQUEST",
        operation: "start",
        message: "terminalMode must be required, preferred, or pipe.",
        details: { field: "terminalMode" },
      });
    }
    const dimensions = resolveDimensions(request.columns, request.rows, "start");

    await this.authorizeCommand(request.command, request, config);

    // Resolve capability before allocating anything, so a required-PTY failure
    // never spawns a process.
    const capability = mode === "pipe" ? undefined : await this.transports.capability();
    let transportKind: SessionTransportKind = "pipe";
    let degraded: "PTY_UNAVAILABLE" | undefined;
    if (mode === "required") {
      if (!capability?.available) {
        throwSessionError({
          code: "PTY_UNAVAILABLE",
          operation: "start",
          message:
            capability?.reason ??
            "A pseudoterminal is required but unavailable on this target.",
          details: { terminalMode: mode },
        });
      }
      transportKind = "pty";
    } else if (mode === "preferred") {
      if (capability?.available) transportKind = "pty";
      else degraded = "PTY_UNAVAILABLE";
    }

    const cwd = request.cwd ?? safeCwd();
    const reservation = await this.registry.withOwnerLock(request.ownerId, async () => {
      this.assertNotFenced(request.ownerId, "start");
      const live = this.registry.liveCount(request.ownerId);
      if (live >= config.liveSessionLimit) {
        throwSessionError({
          code: "LIMIT_REACHED",
          operation: "start",
          message: `This conversation already owns ${live} live interactive sessions.`,
          details: { liveSessions: live, limit: config.liveSessionLimit },
        });
      }
      const id = this.registry.mintId();
      const artifact = await createArtifactWriter({
        sessionId: id,
        captureBytes: config.artifactCaptureBytes,
        chunkBytes: config.artifactChunkBytes,
        persistenceQueueBytes: config.persistenceQueueBytes,
        onLimit: config.onOutputLimit,
        baseDir: this.artifactBaseDir,
      });
      const record: InteractiveSessionRecord = {
        id,
        ownerId: request.ownerId,
        state: "starting",
        transport: transportKind,
        startedAt,
        lastActivityAt: startedAt,
        ...(transportKind === "pty" ? { dimensions } : {}),
        ...(degraded ? { degradedReason: degraded } : {}),
        artifact: artifact.receipt() as ArtifactReceipt,
        earliestCursor: 0,
        latestCursor: 0,
        inputClosed: false,
      };
      this.registry.insert(record);
      // Live record written before launch so a crash between here and spawn
      // confirmation still leaves reconcilable evidence.
      this.journal.upsert({
        id,
        ownerHash: hashOwner(request.ownerId),
        pid: undefined,
        processGroupId: undefined,
        identity: undefined,
        platform: process.platform,
        startedAt,
        artifactPath: artifact.path,
        launchConfirmed: false,
      });
      return { record, artifact };
    });

    const { record, artifact } = reservation;
    let retried = false;
    try {
      const launch = await this.launchWithDeadline(
        { command: request.command, cwd },
        transportKind,
        dimensions,
        deadlineMs,
        (didRetry) => {
          retried = didRetry;
        },
      );
      const transport = launch.transport;
      const output = new OutputStore({
        memoryWindowBytes: config.memoryWindowBytes,
        pageBytes: config.pageBytes,
        redactionOverlapBytes: config.redactionOverlapBytes,
        sink: artifact,
        onPause: () => transport.pauseOutput(),
        onResume: () => transport.resumeOutput(),
        onPersistenceStop: (reason) => {
          void this.finalize(
            record.id,
            reason === "output-limit" ? "output-limit" : "explicit-close",
          );
        },
      });
      const runtime = new SessionRuntime({
        record,
        transport,
        output,
        artifact,
        config,
        clock: this.clock,
        idleTimeoutMs,
        lifetimeTimeoutMs,
        onTimeout: (reason) => {
          void this.finalize(record.id, reason);
        },
      });
      // Subscribe before reporting launch confirmation so no output is lost.
      runtime.track(
        transport.onOutput((event) => {
          output.ingest(event.stream, event.bytes, event.observedAt);
          runtime.syncCursors();
          runtime.touch();
        }),
      );
      runtime.track(
        transport.onExit((outcome: ProcessOutcome) => {
          runtime.processExited = true;
          this.registry.enrich(record, { processOutcome: outcome });
          runtime.exitSignal.bump();
          void this.finalize(record.id, "process-exit");
        }),
      );
      this.runtimes.set(record.id, runtime);
      this.journal.upsert({
        id: record.id,
        ownerHash: hashOwner(request.ownerId),
        pid: transport.pid,
        processGroupId: transport.processGroupId,
        identity: transport.identity,
        platform: process.platform,
        startedAt,
        artifactPath: artifact.path,
        launchConfirmed: true,
      });
      this.registry.transition(record, "running");
      this.telemetry.record({
        operation: "start",
        sessionId: record.id,
        durationMs: Date.now() - startedAt,
        result: "ok",
        state: record.state,
        transport: transportKind,
        retryCount: retried ? 1 : 0,
      });
      return {
        operation: "start",
        sessionId: record.id,
        state: record.state,
        transport: transportKind,
        ...(record.dimensions ? { dimensions: record.dimensions } : {}),
        ...(degraded ? { degradedReason: degraded } : {}),
        cursor: output.latestCursor,
        artifact: artifactReference(record.artifact),
        ...(retried ? { retriedLaunch: true } : {}),
      };
    } catch (error) {
      // Every allocated resource is released before Start returns.
      let cleanupVerified = true;
      try {
        await artifact.close();
      } catch {
        cleanupVerified = false;
      }
      this.journal.remove(record.id);
      this.registry.transition(record, "failed", {
        terminationReason: "launch-failure",
        cleanupVerified,
        now: Date.now(),
      });
      const stable = this.launchError(error, record.id, retried);
      this.telemetry.record({
        operation: "start",
        sessionId: record.id,
        durationMs: Date.now() - startedAt,
        result: stable.code,
        state: record.state,
        transport: transportKind,
        retryCount: retried ? 1 : 0,
        cleanupVerified,
      });
      throw new SessionErrorException(stable);
    }
  }

  private launchError(
    error: unknown,
    sessionId: string,
    retried: boolean,
  ): StableError {
    if (error instanceof LaunchFailure) {
      return sessionError({
        code: error.code === "PTY_UNAVAILABLE" ? "PTY_UNAVAILABLE" : "LAUNCH_FAILED",
        operation: "start",
        sessionId,
        message: error.message,
        state: "failed",
        // Only a proven pre-spawn transient failure could be safely retried, and
        // that retry has already been consumed if it was available.
        retryable: error.transient && !error.spawnConfirmed && !retried,
      });
    }
    return asStableError(error, {
      code: "LAUNCH_FAILED",
      operation: "start",
      sessionId,
      state: "failed",
      message: "The interactive session process failed to start.",
    });
  }

  private async launchWithDeadline(
    request: { command: string; cwd: string },
    kind: SessionTransportKind,
    dimensions: { columns: number; rows: number },
    deadlineMs: number,
    onRetry: (retried: boolean) => void,
  ): Promise<{ transport: SessionRuntime["transport"] }> {
    const attempt = async (): Promise<{ transport: SessionRuntime["transport"] }> =>
      kind === "pty"
        ? await this.transports.startPty({ ...request, dimensions })
        : await this.transports.startPipe(request);

    let deadlineTimer: ReturnType<Clock["setTimeout"]> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = this.clock.setTimeout(() => {
        reject(
          new LaunchFailure(
            "START_DEADLINE",
            "The interactive session did not start before its deadline.",
            false,
            false,
          ),
        );
      }, deadlineMs);
    });

    try {
      try {
        return await Promise.race([attempt(), deadline]);
      } catch (error) {
        // One retry only when the adapter proved no process side effect occurred.
        if (error instanceof LaunchFailure && error.transient && !error.spawnConfirmed) {
          onRetry(true);
          return await Promise.race([attempt(), deadline]);
        }
        throw error;
      }
    } finally {
      if (deadlineTimer) this.clock.clearTimeout(deadlineTimer);
    }
  }

  // --- Send -------------------------------------------------------------

  async send(request: SendRequest & ManagerRequestExtras): Promise<SendResult> {
    const startedAt = this.clock.now();
    const runtime = this.requireRuntime(request.ownerId, request.id, "send");
    const config = runtime.config;
    const view: OutputView = request.view ?? "plain";
    const quietMs = resolveQuietInterval(request.quietMs, config, "send");
    const deadlineMs = resolveDeadline("sendDeadlineMs", request.deadlineMs, config, "send");
    const deadlineAt = startedAt + deadlineMs;
    const input = validateInput(request.input, "send");

    await this.authorizeInput(runtime, input, request);

    const accepted = await runtime.mutation.run(() => this.accept(runtime, input));
    const delivery = await accepted.settled;

    runtime.touch();
    const cursor =
      request.cursor !== undefined ? request.cursor : accepted.cursorAtAcceptance;
    const stop = await this.gather(runtime, quietMs, deadlineAt, request.signal);
    const pageOutcome = runtime.output.page({
      cursor,
      view,
      operation: "send",
      sessionId: runtime.record.id,
    });

    const error = this.sendError(runtime, delivery, stop, pageOutcome);
    this.telemetry.record({
      operation: "send",
      sessionId: runtime.record.id,
      durationMs: this.clock.now() - startedAt,
      result: error?.code ?? "ok",
      state: runtime.record.state,
      transport: runtime.record.transport,
      inputBytes: accepted.queuedBytes,
      outputBytes: pageOutcome.page.nextCursor - pageOutcome.page.requestedCursor,
      queueDepth: runtime.input.depth,
      retryCount: 0,
    });
    return {
      operation: "send",
      sessionId: runtime.record.id,
      inputSequence: accepted.sequence,
      delivery: delivery.status,
      deliveredBytes: delivery.deliveredBytes,
      state: runtime.record.state,
      page: pageOutcome.page,
      ...(error ? { error } : {}),
    };
  }

  private sendError(
    runtime: SessionRuntime,
    delivery: { status: string; deliveredBytes: number },
    stop: GatherStop,
    pageOutcome: PageOutcome,
  ): StableError | undefined {
    const sessionId = runtime.record.id;
    if (delivery.status === "unknown") {
      return sessionError({
        code: "INPUT_DELIVERY_UNKNOWN",
        operation: "send",
        sessionId,
        state: runtime.record.state,
        message:
          "The transport could not confirm whether the input bytes were accepted. Do not resend; read output to determine the effect.",
        details: { deliveredBytes: delivery.deliveredBytes },
      });
    }
    if (delivery.status === "not-delivered") {
      return sessionError({
        code: "SESSION_NOT_RUNNING",
        operation: "send",
        sessionId,
        state: runtime.record.state,
        message: "The session was no longer accepting input when the write ran.",
        details: { deliveredBytes: 0 },
      });
    }
    if (stop === "cancelled") {
      return sessionError({
        code: "CANCELLED",
        operation: "send",
        sessionId,
        state: runtime.record.state,
        message:
          "Output gathering was cancelled after the input was delivered; the session is still available.",
      });
    }
    if (stop === "deadline") {
      return sessionError({
        code: "DEADLINE_EXCEEDED",
        operation: "send",
        sessionId,
        state: runtime.record.state,
        message:
          "The send deadline elapsed after input delivery. Continue with a read from nextCursor; do not resend the input.",
      });
    }
    return pageOutcome.ok ? undefined : pageOutcome.error;
  }

  /**
   * Acceptance is all-or-nothing under the mutation lock: either the whole action
   * is reserved within the backpressure bound, or no sequence or queue state
   * changes at all.
   */
  private accept(
    runtime: SessionRuntime,
    input: SessionInput,
  ): {
    sequence: number;
    queuedBytes: number;
    cursorAtAcceptance: number;
    settled: Promise<{ status: "delivered" | "not-delivered" | "unknown"; deliveredBytes: number }>;
  } {
    const record = runtime.record;
    if (record.state === "closing") {
      throwSessionError({
        code: "SESSION_CLOSING",
        operation: "send",
        sessionId: record.id,
        state: record.state,
        message: "This session is closing and no longer accepts input.",
      });
    }
    if (record.state !== "running") {
      throwSessionError({
        code: "SESSION_NOT_RUNNING",
        operation: "send",
        sessionId: record.id,
        state: record.state,
        message: "This session is not running.",
      });
    }
    if (record.inputClosed) {
      throwSessionError({
        code: "INPUT_CLOSED",
        operation: "send",
        sessionId: record.id,
        state: record.state,
        message: "Session input was closed by a prior EOF; no further input is accepted.",
      });
    }
    if (input.kind === "control") this.assertControlSupported(runtime, input.control);

    const bytes =
      input.kind === "text"
        ? encodeTextInput(input.text, input.submit, runtime.transport.kind)
        : new Uint8Array(0);
    const queuedBytes = bytes.length;
    const pending = runtime.input.pendingBytes;
    if (pending + queuedBytes > runtime.config.queuedInputBytes) {
      throwSessionError({
        code: "BACKPRESSURE",
        operation: "send",
        sessionId: record.id,
        state: record.state,
        message: "Queued input for this session would exceed its backpressure limit.",
        details: {
          queuedBytes: pending,
          limitBytes: runtime.config.queuedInputBytes,
        },
      });
    }

    if (input.kind === "eof") record.inputClosed = true;
    const sequence = runtime.input.reserve(queuedBytes);
    const cursorAtAcceptance = runtime.output.latestCursor;
    let settle: (value: {
      status: "delivered" | "not-delivered" | "unknown";
      deliveredBytes: number;
    }) => void = () => undefined;
    const settled = new Promise<{
      status: "delivered" | "not-delivered" | "unknown";
      deliveredBytes: number;
    }>((resolve) => {
      settle = resolve;
    });
    runtime.input.enqueue({
      sequence,
      queuedBytes,
      cursorAtAcceptance,
      deliver: async () => {
        if (input.kind === "eof") return await runtime.transport.closeInput();
        if (input.kind === "control") return await runtime.transport.control(input.control);
        return await runtime.transport.write(bytes);
      },
      settle: (outcome) =>
        settle({ status: outcome.status, deliveredBytes: outcome.deliveredBytes }),
    });
    runtime.touch();
    return { sequence, queuedBytes, cursorAtAcceptance, settled };
  }

  private assertControlSupported(runtime: SessionRuntime, control: string): void {
    const supported =
      runtime.transport.kind === "pty"
        ? ptyControlBytes(control as never) !== undefined
        : pipeControlAction(control as never).kind !== "unsupported";
    if (supported) return;
    throwSessionError({
      code: "UNSUPPORTED_CONTROL",
      operation: "send",
      sessionId: runtime.record.id,
      state: runtime.record.state,
      message: "That control is not supported by this transport on this platform.",
      details: { control, transport: runtime.transport.kind },
    });
  }

  /**
   * Quiet detection starts at delivery completion: only output observed after
   * this point resets the quiet timer, while the absolute deadline never extends.
   */
  private gather(
    runtime: SessionRuntime,
    quietMs: number,
    deadlineAt: number,
    signal: AbortSignal | undefined,
  ): Promise<GatherStop> {
    if (runtime.processExited) return Promise.resolve<GatherStop>("exit");
    if (signal?.aborted) return Promise.resolve<GatherStop>("cancelled");
    return new Promise<GatherStop>((resolve) => {
      const cleanups: Unsubscribe[] = [];
      let quietTimer = this.clock.setTimeout(() => finish("quiet"), quietMs);
      const deadlineTimer = this.clock.setTimeout(
        () => finish("deadline"),
        Math.max(0, deadlineAt - this.clock.now()),
      );
      let settled = false;
      const finish = (stop: GatherStop): void => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(quietTimer);
        this.clock.clearTimeout(deadlineTimer);
        for (const cleanup of cleanups) cleanup();
        signal?.removeEventListener("abort", onAbort);
        resolve(stop);
      };
      const onAbort = (): void => finish("cancelled");
      cleanups.push(
        runtime.output.subscribe(() => {
          if (settled) return;
          this.clock.clearTimeout(quietTimer);
          quietTimer = this.clock.setTimeout(() => finish("quiet"), quietMs);
        }),
      );
      cleanups.push(runtime.exitSignal.subscribe(() => finish("exit")));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  // --- Read -------------------------------------------------------------

  async read(request: ReadRequest): Promise<ReadResult> {
    const startedAt = Date.now();
    const runtime = this.requireRuntime(request.ownerId, request.id, "read");
    const view: OutputView = request.view ?? "plain";
    if (!Number.isInteger(request.cursor) || request.cursor < 0) {
      throwSessionError({
        code: "INVALID_REQUEST",
        operation: "read",
        sessionId: request.id,
        message: "read requires a non-negative integer cursor.",
        details: { field: "cursor" },
      });
    }
    const waitMs = clampReadWait(request.waitMs);
    let stop: GatherStop = "quiet";
    if (waitMs > 0 && request.cursor >= runtime.output.latestCursor) {
      stop = await this.waitForOutput(runtime, request.cursor, waitMs, request.signal);
    }
    const pageOutcome = runtime.output.page({
      cursor: request.cursor,
      view,
      operation: "read",
      sessionId: runtime.record.id,
    });
    const error =
      stop === "cancelled"
        ? sessionError({
            code: "CANCELLED",
            operation: "read",
            sessionId: runtime.record.id,
            state: runtime.record.state,
            message: "The blocking read was cancelled; the session is still available.",
          })
        : pageOutcome.ok
          ? undefined
          : pageOutcome.error;
    this.telemetry.record({
      operation: "read",
      sessionId: runtime.record.id,
      durationMs: Date.now() - startedAt,
      result: error?.code ?? "ok",
      state: runtime.record.state,
      transport: runtime.record.transport,
      outputBytes: pageOutcome.page.nextCursor - pageOutcome.page.requestedCursor,
    });
    return {
      operation: "read",
      sessionId: runtime.record.id,
      state: runtime.record.state,
      page: pageOutcome.page,
      ...(error ? { error } : {}),
    };
  }

  private waitForOutput(
    runtime: SessionRuntime,
    cursor: number,
    waitMs: number,
    signal: AbortSignal | undefined,
  ): Promise<GatherStop> {
    if (signal?.aborted) return Promise.resolve<GatherStop>("cancelled");
    return new Promise<GatherStop>((resolve) => {
      const cleanups: Unsubscribe[] = [];
      let settled = false;
      const timer = this.clock.setTimeout(() => finish("deadline"), waitMs);
      const finish = (stop: GatherStop): void => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(timer);
        for (const cleanup of cleanups) cleanup();
        signal?.removeEventListener("abort", onAbort);
        resolve(stop);
      };
      const onAbort = (): void => finish("cancelled");
      cleanups.push(
        runtime.output.subscribe(() => {
          if (runtime.output.latestCursor > cursor) finish("quiet");
        }),
      );
      cleanups.push(runtime.exitSignal.subscribe(() => finish("exit")));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  // --- Status, List, Resize --------------------------------------------

  status(request: { ownerId: string; id: string }): StatusResult {
    this.assertOwner(request.ownerId, "status");
    const record = this.registry.get(request.ownerId, request.id);
    if (!record) this.notFound(request.id, "status");
    return { operation: "status", session: toSummary(record) };
  }

  list(request: { ownerId: string }): ListResult {
    this.assertOwner(request.ownerId, "list");
    return { operation: "list", sessions: this.registry.list(request.ownerId) };
  }

  async resize(request: ResizeRequest): Promise<ResizeResult> {
    const startedAt = Date.now();
    this.assertOwner(request.ownerId, "resize");
    // Dimensions are validated before any lookup or mutation.
    const dimensions = resolveDimensions(request.columns, request.rows, "resize");
    const runtime = this.requireRuntime(request.ownerId, request.id, "resize");
    if (runtime.transport.kind !== "pty" || !runtime.transport.resize) {
      throwSessionError({
        code: "UNSUPPORTED_OPERATION",
        operation: "resize",
        sessionId: request.id,
        state: runtime.record.state,
        message: "Resize requires a pseudoterminal session.",
        details: { transport: runtime.transport.kind },
      });
    }
    const result = await runtime.mutation.run(async () => {
      const record = runtime.record;
      if (record.state !== "running") {
        throwSessionError({
          code: record.state === "closing" ? "SESSION_CLOSING" : "SESSION_NOT_RUNNING",
          operation: "resize",
          sessionId: record.id,
          state: record.state,
          message: "The session is no longer running, so it cannot be resized.",
        });
      }
      await runtime.transport.resize!(dimensions);
      record.dimensions = dimensions;
      return dimensions;
    });
    this.telemetry.record({
      operation: "resize",
      sessionId: request.id,
      durationMs: Date.now() - startedAt,
      result: "ok",
      state: runtime.record.state,
      transport: runtime.record.transport,
    });
    return {
      operation: "resize",
      sessionId: request.id,
      state: runtime.record.state,
      dimensions: result,
    };
  }

  // --- Close and owner lifecycle ---------------------------------------

  async close(request: CloseRequest): Promise<CloseResult> {
    const startedAt = Date.now();
    this.assertOwner(request.ownerId, "close");
    const record = this.registry.get(request.ownerId, request.id);
    if (!record) this.notFound(request.id, "close");
    const deadlineMs = resolveDeadline(
      "closeDeadlineMs",
      request.deadlineMs,
      this.baseConfig,
      "close",
    );
    const result = await this.finalizeRecord(record, "explicit-close", deadlineMs);
    this.telemetry.record({
      operation: "close",
      sessionId: record.id,
      durationMs: Date.now() - startedAt,
      result: result.error?.code ?? "ok",
      state: result.state,
      transport: record.transport,
      ...(result.terminationReason ? { terminationReason: result.terminationReason } : {}),
      cleanupVerified: result.cleanupVerified,
    });
    return result;
  }

  /** Owner cancellation: closes every live session owned by a conversation. */
  async cancelOwner(ownerId: string): Promise<CloseOwnerResult> {
    return await this.closeOwnerSessions(ownerId, "cancelled");
  }

  /**
   * Fence an owner synchronously, then start one tracked close. Callers rebinding
   * a conversation id must fence before the old id becomes unreachable.
   */
  beginCloseOwner(
    ownerId: string,
    reason: TerminationReason = "conversation-teardown",
  ): Promise<CloseOwnerResult> {
    this.registry.fenceOwner(ownerId);
    const existing = this.ownerCloses.get(ownerId);
    if (existing) return existing;
    const promise = this.closeOwnerSessions(ownerId, reason).finally(() => {
      this.ownerCloses.delete(ownerId);
    });
    this.ownerCloses.set(ownerId, promise);
    return promise;
  }

  /** Await any teardown already started for an owner. */
  async awaitOwnerClose(ownerId: string): Promise<void> {
    await this.ownerCloses.get(ownerId);
  }

  async closeAll(reason: TerminationReason = "app-shutdown"): Promise<CloseAllResult> {
    const owners = this.registry.owners();
    await Promise.all([...this.ownerCloses.values()].map((promise) => promise.catch(() => undefined)));
    const results = await Promise.all(
      owners.map((ownerId) => this.closeOwnerSessions(ownerId, reason)),
    );
    return {
      owners: owners.length,
      closed: results.reduce((sum, result) => sum + result.closed, 0),
      failures: results.flatMap((result) => result.failures),
    };
  }

  private async closeOwnerSessions(
    ownerId: string,
    reason: TerminationReason,
  ): Promise<CloseOwnerResult> {
    const records = this.registry.liveRecords(ownerId);
    const results = await Promise.all(
      records.map((record) =>
        this.finalizeRecord(record, reason, this.baseConfig.closeDeadlineMs),
      ),
    );
    return {
      closed: results.length,
      failures: results
        .map((result) => result.error)
        .filter((error): error is StableError => error !== undefined),
    };
  }

  private async finalizeRecord(
    record: InteractiveSessionRecord,
    reason: TerminationReason,
    deadlineMs: number,
  ): Promise<CloseResult> {
    const runtime = this.runtimes.get(record.id);
    if (!runtime) {
      // Already finalized (or never launched): return the recorded terminal
      // result without signalling a process.
      return {
        operation: "close",
        sessionId: record.id,
        state: record.state,
        ...(record.terminationReason ? { terminationReason: record.terminationReason } : {}),
        ...(record.processOutcome ? { processOutcome: record.processOutcome } : {}),
        cleanupVerified: record.cleanupVerified ?? isTerminalState(record.state),
        artifact: artifactReference(record.artifact),
      };
    }
    return await this.cleanup.close(runtime, reason, deadlineMs);
  }

  private async finalize(id: string, reason: TerminationReason): Promise<void> {
    const record = this.registry.getUnscoped(id);
    if (!record) return;
    await this.finalizeRecord(record, reason, this.baseConfig.closeDeadlineMs);
  }

  // --- Policy -----------------------------------------------------------

  private async authorizeCommand(
    command: string,
    request: ManagerRequestExtras,
    config: InteractiveSessionConfig,
  ): Promise<void> {
    void config;
    const decision = classifyShellCommand(
      command,
      request.scope ? { scope: request.scope } : {},
    );
    if (decision.level === "block") {
      throwSessionError({
        code: "INPUT_REJECTED",
        operation: "start",
        message: `Blocked by safety policy: ${decision.reason}.`,
      });
    }
    if (decision.level === "safe") return;
    const approved = await request.confirm?.({
      title: "Start interactive session",
      description: describeInput({ kind: "text", text: command, submit: "enter" }),
      reason: decision.reason,
    });
    if (!approved) {
      throwSessionError({
        code: "INPUT_REJECTED",
        operation: "start",
        message: `Confirmation is required to start this interactive session: ${decision.reason}.`,
      });
    }
  }

  private async authorizeInput(
    runtime: SessionRuntime,
    input: SessionInput,
    request: ManagerRequestExtras,
  ): Promise<void> {
    const decision = classifyInteractiveInput({
      ownerId: runtime.record.ownerId,
      sessionId: runtime.record.id,
      transport: runtime.transport.kind,
      input,
      ...(request.scope ? { scope: request.scope } : {}),
    });
    if (decision.level === "safe") return;
    if (decision.level === "block") {
      throwSessionError({
        code: "INPUT_REJECTED",
        operation: "send",
        sessionId: runtime.record.id,
        state: runtime.record.state,
        message: `Blocked by interactive input policy: ${decision.reason}.`,
      });
    }
    const binding = {
      ownerId: runtime.record.ownerId,
      sessionId: runtime.record.id,
      input,
      decision: decision.level,
    };
    const approved = await request.confirm?.({
      title: "Send interactive input",
      description: describeInput(input),
      reason: decision.reason,
    });
    // The token binds the approval to these exact bytes and is consumed once,
    // so a concurrent replay cannot deliver the same input twice.
    const token = approved ? this.approvals.mint(binding) : undefined;
    if (!this.approvals.consume(token, binding)) {
      throwSessionError({
        code: "INPUT_REJECTED",
        operation: "send",
        sessionId: runtime.record.id,
        state: runtime.record.state,
        message: `Confirmation is required for this input: ${decision.reason}.`,
      });
    }
  }

  // --- Helpers ----------------------------------------------------------

  private assertOwner(ownerId: string | undefined, operation: SessionOperation): void {
    if (typeof ownerId === "string" && ownerId.length > 0) return;
    throwSessionError({
      code: "INVALID_REQUEST",
      operation,
      message: "An owning conversation id is required for interactive session operations.",
      details: { field: "ownerId" },
    });
  }

  private assertNotFenced(ownerId: string, operation: SessionOperation): void {
    if (!this.registry.isFenced(ownerId)) return;
    throwSessionError({
      code: "SESSION_CLOSING",
      operation,
      message: "This conversation is being torn down and cannot own new sessions.",
    });
  }

  private assertEnabled(
    config: InteractiveSessionConfig,
    operation: SessionOperation,
  ): void {
    if (config.enabled) return;
    throwSessionError({
      code: "UNSUPPORTED_OPERATION",
      operation,
      message: "Interactive terminal sessions are disabled in this configuration.",
    });
  }

  private notFound(id: string, operation: SessionOperation): never {
    throwSessionError({
      code: "SESSION_NOT_FOUND",
      operation,
      sessionId: id,
      message: "No interactive session with that id is owned by this conversation.",
    });
  }

  private requireRuntime(
    ownerId: string,
    id: string,
    operation: SessionOperation,
  ): SessionRuntime {
    this.assertOwner(ownerId, operation);
    const record = this.registry.get(ownerId, id);
    if (!record) this.notFound(id, operation);
    const runtime = this.runtimes.get(id);
    if (!runtime) {
      throwSessionError({
        code: "SESSION_NOT_RUNNING",
        operation,
        sessionId: id,
        state: record.state,
        message: "This session has already reached a terminal state.",
      });
    }
    return runtime;
  }
}

/** Strict validation of the dependent input fields before acceptance. */
export function validateInput(
  input: SessionInput | undefined,
  operation: SessionOperation,
): SessionInput {
  if (!input) {
    throwSessionError({
      code: "INVALID_REQUEST",
      operation,
      message: "An input action is required.",
      details: { field: "kind" },
    });
  }
  if (input.kind === "text") {
    if (typeof input.text !== "string") {
      throwSessionError({
        code: "INVALID_REQUEST",
        operation,
        message: "Text input requires a string body.",
        details: { field: "text" },
      });
    }
    if (input.submit !== "enter" && input.submit !== "none") {
      throwSessionError({
        code: "INVALID_REQUEST",
        operation,
        message: "Text input requires submit to be enter or none.",
        details: { field: "submit" },
      });
    }
    return input;
  }
  if (input.kind === "control" || input.kind === "eof") return input;
  throwSessionError({
    code: "INVALID_REQUEST",
    operation,
    message: "Input kind must be text, control, or eof.",
    details: { field: "kind" },
  });
}

/** Process-wide manager, mirroring the existing process-wide job manager. */
export const interactiveSessionManager = new InteractiveSessionManager();
