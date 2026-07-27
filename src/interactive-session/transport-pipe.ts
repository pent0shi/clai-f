/**
 * Managed-pipe transport. Used directly for `terminalMode: "pipe"` and as the
 * single fallback for `"preferred"` when PTY capability is unavailable.
 *
 * This module never imports or probes PTY code, and it does not touch the spawn
 * options used by `shell.ts` or `jobs.ts`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { augmentedPathEnv } from "../os/command.js";
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
  pipeControlAction,
  type DeliveryResult,
  type LaunchRequest,
  type LaunchResult,
  type SessionTransport,
  type TransportOutput,
} from "./transport.js";
import type { ControlInput, ProcessOutcome } from "./types.js";

class PipeTransport implements SessionTransport {
  readonly kind = "pipe" as const;
  readonly pid: number;
  readonly processGroupId: number | undefined;
  readonly identity: string | undefined;

  private readonly outputListeners = new Set<(event: TransportOutput) => void>();
  private readonly exitListeners = new Set<(outcome: ProcessOutcome) => void>();
  private inputClosed = false;
  private exited = false;
  private disposed = false;
  private outputDrained = false;
  private resolveOutputDrain!: () => void;
  private readonly outputDrain = new Promise<void>((resolve) => {
    this.resolveOutputDrain = resolve;
  });

  constructor(private readonly child: ChildProcess) {
    this.pid = child.pid ?? -1;
    this.processGroupId = supportsProcessGroups() ? child.pid : undefined;
    this.identity = processIdentityTracker.capture(child.pid, { refresh: true });

    child.stdout?.on("data", (chunk: Buffer) => this.emitOutput("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.emitOutput("stderr", chunk));
    // A broken input pipe after the child exits is an expected race, not a crash.
    child.stdin?.on("error", () => undefined);
    child.on("exit", (code, signal) => {
      this.exited = true;
      const outcome: ProcessOutcome = {
        endedAt: Date.now(),
        ...(code !== null ? { exitCode: code } : {}),
        ...(signal ? { signal } : {}),
      };
      for (const listener of [...this.exitListeners]) listener(outcome);
    });
    child.once("close", () => {
      this.outputDrained = true;
      this.resolveOutputDrain();
    });
  }

  private emitOutput(stream: "stdout" | "stderr", chunk: Buffer): void {
    const event: TransportOutput = {
      stream,
      bytes: new Uint8Array(chunk),
      observedAt: Date.now(),
    };
    for (const listener of [...this.outputListeners]) listener(event);
  }

  async write(bytes: Uint8Array): Promise<DeliveryResult> {
    const stdin = this.child.stdin;
    if (!stdin || this.inputClosed || stdin.destroyed || this.exited) {
      return { status: "not-delivered", deliveredBytes: 0 };
    }
    return await new Promise<DeliveryResult>((resolve) => {
      let settled = false;
      const settle = (result: DeliveryResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      try {
        stdin.write(Buffer.from(bytes), (error) => {
          // The callback fires after the bytes leave our buffer. A late error
          // cannot prove whether the child observed them, so it is `unknown`.
          if (error) settle({ status: "unknown", deliveredBytes: bytes.length, cause: error });
          else settle({ status: "delivered", deliveredBytes: bytes.length });
        });
      } catch (error) {
        settle({ status: "not-delivered", deliveredBytes: 0, cause: error });
      }
    });
  }

  async control(action: ControlInput): Promise<DeliveryResult> {
    const mapped = pipeControlAction(action);
    if (mapped.kind === "unsupported") {
      return { status: "not-delivered", deliveredBytes: 0 };
    }
    if (mapped.kind === "bytes") return await this.write(mapped.bytes);
    if (mapped.kind === "close-input") return await this.closeInput();
    // Interrupt/suspend target the whole tree so a shell wrapper cannot swallow
    // the signal while the real workload keeps running.
    const outcome = terminateProcessTree(this.pid, {
      signal: mapped.signal,
      ...(this.processGroupId !== undefined ? { processGroupId: this.processGroupId } : {}),
    });
    return outcome === "failed"
      ? { status: "unknown", deliveredBytes: 0 }
      : { status: "delivered", deliveredBytes: 0 };
  }

  async closeInput(): Promise<DeliveryResult> {
    if (this.inputClosed) return { status: "delivered", deliveredBytes: 0 };
    this.inputClosed = true;
    try {
      this.child.stdin?.end();
      return { status: "delivered", deliveredBytes: 0 };
    } catch (error) {
      return { status: "unknown", deliveredBytes: 0, cause: error };
    }
  }

  pauseOutput(): void {
    this.child.stdout?.pause();
    this.child.stderr?.pause();
  }

  resumeOutput(): void {
    this.child.stdout?.resume();
    this.child.stderr?.resume();
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

  async waitForOutputDrain(): Promise<void> {
    if (this.outputDrained) return;
    await this.outputDrain;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.outputListeners.clear();
    this.exitListeners.clear();
    try {
      this.child.stdin?.destroy();
      this.child.stdout?.destroy();
      this.child.stderr?.destroy();
    } catch {
      // Streams may already be torn down by the exit path.
    }
    this.child.removeAllListeners();
    processIdentityTracker.forget(this.child.pid);
  }
}

/** Wait for the OS to confirm (or refuse) the spawn before reporting a launch. */
function waitForSpawn(child: ChildProcess): Promise<NodeJS.ErrnoException | undefined> {
  return new Promise((resolve) => {
    const onSpawn = (): void => {
      child.off("error", onError);
      resolve(undefined);
    };
    const onError = (error: Error): void => {
      child.off("spawn", onSpawn);
      resolve(error as NodeJS.ErrnoException);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

export async function startPipeTransport(
  request: LaunchRequest,
): Promise<LaunchResult> {
  const shell = resolveShell();
  if (!shell) {
    throw new LaunchFailure(
      "SHELL_NOT_FOUND",
      "No usable command shell was found for an interactive session.",
      false,
      false,
    );
  }
  const child = spawn(request.command, {
    cwd: request.cwd,
    shell,
    // POSIX children get their own group so cleanup can signal the whole tree.
    detached: supportsProcessGroups(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...(request.env ?? process.env), PATH: augmentedPathEnv() },
    windowsHide: true,
  });
  const error = await waitForSpawn(child);
  if (error) {
    try {
      child.kill();
    } catch {
      // Nothing started; there is no process to reap.
    }
    throw new LaunchFailure(
      error.code ?? "UNKNOWN",
      `Interactive session launch failed before spawn: ${error.code ?? "UNKNOWN"}.`,
      false,
      error.code === "ENOENT" || error.code === "EAGAIN",
    );
  }
  if (!child.pid) {
    throw new LaunchFailure(
      "NO_PID",
      "The interactive session process reported no process id after spawn.",
      false,
      true,
    );
  }
  return { transport: new PipeTransport(child) };
}
