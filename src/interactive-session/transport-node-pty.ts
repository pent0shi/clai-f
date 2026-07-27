/**
 * Optional PTY transport.
 *
 * `node-pty` is an optional dependency loaded through a lazy dynamic import so
 * an absent or unloadable native artifact degrades capability instead of failing
 * application startup. Capability is per-platform and only claimed after the
 * module actually loads in this packaged layout; the release pipeline must prove
 * load/spawn/resize/cleanup on a matching-target runner before advertising it.
 */

import { processIdentityTracker } from "../os/process-identity.js";
import {
  supportsProcessGroups,
  terminateProcessTree,
  type TreeSignalOutcome,
} from "../os/process-tree.js";
import { resolveShell } from "../tools/shell.js";
import type { Unsubscribe } from "./runtime.js";
import {
  LaunchFailure,
  ptyControlBytes,
  type DeliveryResult,
  type LaunchRequest,
  type LaunchResult,
  type PtyCapability,
  type SessionTransport,
  type TransportOutput,
} from "./transport.js";
import type {
  ControlInput,
  ProcessOutcome,
  TerminalDimensions,
} from "./types.js";

/** Minimal structural view of the parts of node-pty this adapter uses. */
export interface PtyProcessLike {
  readonly pid: number;
  onData(listener: (data: string | Buffer) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): {
    dispose(): void;
  };
  write(data: string): void;
  resize(columns: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
}

export interface NodePtyModuleLike {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      cwd: string;
      env: Record<string, string>;
      cols: number;
      rows: number;
      name?: string;
      useConpty?: boolean;
    },
  ): PtyProcessLike;
}

const MODULE_SPECIFIER = "node-pty";

let loadPromise: Promise<NodePtyModuleLike | undefined> | undefined;
let loadFailureReason: string | undefined;

/** Lazily load node-pty at most once per process. */
async function loadNodePty(): Promise<NodePtyModuleLike | undefined> {
  loadPromise ??= (async () => {
    try {
      // Indirect specifier keeps the optional dependency out of the static
      // import graph so startup, pipe mode, and legacy tools never load it.
      const loaded = (await import(/* @vite-ignore */ MODULE_SPECIFIER)) as
        | NodePtyModuleLike
        | { default: NodePtyModuleLike };
      const module = "spawn" in loaded ? loaded : loaded.default;
      if (typeof module?.spawn !== "function") {
        loadFailureReason = "node-pty loaded without a usable spawn export";
        return undefined;
      }
      return module;
    } catch (error) {
      loadFailureReason =
        error instanceof Error && error.message.includes("Cannot find module")
          ? "node-pty is not installed for this target"
          : "node-pty native module failed to load for this target";
      return undefined;
    }
  })();
  return await loadPromise;
}

export async function probePtyCapability(
  platform: NodeJS.Platform = process.platform,
): Promise<PtyCapability> {
  const module = await loadNodePty();
  if (module) return { available: true, platform };
  return {
    available: false,
    platform,
    reason: loadFailureReason ?? "PTY capability is unavailable on this target",
  };
}

/** Test seam: reset the memoized load so capability can be re-evaluated. */
export function resetPtyCapabilityCache(): void {
  loadPromise = undefined;
  loadFailureReason = undefined;
}

class NodePtyTransport implements SessionTransport {
  readonly kind = "pty" as const;
  readonly pid: number;
  readonly processGroupId: number | undefined;
  readonly identity: string | undefined;

  private readonly outputListeners = new Set<(event: TransportOutput) => void>();
  private readonly exitListeners = new Set<(outcome: ProcessOutcome) => void>();
  private readonly subscriptions: Array<{ dispose(): void }> = [];
  private inputClosed = false;
  private exited = false;
  private disposed = false;

  constructor(private readonly pty: PtyProcessLike) {
    this.pid = pty.pid;
    // A PTY child leads its own session, so the pid doubles as the group id.
    this.processGroupId = supportsProcessGroups() ? pty.pid : undefined;
    this.identity = processIdentityTracker.capture(pty.pid, { refresh: true });

    this.subscriptions.push(
      pty.onData((data) => {
        const bytes =
          typeof data === "string"
            ? new Uint8Array(Buffer.from(data, "utf8"))
            : new Uint8Array(data);
        const event: TransportOutput = {
          stream: "terminal",
          bytes,
          observedAt: Date.now(),
        };
        for (const listener of [...this.outputListeners]) listener(event);
      }),
    );
    this.subscriptions.push(
      pty.onExit(({ exitCode, signal }) => {
        this.exited = true;
        const outcome: ProcessOutcome = {
          endedAt: Date.now(),
          exitCode,
          ...(signal !== undefined ? { signal: String(signal) } : {}),
        };
        for (const listener of [...this.exitListeners]) listener(outcome);
      }),
    );
  }

  async write(bytes: Uint8Array): Promise<DeliveryResult> {
    if (this.inputClosed || this.exited) {
      return { status: "not-delivered", deliveredBytes: 0 };
    }
    try {
      // node-pty accepts latin1-safe strings; binary-preserving round trip.
      this.pty.write(Buffer.from(bytes).toString("binary"));
      return { status: "delivered", deliveredBytes: bytes.length };
    } catch (error) {
      // A throwing master write cannot prove whether the child saw the bytes.
      return { status: "unknown", deliveredBytes: 0, cause: error };
    }
  }

  async control(action: ControlInput): Promise<DeliveryResult> {
    const bytes = ptyControlBytes(action);
    if (!bytes) return { status: "not-delivered", deliveredBytes: 0 };
    return await this.write(bytes);
  }

  /**
   * A pseudoterminal has no portable half-close: send the platform EOF sequence
   * once, then treat manager-level input as permanently closed.
   */
  async closeInput(): Promise<DeliveryResult> {
    if (this.inputClosed) return { status: "delivered", deliveredBytes: 0 };
    const bytes = ptyControlBytes("eof");
    const result = bytes
      ? await this.write(bytes)
      : ({ status: "delivered", deliveredBytes: 0 } as const);
    this.inputClosed = true;
    return result;
  }

  async resize(dimensions: TerminalDimensions): Promise<void> {
    this.pty.resize(dimensions.columns, dimensions.rows);
  }

  pauseOutput(): void {
    this.pty.pause();
  }

  resumeOutput(): void {
    this.pty.resume();
  }

  async requestTreeTermination(kind: "graceful" | "forceful"): Promise<TreeSignalOutcome> {
    return terminateProcessTree(this.pid, {
      signal: kind === "graceful" ? "SIGTERM" : "SIGKILL",
      ...(this.processGroupId !== undefined ? { processGroupId: this.processGroupId } : {}),
    });
  }

  onOutput(listener: (event: TransportOutput) => void): Unsubscribe {
    this.outputListeners.add(listener);
    return () => {
      this.outputListeners.delete(listener);
    };
  }

  onExit(listener: (outcome: ProcessOutcome) => void): Unsubscribe {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.outputListeners.clear();
    this.exitListeners.clear();
    for (const subscription of this.subscriptions) {
      try {
        subscription.dispose();
      } catch {
        // Disposing an already-exited pty is not an error.
      }
    }
    this.subscriptions.length = 0;
    processIdentityTracker.forget(this.pid);
  }
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

export interface PtyStartOverrides {
  readonly module?: NodePtyModuleLike | undefined;
  readonly shell?: string | null | undefined;
}

export async function startPtyTransport(
  request: LaunchRequest & { dimensions: TerminalDimensions },
  overrides: PtyStartOverrides = {},
): Promise<LaunchResult> {
  const module = overrides.module ?? await loadNodePty();
  if (!module) {
    throw new LaunchFailure(
      "PTY_UNAVAILABLE",
      loadFailureReason ?? "PTY capability is unavailable on this target.",
      false,
      false,
    );
  }
  const shell = overrides.shell === undefined ? resolveShell() : overrides.shell;
  if (!shell) {
    throw new LaunchFailure(
      "SHELL_NOT_FOUND",
      "No usable command shell was found for an interactive session.",
      false,
      false,
    );
  }
  let pty: PtyProcessLike | undefined;
  try {
    pty = module.spawn(
      shell,
      process.platform === "win32" ? ["/c", request.command] : ["-c", request.command],
      {
        cwd: request.cwd,
        env: stringEnv({ ...(request.env ?? process.env), TERM: "xterm-256color" }),
        cols: request.dimensions.columns,
        rows: request.dimensions.rows,
        name: "xterm-256color",
      },
    );
    if (!pty.pid) throw new Error("node-pty returned no pid");
    return { transport: new NodePtyTransport(pty) };
  } catch (error) {
    // Release the native terminal allocated before launch confirmation.
    if (pty) {
      try {
        pty.kill();
      } catch {
        // Best effort: the master may already be closed.
      }
    }
    throw new LaunchFailure(
      "PTY_SPAWN_FAILED",
      `PTY allocation failed before launch confirmation: ${
        error instanceof Error ? error.name : "unknown"
      }.`,
      false,
      false,
    );
  }
}
