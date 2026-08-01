import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedArtifactWriter } from "../../src/interactive-session/artifact-writer.js";
import { INTERACTIVE_SESSION_DEFAULTS } from "../../src/interactive-session/config.js";
import { OutputStore, type OutputSink } from "../../src/interactive-session/output-store.js";
import type { Clock, TimerHandle, Unsubscribe } from "../../src/interactive-session/runtime.js";
import type {
  DeliveryResult,
  LaunchRequest,
  LaunchResult,
  PtyCapability,
  SessionTransport,
  SessionTransportFactory,
  TransportOutput,
} from "../../src/interactive-session/transport.js";
import type {
  ArtifactReference,
  ControlInput,
  OutputStream,
  ProcessOutcome,
  TerminalDimensions,
} from "../../src/interactive-session/types.js";

export function tempArtifactDir(): string {
  return mkdtempSync(join(tmpdir(), "clai-its-"));
}

/** Sink that keeps every canonical byte in memory for assertions. */
export class MemorySink implements OutputSink {
  readonly written: number[] = [];
  limitReached = false;
  failed = false;
  writable = true;

  append(bytes: Uint8Array): boolean {
    this.written.push(...bytes);
    return this.writable;
  }

  async waitForDrain(): Promise<void> {
    this.writable = true;
  }

  reference(): ArtifactReference {
    return {
      path: "/dev/null/memory",
      bytes: this.written.length,
      droppedBytes: 0,
      redacted: true,
    };
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.written);
  }
}

export function makeStore(
  overrides: Partial<{
    memoryWindowBytes: number;
    pageBytes: number;
    redactionOverlapBytes: number;
    sink: OutputSink;
  }> = {},
): { store: OutputStore; sink: OutputSink } {
  const sink = overrides.sink ?? new MemorySink();
  const store = new OutputStore({
    memoryWindowBytes: overrides.memoryWindowBytes ?? 1_048_576,
    pageBytes: overrides.pageBytes ?? 12_000,
    redactionOverlapBytes:
      overrides.redactionOverlapBytes ?? INTERACTIVE_SESSION_DEFAULTS.redactionOverlapBytes,
    sink,
  });
  return { store, sink };
}

/** Deterministic clock: timers only fire when the test advances time. */
export class FakeClock implements Clock {
  private current = 0;
  private sequence = 0;
  private readonly timers = new Map<number, { at: number; handler: () => void }>();

  now(): number {
    return this.current;
  }

  setTimeout(handler: () => void, ms: number): TimerHandle {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.current + Math.max(0, ms), handler });
    return { id };
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle.id as number);
  }

  /** Advance time, firing due timers in chronological order. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      this.timers.delete(id);
      this.current = timer.at;
      timer.handler();
      await Promise.resolve();
    }
    this.current = target;
    await Promise.resolve();
  }

  get pending(): number {
    return this.timers.size;
  }
}

export interface FakeTransportOptions {
  readonly kind?: "pty" | "pipe";
  readonly pid?: number;
  readonly processGroupId?: number | undefined;
  readonly writeResult?: (bytes: Uint8Array) => DeliveryResult;
  readonly beforeWrite?: () => Promise<void>;
}

export class FakeTransport implements SessionTransport {
  readonly kind: "pty" | "pipe";
  readonly pid: number;
  readonly processGroupId: number | undefined;
  readonly identity = "fake-identity";
  readonly writes: string[] = [];
  readonly controls: ControlInput[] = [];
  readonly order: number[] = [];
  inputClosed = 0;
  disposed = 0;
  paused = 0;
  resumed = 0;
  terminations: Array<"graceful" | "forceful"> = [];
  resizes: TerminalDimensions[] = [];
  exited = false;

  private readonly outputListeners = new Set<(event: TransportOutput) => void>();
  private readonly exitListeners = new Set<(outcome: ProcessOutcome) => void>();
  private sequence = 0;

  constructor(private readonly options: FakeTransportOptions = {}) {
    this.kind = options.kind ?? "pipe";
    this.pid = options.pid ?? -1;
    this.processGroupId = options.processGroupId;
  }

  async write(bytes: Uint8Array): Promise<DeliveryResult> {
    if (this.options.beforeWrite) await this.options.beforeWrite();
    else await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
    this.writes.push(Buffer.from(bytes).toString("utf8"));
    this.order.push(++this.sequence);
    return this.options.writeResult?.(bytes) ?? {
      status: "delivered",
      deliveredBytes: bytes.length,
    };
  }

  async control(action: ControlInput): Promise<DeliveryResult> {
    this.controls.push(action);
    return { status: "delivered", deliveredBytes: 0 };
  }

  async closeInput(): Promise<DeliveryResult> {
    this.inputClosed += 1;
    return { status: "delivered", deliveredBytes: 0 };
  }

  async resize(dimensions: TerminalDimensions): Promise<void> {
    this.resizes.push(dimensions);
  }

  pauseOutput(): void {
    this.paused += 1;
  }

  resumeOutput(): void {
    this.resumed += 1;
  }

  async requestTreeTermination(kind: "graceful" | "forceful"): Promise<"sent" | "gone" | "failed"> {
    this.terminations.push(kind);
    if (!this.exited) this.emitExit({ endAt: 0, code: 0 });
    return "sent";
  }

  onOutput(listener: (event: TransportOutput) => void): Unsubscribe {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  onExit(listener: (outcome: ProcessOutcome) => void): Unsubscribe {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.disposed += 1;
    this.outputListeners.clear();
    this.exitListeners.clear();
  }

  emit(text: string, stream: OutputStream = this.kind === "pty" ? "terminal" : "stdout"): void {
    const event: TransportOutput = {
      stream,
      bytes: new Uint8Array(Buffer.from(text, "utf8")),
      observedAt: Date.now(),
    };
    for (const listener of [...this.outputListeners]) listener(event);
  }

  emitExit(options: { endAt?: number; code?: number } = {}): void {
    if (this.exited) return;
    this.exited = true;
    const outcome: ProcessOutcome = {
      endedAt: options.endAt ?? Date.now(),
      exitCode: options.code ?? 0,
    };
    for (const listener of [...this.exitListeners]) listener(outcome);
  }
}

export interface FakeFactoryOptions {
  readonly ptyAvailable?: boolean;
  readonly ptyFailsToStart?: boolean;
  readonly onTransport?: (transport: FakeTransport) => void;
  readonly transportOptions?: Omit<FakeTransportOptions, "kind" | "pid">;
}

export class FakeTransportFactory implements SessionTransportFactory {
  readonly ptyStarts: LaunchRequest[] = [];
  readonly pipeStarts: LaunchRequest[] = [];
  readonly transports: FakeTransport[] = [];

  constructor(private readonly options: FakeFactoryOptions = {}) {}

  async capability(platform: NodeJS.Platform = process.platform): Promise<PtyCapability> {
    return this.options.ptyAvailable
      ? { available: true, platform }
      : { available: false, platform, reason: "test: pty disabled" };
  }

  async startPipe(request: LaunchRequest): Promise<LaunchResult> {
    this.pipeStarts.push(request);
    const transport = this.make("pipe");
    request.onLaunchIdentity?.({
      pid: transport.pid,
      processGroupId: transport.processGroupId,
      identity: transport.identity,
    });
    return { transport };
  }

  async startPty(request: LaunchRequest & { dimensions: TerminalDimensions }): Promise<LaunchResult> {
    this.ptyStarts.push(request);
    if (this.options.ptyFailsToStart) throw new Error("pty spawn failed");
    const transport = this.make("pty");
    request.onLaunchIdentity?.({
      pid: transport.pid,
      processGroupId: transport.processGroupId,
      identity: transport.identity,
    });
    return { transport };
  }

  get launches(): number {
    return this.ptyStarts.length + this.pipeStarts.length;
  }

  last(): FakeTransport {
    const transport = this.transports.at(-1);
    if (!transport) throw new Error("no transport was created");
    return transport;
  }

  private make(kind: "pty" | "pipe"): FakeTransport {
    const transport = new FakeTransport({
      ...this.options.transportOptions,
      kind,
      pid: -1,
    });
    this.transports.push(transport);
    this.options.onTransport?.(transport);
    return transport;
  }
}

export function writerFor(directory: string, sessionId = "s1"): BoundedArtifactWriter {
  return new BoundedArtifactWriter({
    sessionId,
    directory,
    captureBytes: 1_048_576,
    chunkBytes: 65_536,
    persistenceQueueBytes: 65_536,
    onLimit: "terminate",
  });
}
