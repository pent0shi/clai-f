/**
 * Per-session concurrency primitives.
 *
 * The locking model is deliberately fine-grained: one owner-level mutex guards
 * id issuance and live-slot reservation, one mutation mutex per session guards
 * state/input/resize decisions, and output ingestion never takes either lock so
 * a chatty child cannot block Close.
 */

/** Monotonic time source. Wall time is only used for receipts, never deadlines. */
export interface Clock {
  now(): number;
  setTimeout(handler: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export type TimerHandle = { readonly id: unknown };

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(handler, ms) {
    const timer = setTimeout(handler, ms);
    timer.unref?.();
    return { id: timer };
  },
  clearTimeout(handle) {
    clearTimeout(handle.id as NodeJS.Timeout);
  },
};

export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  /** Serialize `fn`; rejections do not poison the queue. */
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Single-winner terminal work. Every later caller joins the first promise, so
 * cleanup executes exactly once no matter how many triggers race.
 */
export class FinalizeOnce<T> {
  private promise: Promise<T> | undefined;
  private winnerReason: string | undefined;

  get started(): boolean {
    return this.promise !== undefined;
  }

  /** The reason that won the race, useful for choosing a terminal state. */
  get reason(): string | undefined {
    return this.winnerReason;
  }

  run(reason: string, fn: () => Promise<T>): Promise<T> {
    if (!this.promise) {
      this.winnerReason = reason;
      this.promise = fn();
    }
    return this.promise;
  }

  join(): Promise<T> | undefined {
    return this.promise;
  }
}

export type Unsubscribe = () => void;

/** Version-counter subscription used by blocking reads and send gathering. */
export class Notifier {
  private version = 0;
  private readonly listeners = new Set<(version: number) => void>();

  get current(): number {
    return this.version;
  }

  bump(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener(this.version);
  }

  subscribe(listener: (version: number) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    this.listeners.clear();
  }
}

export interface SessionTimers {
  idle?: TimerHandle | undefined;
  lifetime?: TimerHandle | undefined;
}

/** Idle resets on activity; lifetime is fixed from confirmed launch. */
export class TimerSet {
  private readonly timers: SessionTimers = {};

  constructor(
    private readonly clock: Clock,
    private readonly onExpire: (reason: "idle-timeout" | "lifetime-timeout") => void,
  ) {}

  armIdle(ms: number | undefined): void {
    if (this.timers.idle) this.clock.clearTimeout(this.timers.idle);
    this.timers.idle = undefined;
    if (ms === undefined) return;
    this.timers.idle = this.clock.setTimeout(() => {
      this.timers.idle = undefined;
      this.onExpire("idle-timeout");
    }, ms);
  }

  armLifetime(ms: number | undefined): void {
    if (this.timers.lifetime || ms === undefined) return;
    this.timers.lifetime = this.clock.setTimeout(() => {
      this.timers.lifetime = undefined;
      this.onExpire("lifetime-timeout");
    }, ms);
  }

  clearAll(): void {
    if (this.timers.idle) this.clock.clearTimeout(this.timers.idle);
    if (this.timers.lifetime) this.clock.clearTimeout(this.timers.lifetime);
    this.timers.idle = undefined;
    this.timers.lifetime = undefined;
  }
}

/** Resolve/reject handle for one in-flight wait, removable on cancel. */
export interface Waiter {
  cancel(): void;
}

export class WaiterSet {
  private readonly waiters = new Set<Waiter>();

  add(waiter: Waiter): Unsubscribe {
    this.waiters.add(waiter);
    return () => {
      this.waiters.delete(waiter);
    };
  }

  cancelAll(): void {
    for (const waiter of [...this.waiters]) waiter.cancel();
    this.waiters.clear();
  }

  get size(): number {
    return this.waiters.size;
  }
}

/**
 * One accepted input action. Immutable once queued: the payload is never
 * rewritten, and delivery is attempted exactly once.
 */
export interface QueuedInputAction {
  readonly sequence: number;
  readonly queuedBytes: number;
  /** Cursor captured when the action was accepted, used as the default page start. */
  readonly cursorAtAcceptance: number;
  readonly deliver: () => Promise<InputDeliveryOutcome>;
  readonly settle: (outcome: InputDeliveryOutcome) => void;
}

export interface InputDeliveryOutcome {
  readonly status: "delivered" | "not-delivered" | "unknown";
  readonly deliveredBytes: number;
  readonly cause?: unknown;
}

/**
 * FIFO writer lane. Accepted actions are written strictly in ascending sequence
 * order by a single drain loop, so concurrent sends can never interleave bytes
 * or reorder commands.
 */
export class OrderedInputQueue {
  private readonly queue: QueuedInputAction[] = [];
  private draining = false;
  private nextSequence = 1;
  private queuedBytes = 0;

  get depth(): number {
    return this.queue.length;
  }

  get pendingBytes(): number {
    return this.queuedBytes;
  }

  peekSequence(): number {
    return this.nextSequence;
  }

  /** Reserve a sequence number and queued-byte budget for one action. */
  reserve(bytes: number): number {
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    this.queuedBytes += bytes;
    return sequence;
  }

  enqueue(action: QueuedInputAction): void {
    this.queue.push(action);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const action = this.queue.shift()!;
        let outcome: InputDeliveryOutcome;
        try {
          outcome = await action.deliver();
        } catch (error) {
          outcome = { status: "unknown", deliveredBytes: 0, cause: error };
        }
        this.queuedBytes = Math.max(0, this.queuedBytes - action.queuedBytes);
        action.settle(outcome);
      }
    } finally {
      this.draining = false;
    }
  }

  /** Reject every undelivered entry, e.g. after process exit or close. */
  rejectAll(outcome: InputDeliveryOutcome): void {
    while (this.queue.length > 0) {
      const action = this.queue.shift()!;
      this.queuedBytes = Math.max(0, this.queuedBytes - action.queuedBytes);
      action.settle(outcome);
    }
  }
}
