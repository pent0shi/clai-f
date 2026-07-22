import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, type WriteStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { ToolResult } from "../types.js";
import { redactSecrets } from "../llm/provider.js";
import { safeCwd } from "../os/cwd.js";
import { getJobsDir } from "../store/paths.js";
import { resolveShell } from "./shell.js";

export type JobStatus = "starting" | "running" | "exited" | "failed" | "stopping" | "killed" | "lost";
export type JobTerminalStatus = Exclude<JobStatus, "starting" | "running" | "stopping">;

export interface JobArtifactReceipt {
  path: string;
  chunks: string[];
  bytes: number;
  droppedBytes: number;
  redacted: boolean;
  sha256: string;
}

export type JobMonitorMetadata = Record<string, unknown>;

export interface JobLinkMetadata {
  taskId?: string | undefined;
  parentTaskId?: string | undefined;
  wakeOnCompletion?: boolean | undefined;
  monitor?: JobMonitorMetadata | undefined;
  /**
   * Opt-in delegation to the Responder: fire-and-continue, plan subtask +
   * auto-wake on completion, and inclusion in the Responder inbox/UI. When
   * false/absent the job is a plain background job the agent polls itself
   * (shell.jobs/shell.tail) exactly as before Responder existed.
   */
  responder?: boolean | undefined;
}

/**
 * durable  — shell.start / auto-backgrounded servers (listed by shell.jobs, persisted)
 * ephemeral — per-tool stall tracking in the agent runner (never listed, never persisted)
 */
export type JobKind = "durable" | "ephemeral";

export interface BackgroundJob extends JobLinkMetadata {
  id: string;
  command: string;
  commandDisplay: string;
  cwd: string;
  pid?: number | undefined;
  processGroupId?: number | undefined;
  processIdentity?: string | undefined;
  status: JobStatus;
  startedAt: string;
  heartbeatAt?: string | undefined;
  endedAt?: string | undefined;
  exitCode?: number | undefined;
  signal?: string | undefined;
  artifactPath: string;
  stdoutArtifact: string;
  stderrArtifact: string;
  artifacts: { stdout: JobArtifactReceipt; stderr: JobArtifactReceipt };
  redactionProfile: string;
  ownerSessionId: string;
  /** Default durable for registry records; ephemeral for tool-stall tracking. */
  kind?: JobKind | undefined;
  name?: string | undefined;
  authorization?: { target: string; expiresAt?: string | undefined } | undefined;
  /** Optional execution deadline for finite durable jobs. */
  timeoutAt?: string | undefined;
}

export function formatJobElapsed(
  job: Pick<BackgroundJob, "startedAt" | "endedAt">,
  now = Date.now(),
): string {
  const startedAt = Date.parse(job.startedAt);
  const endedAt = job.endedAt ? Date.parse(job.endedAt) : now;
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return "unknown";
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${seconds % 60}s`;
}

export interface ResponderNotification {
  id: string;
  ownerSessionId: string;
  jobId: string;
  taskId?: string | undefined;
  parentTaskId?: string | undefined;
  status: JobTerminalStatus;
  createdAt: string;
  startedAt: string;
  endedAt: string;
  exitCode?: number | undefined;
  signal?: string | undefined;
  stdoutArtifact: JobArtifactReceipt;
  stderrArtifact: JobArtifactReceipt;
  commandDisplay: string;
  wakeOnCompletion: boolean;
  responder: boolean;
  monitor?: JobMonitorMetadata | undefined;
  deliveredAt?: string | undefined;
  analyzedAt?: string | undefined;
  acknowledgedAt?: string | undefined;
}

export type JobManagerChange =
  | { type: "job"; jobId: string }
  | { type: "notification"; jobId: string; notificationId: string };
export type JobManagerListener = (change: JobManagerChange) => void;

interface PersistedRegistryV1 { schemaVersion: 1; jobs: BackgroundJob[] }
interface PersistedRegistryV2 {
  schemaVersion: 2;
  jobs: BackgroundJob[];
  notifications: ResponderNotification[];
}
type PersistedRegistry = PersistedRegistryV1 | PersistedRegistryV2;
interface TailCursor { stream?: "stdout" | "stderr" | "combined"; offset?: number; bytes?: number }

/** Safe detached process form. stdinText is written once, then stdin is closed. */
export interface BackgroundSpawnSpec {
  command: string;
  argv: string[];
  stdinText?: string | undefined;
  /** Non-secret display text persisted in the registry and artifacts. */
  display?: string | undefined;
}

export interface StartJobOptions extends JobLinkMetadata {
  cwd?: string | undefined;
  name?: string | undefined;
  ownerSessionId?: string | undefined;
  profile?: string | undefined;
  estimatedSeconds?: number | undefined;
  /** Stop this finite job after the selected duration. */
  timeoutMs?: number | undefined;
  authorization?: { target: string; expiresAt?: string | undefined } | undefined;
}

function displayArg(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value)
    ? value
    : JSON.stringify(value);
}

function commandDisplay(command: string | BackgroundSpawnSpec): string {
  if (typeof command === "string") return command;
  return command.display ?? [command.command, ...command.argv].map(displayArg).join(" ");
}

const PER_FILE_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const DEFAULT_TAIL_BYTES = 8_000;
const REGISTRY_FILE = "registry-v1.json";
const TRANSIENT_V2_REGISTRY_FILE = "registry-v2.json";
/** Cap durable terminal jobs kept on disk/in memory (per process). */
const MAX_DURABLE_TERMINAL_JOBS = 80;
/** Drop terminal durable jobs older than this on load/list. */
const TERMINAL_JOB_MAX_AGE_MS = 48 * 60 * 60 * 1000;
/** Max lines shell.jobs returns to the model (running first, then recent). */
const LIST_JOBS_MAX_LINES = 40;
/** Coalesce window for chatty stdout/stderr progress persistence + UI events. */
const PROGRESS_FLUSH_MS = 250;

/**
 * Number of trailing bytes in `buf` that form an incomplete multi-byte UTF-8
 * sequence (a lead byte whose continuation bytes were cut off by the read
 * boundary). Returns 0 if the buffer already ends on a complete character.
 */
function trailingIncompleteBytes(buf: Buffer): number {
  const len = buf.length;
  for (let back = 1; back <= 3 && back <= len; back++) {
    const byte = buf[len - back]!;
    if ((byte & 0xc0) === 0x80) continue; // continuation byte, keep walking back
    let expectedLen = 1;
    if ((byte & 0xe0) === 0xc0) expectedLen = 2;
    else if ((byte & 0xf0) === 0xe0) expectedLen = 3;
    else if ((byte & 0xf8) === 0xf0) expectedLen = 4;
    return expectedLen > back ? back : 0;
  }
  return 0;
}

function processAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function processIdentity(pid: number | undefined): string | undefined {
  if (!pid || process.platform === "win32") return undefined;
  try {
    // Start time only: it is invariant for a pid's lifetime and changes on
    // reuse, so it is a sufficient pid-reuse guard. The command line is
    // deliberately excluded — `sh -c "cmd"` execs into `cmd`, mutating
    // `ps command=` mid-run, which made a live job fail its OWN identity check
    // (stop refused with "process identity no longer matches", liveness falsely
    // marked lost, and double-Esc cancel unable to kill the process).
    const value = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value ? createHash("sha256").update(value).digest("hex") : undefined;
  } catch { return undefined; }
}

/**
 * Heuristic for legacy registry rows that were actually agent tool-stall
 * trackers (commandDisplay = "fs.list /path", "shell.jobs {}", …), not real
 * shell.start / auto-backgrounded processes.
 */
function looksLikeEphemeralToolTrack(job: BackgroundJob): boolean {
  if (job.kind === "ephemeral") return true;
  const cmd = (job.commandDisplay || job.command || "").trim();
  // Real OS commands rarely look like "tool.name …" dotted tool registry names.
  if (/^(fs|shell|tool|web|http|net|pdf|image|pkg|dns|whois|plan|task|pentest|sysinfo)\.[a-zA-Z]+(\s|$)/.test(cmd)) {
    return true;
  }
  // Empty artifact paths = never a real background process capture.
  if (!job.stdoutArtifact && !job.artifactPath && !job.pid) return true;
  return false;
}

class RotatingRedactedWriter {
  private stream: WriteStream | undefined;
  private streamDone: Promise<void> | undefined;
  private readonly completedStreams: Promise<void>[] = [];
  private index = 0;
  private currentBytes = 0;
  private hash = createHash("sha256");
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private closePromise: Promise<void> | undefined;
  private writeError: Error | undefined;
  private closed = false;
  private acceptedBytes: number;
  private static readonly REDACTION_OVERLAP_CHARS = 4096;

  constructor(private readonly receipt: JobArtifactReceipt) {
    this.acceptedBytes = receipt.bytes;
  }

  append(raw: Buffer | string): void {
    if (this.closed) throw new Error("Cannot append to a closed job artifact");
    this.pending += Buffer.isBuffer(raw) ? this.decoder.write(raw) : raw;
    const lastNewline = this.pending.lastIndexOf("\n");
    if (lastNewline >= 0) {
      this.writeRedacted(this.pending.slice(0, lastNewline + 1));
      this.pending = this.pending.slice(lastNewline + 1);
    }
    if (this.pending.length <= RotatingRedactedWriter.REDACTION_OVERLAP_CHARS) return;
    const flushLength = this.pending.length - RotatingRedactedWriter.REDACTION_OVERLAP_CHARS;
    this.writeRedacted(this.pending.slice(0, flushLength));
    this.pending = this.pending.slice(flushLength);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.pending += this.decoder.end();
    if (this.pending) this.writeRedacted(this.pending);
    this.pending = "";
    this.closed = true;
    this.finishCurrentStream();
    this.closePromise = Promise.all(this.completedStreams).then(() => {
      if (this.writeError) throw this.writeError;
    });
    return this.closePromise;
  }

  private writeRedacted(source: string): void {
    const safe = redactSecrets(source);
    if (safe !== source) this.receipt.redacted = true;
    let data = Buffer.from(safe, "utf8");
    const remaining = Math.max(0, MAX_STREAM_BYTES - this.acceptedBytes);
    if (data.length > remaining) {
      this.receipt.droppedBytes += data.length - remaining;
      data = data.subarray(0, remaining);
    }
    this.acceptedBytes += data.length;
    while (data.length > 0) {
      if (!this.stream || this.currentBytes >= PER_FILE_BYTES) this.rotate();
      const room = PER_FILE_BYTES - this.currentBytes;
      const part = data.subarray(0, room);
      const stream = this.stream!;
      stream.write(part, (error) => {
        if (error) {
          this.writeError ??= error;
          return;
        }
        this.hash.update(part);
        this.receipt.bytes += part.length;
        this.receipt.sha256 = this.hash.copy().digest("hex");
      });
      this.currentBytes += part.length;
      data = data.subarray(part.length);
    }
  }

  private finishCurrentStream(): void {
    if (!this.stream || !this.streamDone) return;
    const stream = this.stream;
    const done = this.streamDone;
    this.stream = undefined;
    this.streamDone = undefined;
    stream.end();
    this.completedStreams.push(done);
  }

  private rotate(): void {
    this.finishCurrentStream();
    const path = this.index === 0 ? this.receipt.path : `${this.receipt.path}.${this.index}`;
    this.index += 1;
    this.currentBytes = 0;
    this.receipt.chunks.push(path);
    const stream = createWriteStream(path, { flags: "w", mode: 0o600 });
    this.stream = stream;
    this.streamDone = new Promise<void>((resolve) => {
      stream.once("finish", resolve);
      stream.once("error", (error) => {
        this.writeError ??= error;
        resolve();
      });
    });
  }
}

export class JobManager {
  private jobs = new Map<string, BackgroundJob>();
  private notifications = new Map<string, ResponderNotification>();
  private processes = new Map<string, ChildProcess>();
  private writers = new Map<string, { stdout: RotatingRedactedWriter; stderr: RotatingRedactedWriter }>();
  private abortControllers = new Map<string, AbortController>();
  private deadlineTimers = new Map<string, NodeJS.Timeout>();
  private finalizations = new Map<string, Promise<boolean>>();
  private listeners = new Set<JobManagerListener>();
  private registryRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly registryPath: string;
  private readonly transientV2RegistryPath: string;

  constructor(private readonly jobsDir = getJobsDir()) {
    this.registryPath = join(this.jobsDir, REGISTRY_FILE);
    this.transientV2RegistryPath = join(this.jobsDir, TRANSIENT_V2_REGISTRY_FILE);
    this.loadAndReconcile();
  }

  private isDurable(job: BackgroundJob): boolean {
    return job.kind !== "ephemeral";
  }

  private isLive(job: BackgroundJob): boolean {
    return (
      job.status === "running" ||
      job.status === "starting" ||
      job.status === "stopping"
    );
  }

  private isTerminalStatus(status: JobStatus): status is JobTerminalStatus {
    return status === "exited" || status === "failed" || status === "killed" || status === "lost";
  }

  private emit(change: JobManagerChange): void {
    for (const listener of this.listeners) {
      try { listener(change); } catch { /* listeners cannot break job persistence */ }
    }
  }

  subscribe(listener: JobManagerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private matchesSession(
    job: BackgroundJob,
    sessionId: string | undefined,
  ): boolean {
    if (!sessionId) return true;
    return job.ownerSessionId === sessionId;
  }

  private clearJobDeadline(id: string): void {
    const timer = this.deadlineTimers.get(id);
    if (timer) clearTimeout(timer);
    this.deadlineTimers.delete(id);
  }

  private cloneReceipt(receipt: JobArtifactReceipt): JobArtifactReceipt {
    return { ...receipt, chunks: [...receipt.chunks] };
  }

  private notificationForJob(jobId: string): ResponderNotification | undefined {
    return [...this.notifications.values()].find((notification) => notification.jobId === jobId);
  }

  private ensureCompletionNotification(job: BackgroundJob): {
    notification?: ResponderNotification;
    created: boolean;
    updated: boolean;
  } {
    if (
      !this.isDurable(job) ||
      !this.isTerminalStatus(job.status) ||
      !job.responder
    ) {
      return { created: false, updated: false };
    }
    const existing = this.notificationForJob(job.id);
    const endedAt = job.endedAt ?? new Date().toISOString();
    const stdoutArtifact = this.cloneReceipt(job.artifacts.stdout);
    const stderrArtifact = this.cloneReceipt(job.artifacts.stderr);
    const completionChanged = Boolean(
      existing &&
        (existing.status !== job.status ||
          existing.endedAt !== endedAt ||
          existing.exitCode !== job.exitCode ||
          existing.signal !== job.signal ||
          JSON.stringify(existing.stdoutArtifact) !==
            JSON.stringify(stdoutArtifact) ||
          JSON.stringify(existing.stderrArtifact) !==
            JSON.stringify(stderrArtifact)),
    );
    const reopenSettlement = Boolean(
      existing?.acknowledgedAt && completionChanged,
    );
    const notification: ResponderNotification = {
      id:
        existing?.id ??
        `completion:${createHash("sha256").update(`${job.ownerSessionId}\0${job.id}\0${job.startedAt}`).digest("hex").slice(0, 24)}`,
      ownerSessionId: job.ownerSessionId,
      jobId: job.id,
      status: job.status,
      createdAt: existing?.createdAt ?? endedAt,
      startedAt: job.startedAt,
      endedAt,
      stdoutArtifact,
      stderrArtifact,
      commandDisplay: job.commandDisplay,
      wakeOnCompletion: job.wakeOnCompletion ?? false,
      responder: job.responder ?? false,
      ...(job.taskId ? { taskId: job.taskId } : {}),
      ...(job.parentTaskId ? { parentTaskId: job.parentTaskId } : {}),
      ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
      ...(job.signal !== undefined ? { signal: job.signal } : {}),
      ...(job.monitor !== undefined ? { monitor: job.monitor } : {}),
      ...(existing?.deliveredAt ? { deliveredAt: existing.deliveredAt } : {}),
      ...((existing?.analyzedAt ?? existing?.acknowledgedAt)
        ? { analyzedAt: existing?.analyzedAt ?? existing?.acknowledgedAt }
        : {}),
      ...(!reopenSettlement && existing?.acknowledgedAt
        ? { acknowledgedAt: existing.acknowledgedAt }
        : {}),
    };
    const updated = Boolean(
      existing && JSON.stringify(existing) !== JSON.stringify(notification),
    );
    this.notifications.set(notification.id, notification);
    return { notification, created: !existing, updated };
  }

  private async closeWriters(id: string): Promise<boolean> {
    const writers = this.writers.get(id);
    if (!writers) return true;
    const results = await Promise.allSettled([writers.stdout.close(), writers.stderr.close()]);
    this.writers.delete(id);
    return results.every((result) => result.status === "fulfilled");
  }

  private async finalizeJob(
    job: BackgroundJob,
    status: JobTerminalStatus,
    details: { exitCode?: number | undefined; signal?: string | undefined; endedAt?: string | undefined } = {},
  ): Promise<boolean> {
    const pending = this.finalizations.get(job.id);
    if (pending) return pending;
    const correctsLost = job.status === "lost" && status !== "lost";
    if (this.isTerminalStatus(job.status) && !correctsLost) {
      const completion = this.ensureCompletionNotification(job);
      if (
        (!completion.created && !completion.updated) ||
        !completion.notification
      ) {
        return true;
      }
      const persisted = this.persistSync();
      if (!persisted) this.scheduleRegistryRetry();
      this.emit({ type: "job", jobId: job.id });
      this.emit({
        type: "notification",
        jobId: job.id,
        notificationId: completion.notification.id,
      });
      return persisted;
    }
    const finalization = (async (): Promise<boolean> => {
      this.clearJobDeadline(job.id);
      const streamsFlushed = await this.closeWriters(job.id);
      job.status = streamsFlushed ? status : "failed";
      if (details.exitCode !== undefined) job.exitCode = details.exitCode;
      if (!streamsFlushed && (job.exitCode === undefined || job.exitCode === 0)) {
        job.exitCode = 1;
      }
      if (details.signal !== undefined) job.signal = details.signal;
      job.endedAt = details.endedAt ?? new Date().toISOString();
      this.abortControllers.delete(job.id);
      this.processes.delete(job.id);
      const completion = this.ensureCompletionNotification(job);
      this.pruneTerminalJobs();
      const persisted = this.persistSync();
      if (!persisted) this.scheduleRegistryRetry();
      this.emit({ type: "job", jobId: job.id });
      if (
        (completion.created || completion.updated) &&
        completion.notification
      ) {
        this.emit({
          type: "notification",
          jobId: job.id,
          notificationId: completion.notification.id,
        });
      }
      return persisted;
    })();
    this.finalizations.set(job.id, finalization);
    try {
      return await finalization;
    } finally {
      this.finalizations.delete(job.id);
    }
  }

  /** Reconcile a restored process that no longer has a ChildProcess close event. */
  private refreshJobLiveness(job: BackgroundJob): void {
    if (!this.isLive(job) || this.processes.has(job.id)) return;
    const identity = processIdentity(job.pid);
    if (
      processAlive(job.pid) &&
      identity &&
      job.processIdentity &&
      identity === job.processIdentity
    ) {
      return;
    }
    job.status = "lost";
    job.endedAt = new Date().toISOString();
    this.clearJobDeadline(job.id);
    const completion = this.ensureCompletionNotification(job);
    this.pruneTerminalJobs();
    if (!this.persistSync()) this.scheduleRegistryRetry();
    this.emit({ type: "job", jobId: job.id });
    if (
      (completion.created || completion.updated) &&
      completion.notification
    ) {
      this.emit({
        type: "notification",
        jobId: job.id,
        notificationId: completion.notification.id,
      });
    }
  }

  /** Arm or restore a persisted finite-job deadline. */
  private scheduleJobDeadline(job: BackgroundJob): void {
    this.clearJobDeadline(job.id);
    if (!job.timeoutAt || !this.isLive(job)) return;
    const timeoutAt = Date.parse(job.timeoutAt);
    if (!Number.isFinite(timeoutAt)) return;
    const timer = setTimeout(() => {
      this.deadlineTimers.delete(job.id);
      this.refreshJobLiveness(job);
      if (this.isLive(job)) void this.stopJob(job.id, { graceMs: 1_000 });
    }, Math.max(0, timeoutAt - Date.now()));
    timer.unref?.();
    this.deadlineTimers.set(job.id, timer);
  }

  /**
   * Register an in-flight tool for stall tracking only.
   * Never appears in shell.jobs and never touches the durable registry.
   */
  registerJob(id: string, job: BackgroundJob, ac?: AbortController, child?: ChildProcess): void {
    const tracked: BackgroundJob = { ...job, kind: job.kind ?? "ephemeral" };
    this.jobs.set(id, tracked);
    if (ac) this.abortControllers.set(id, ac);
    if (child) this.processes.set(id, child);
    if (this.isDurable(tracked)) this.persistSync();
    this.emit({ type: "job", jobId: id });
  }

  updateJobStatus(id: string, status: JobStatus, exitCode?: number): void {
    const job = this.jobs.get(id);
    if (!job) return;
    if (this.isDurable(job) && this.isTerminalStatus(status)) {
      void this.finalizeJob(job, status, { ...(exitCode !== undefined ? { exitCode } : {}) });
      return;
    }
    job.status = status;
    if (exitCode !== undefined) job.exitCode = exitCode;
    if (!this.isLive(job)) job.endedAt = new Date().toISOString();
    this.abortControllers.delete(id);
    this.processes.delete(id);
    if (!this.isLive(job)) this.clearJobDeadline(id);
    if (!this.isDurable(job) && !this.isLive(job)) {
      this.jobs.delete(id);
      this.emit({ type: "job", jobId: id });
      return;
    }
    if (this.isDurable(job)) {
      this.pruneTerminalJobs();
      this.persistSync();
    }
    this.emit({ type: "job", jobId: id });
  }

  async startJob(command: string | BackgroundSpawnSpec, options?: StartJobOptions): Promise<ToolResult> {
    if (options?.authorization?.expiresAt) {
      const expiry = Date.parse(options.authorization.expiresAt);
      if (Number.isFinite(expiry) && expiry <= Date.now()) {
        return { ok: false, output: `Engagement authorization for ${options.authorization.target} has expired.`, exitCode: 1 };
      }
    }
    const id = randomUUID().slice(0, 8);
    const cwd = options?.cwd ?? safeCwd();
    try {
      const cwdStat = await stat(cwd);
      if (!cwdStat.isDirectory()) {
        return {
          ok: false,
          output:
            `Background command launch error [INVALID_CWD]: working directory is not a directory.\n` +
            `cwd=${JSON.stringify(cwd)}\nThe command did not start; correct shell.start cwd instead of changing command syntax.`,
          exitCode: 127,
        };
      }
    } catch (error) {
      return {
        ok: false,
        output:
          `Background command launch error [INVALID_CWD]: ${error instanceof Error ? error.message : String(error)}\n` +
          `cwd=${JSON.stringify(cwd)}\nThe command did not start; correct shell.start cwd instead of changing command syntax.`,
        exitCode: 127,
      };
    }
    const shell = typeof command === "string" ? resolveShell() : undefined;
    if (typeof command === "string" && !shell) {
      return {
        ok: false,
        output:
          `Background command launch error [SHELL_NOT_FOUND]: no usable command shell was found.\n` +
          `cwd=${JSON.stringify(cwd)}\nThe command did not start.`,
        exitCode: 127,
      };
    }
    await mkdir(this.jobsDir, { recursive: true });
    const prefix = `${new Date().toISOString().replace(/[:.]/g, "-")}-${id}`;
    const stdoutArtifact = join(this.jobsDir, `${prefix}.stdout.log`);
    const stderrArtifact = join(this.jobsDir, `${prefix}.stderr.log`);
    const makeReceipt = (path: string): JobArtifactReceipt => ({ path, chunks: [], bytes: 0, droppedBytes: 0, redacted: false, sha256: "" });
    const safeDisplay = redactSecrets(commandDisplay(command));
    const monitor = options?.monitor !== undefined || options?.profile !== undefined || options?.estimatedSeconds !== undefined
      ? {
          ...(options?.monitor ?? {}),
          ...(options?.profile !== undefined ? { profile: options.profile } : {}),
          ...(options?.estimatedSeconds !== undefined ? { estimatedSeconds: options.estimatedSeconds } : {}),
        }
      : undefined;
    const job: BackgroundJob = {
      id,
      command: safeDisplay,
      commandDisplay: safeDisplay,
      cwd,
      status: "starting",
      startedAt: new Date().toISOString(),
      artifactPath: stdoutArtifact,
      stdoutArtifact,
      stderrArtifact,
      artifacts: { stdout: makeReceipt(stdoutArtifact), stderr: makeReceipt(stderrArtifact) },
      redactionProfile: "provider-secrets-v1",
      ownerSessionId: options?.ownerSessionId ?? "unknown",
      kind: "durable",
      ...(options?.name ? { name: options.name } : {}),
      ...(options?.taskId ? { taskId: options.taskId } : {}),
      ...(options?.parentTaskId ? { parentTaskId: options.parentTaskId } : {}),
      ...(options?.wakeOnCompletion !== undefined ? { wakeOnCompletion: options.wakeOnCompletion } : {}),
      ...(options?.responder !== undefined ? { responder: options.responder } : {}),
      ...(monitor !== undefined ? { monitor } : {}),
      ...(options?.timeoutMs !== undefined
        ? {
            timeoutAt: new Date(
              Date.now() + Math.max(1_000, Math.floor(options.timeoutMs)),
            ).toISOString(),
          }
        : {}),
      ...(options?.authorization ? { authorization: options.authorization } : {}),
    };
    this.jobs.set(id, job);
    this.pruneTerminalJobs();
    try {
      await this.persist();
    } catch {
      this.jobs.delete(id);
      return {
        ok: false,
        output: "Background command launch error [PERSIST_FAILED]: could not persist the job registry; the command was not started.",
        exitCode: 1,
      };
    }
    this.emit({ type: "job", jobId: id });

    let launchConfirmed = false;
    try {
      const detached = process.platform !== "win32";
      const spawnChild = (): ChildProcess =>
        typeof command === "string"
          ? spawn(command, {
              cwd,
              detached,
              shell: shell!,
              stdio: ["ignore", "pipe", "pipe"],
            })
          : spawn(command.command, command.argv, {
              cwd,
              detached,
              shell: false,
              stdio: [command.stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
            });
      let child = spawnChild();
      const stdout = new RotatingRedactedWriter(job.artifacts.stdout);
      const stderr = new RotatingRedactedWriter(job.artifacts.stderr);
      this.writers.set(id, { stdout, stderr });
      stdout.append(`$ ${job.commandDisplay}\n\n`);

      // A ChildProcess object is returned before the OS confirms launch. Wait
      // for `spawn` (or `error`) so shell.start never reports a phantom running
      // job whose pid is absent and whose eventual status is opaque exit=-2.
      const waitForLaunch = (
        candidate: ChildProcess,
      ): Promise<NodeJS.ErrnoException | undefined> =>
        new Promise((resolve) => {
          const onSpawn = (): void => {
            candidate.off("error", onError);
            resolve(undefined);
          };
          const onError = (error: Error): void => {
            candidate.off("spawn", onSpawn);
            resolve(error as NodeJS.ErrnoException);
          };
          candidate.once("spawn", onSpawn);
          candidate.once("error", onError);
        });
      let launchError = await waitForLaunch(child);
      let launchRetried = false;
      if (
        launchError?.code === "ENOENT" &&
        typeof command === "string" &&
        existsSync(shell!) &&
        existsSync(cwd)
      ) {
        // Safe: the first child never started, so no command side effects are
        // duplicated. Own this transient retry in the runtime, not the model.
        launchRetried = true;
        await new Promise((resolve) => setTimeout(resolve, 75));
        child = spawnChild();
        launchError = await waitForLaunch(child);
      }
      if (launchError) {
        const target = typeof command === "string" ? shell! : command.command;
        const code = launchError.code ?? "UNKNOWN";
        const fields = [
          `target=${JSON.stringify(target)}`,
          `cwd=${JSON.stringify(cwd)}`,
          launchError.syscall ? `syscall=${JSON.stringify(launchError.syscall)}` : undefined,
          launchError.path ? `path=${JSON.stringify(launchError.path)}` : undefined,
        ].filter((value): value is string => Boolean(value));
        const detail =
          `${launchRetried ? "Automatic retry after a transient launch ENOENT also failed.\n" : ""}` +
          `Background command launch error [${code}]: ${launchError.message}\n` +
          `${fields.join("; ")}\n` +
          "The command did not start. Do not rewrite its syntax to work around this infrastructure error; verify the target and cwd.";
        stderr.append(`${detail}\n`);
        await this.finalizeJob(job, "failed", { exitCode: 127 });
        return {
          ok: false,
          output: detail,
          exitCode: 127,
          outputPath: stdoutArtifact,
          backgroundJob: {
            id,
            status: "failed",
            exitCode: 127,
            artifactPath: stdoutArtifact,
            nextOffset: 0,
          },
        };
      }
      launchConfirmed = true;

      // Sensitive input is never copied into the job record, display, logs, or
      // artifacts. Write it once only after launch has been confirmed.
      if (typeof command !== "string" && command.stdinText !== undefined) {
        child.stdin?.end(command.stdinText);
      }
      job.pid = child.pid;
      job.processGroupId = detached ? child.pid : undefined;
      job.status = "running";
      job.heartbeatAt = new Date().toISOString();
      job.processIdentity = processIdentity(child.pid);
      this.processes.set(id, child);
      this.writers.set(id, { stdout, stderr });
      const expiresAt = options?.authorization?.expiresAt ? Date.parse(options.authorization.expiresAt) : Number.NaN;
      const expiryTimer = Number.isFinite(expiresAt) && expiresAt > Date.now()
        ? setTimeout(() => { void this.stopJob(id, { graceMs: 1_000 }); }, expiresAt - Date.now())
        : undefined;
      expiryTimer?.unref?.();
      this.scheduleJobDeadline(job);
      let lastProgressFlush = 0;
      let progressDirty = false;
      let progressTimer: ReturnType<typeof setTimeout> | undefined;
      const flushProgress = (): void => {
        progressDirty = false;
        lastProgressFlush = Date.now();
        this.persistSync();
        this.emit({ type: "job", jobId: id });
      };
      // Coalesce high-frequency stdout/stderr chunks: a chatty job (scanner,
      // dev server) must not force a registry write + UI rerender per data
      // event. Flush at most every PROGRESS_FLUSH_MS, with a trailing flush so
      // the last chunk before a quiet gap is never dropped. Terminal
      // finalize/close always persists authoritatively and clears the timer.
      const scheduleProgressFlush = (): void => {
        const elapsed = Date.now() - lastProgressFlush;
        if (elapsed >= PROGRESS_FLUSH_MS) {
          if (progressTimer) {
            clearTimeout(progressTimer);
            progressTimer = undefined;
          }
          flushProgress();
          return;
        }
        progressDirty = true;
        if (progressTimer) return;
        progressTimer = setTimeout(() => {
          progressTimer = undefined;
          if (progressDirty) flushProgress();
        }, PROGRESS_FLUSH_MS - elapsed);
        progressTimer.unref?.();
      };
      const stopProgressFlush = (): void => {
        if (progressTimer) {
          clearTimeout(progressTimer);
          progressTimer = undefined;
        }
        progressDirty = false;
      };
      const recordOutput = (writer: RotatingRedactedWriter, chunk: Buffer): void => {
        writer.append(chunk);
        job.heartbeatAt = new Date().toISOString();
        scheduleProgressFlush();
      };
      child.stdout?.on("data", (chunk: Buffer) => recordOutput(stdout, chunk));
      child.stderr?.on("data", (chunk: Buffer) => recordOutput(stderr, chunk));
      child.on("close", (code, signal) => {
        if (expiryTimer) clearTimeout(expiryTimer);
        stopProgressFlush();
        const status: JobTerminalStatus = signal ? "killed" : code === 0 ? "exited" : "failed";
        void this.finalizeJob(job, status, {
          ...(code !== null ? { exitCode: code } : {}),
          ...(signal !== null ? { signal } : {}),
        });
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (expiryTimer) clearTimeout(expiryTimer);
        stopProgressFlush();
        const code = error.code ?? "UNKNOWN";
        try { stderr.append(`Background process error [${code}]: ${error.message}\n`); } catch { /* finalization already owns the writers */ }
        void this.finalizeJob(job, "failed", { exitCode: 127 });
      });
      this.persistSync();
      this.emit({ type: "job", jobId: id });

      // Best-effort detection for shell-level failures such as command-not-found
      // immediately after the command shell launches. This bounded window is
      // not an application readiness guarantee; callers must tail/probe.
      let closedEarly = false;
      await new Promise<void>((resolve) => {
        if (!this.isLive(job)) {
          resolve();
          return;
        }
        const onClose = (): void => {
          closedEarly = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          child.off("close", onClose);
          resolve();
        }, 30);
        child.once("close", onClose);
      });
      if (closedEarly) {
        const finalization = this.finalizations.get(id);
        if (finalization) await finalization;
      }
      const earlyStatus = this.getJob(id)?.status;
      if (earlyStatus === "failed") {
        await this.persist();
        return {
          ok: false,
          output:
            `Background job failed immediately: id=${id} exit=${job.exitCode ?? "?"}\n` +
            `Command: ${job.commandDisplay}\nUse shell.tail {"id":"${id}"} for captured stderr; do not retry unchanged.`,
          exitCode: job.exitCode ?? 1,
          outputPath: stdoutArtifact,
          backgroundJob: {
            id,
            status: "failed",
            exitCode: job.exitCode,
            artifactPath: stdoutArtifact,
            nextOffset: 0,
          },
        };
      }

      child.unref();
      await this.persist();
      return {
        ok: true,
        output:
          `OS process launch confirmed: id=${id} (canonical job ID) pid=${child.pid ?? "?"}\n` +
          `This does not prove application readiness or continued liveness; use shell.tail {"id":"${id}"} and a readiness probe.\n` +
          `Use shell.jobs for status; do not use the artifact filename as the id.\n` +
          `Command: ${job.commandDisplay}\nArtifact: ${stdoutArtifact}`,
        outputPath: stdoutArtifact,
        backgroundJob: {
          id,
          status: job.status,
          artifactPath: stdoutArtifact,
          ...(options?.profile ? { profile: options.profile } : {}),
          ...(options?.estimatedSeconds !== undefined ? { estimatedSeconds: options.estimatedSeconds } : {}),
          nextOffset: 0,
        },
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (launchConfirmed) {
        const alive = processAlive(job.pid);
        if (!alive && this.isLive(job)) {
          await this.finalizeJob(job, "failed", { exitCode: job.exitCode ?? 1 });
        } else if (alive) {
          job.status = "running";
          this.persistSync();
          this.emit({ type: "job", jobId: id });
        }
        return {
          ok: alive,
          output:
            `Background command launched as pid=${job.pid ?? "?"}, but job setup/persistence failed: ${detail}\n` +
            `${alive ? `The process is still running as job ${id}; do not launch a duplicate. Use shell.jobs/tail/stop.` : "The process is no longer running; inspect its artifacts before deciding whether to retry."}`,
          exitCode: alive ? undefined : job.exitCode,
          outputPath: stdoutArtifact,
          backgroundJob: {
            id,
            status: job.status,
            exitCode: job.exitCode,
            artifactPath: stdoutArtifact,
            nextOffset: 0,
          },
        };
      }
      await this.finalizeJob(job, "failed", { exitCode: 127 });
      return {
        ok: false,
        output:
          `Background command launch error [UNKNOWN]: ${detail}\n` +
          `cwd=${JSON.stringify(cwd)}\nThe command did not start.`,
        exitCode: 127,
      };
    }
  }

  /**
   * List durable background jobs for this session only.
   * Ephemeral tool-stall rows and other sessions' jobs are excluded.
   */
  listJobs(sessionId?: string): ToolResult {
    this.pruneTerminalJobs();
    for (const job of this.jobs.values()) this.refreshJobLiveness(job);
    const durable = [...this.jobs.values()].filter(
      (job) => this.isDurable(job) && this.matchesSession(job, sessionId),
    );
    if (durable.length === 0) {
      return {
        ok: true,
        output: sessionId
          ? `No background jobs for this session (${sessionId}).`
          : "No background jobs.",
      };
    }
    const live = durable
      .filter((j) => this.isLive(j))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const done = durable
      .filter((j) => !this.isLive(j))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const ordered = [...live, ...done];
    const shown = ordered.slice(0, LIST_JOBS_MAX_LINES);
    const omitted = ordered.length - shown.length;
    const format = (job: BackgroundJob): string => {
      const health = this.isLive(job)
        ? processAlive(job.pid)
          ? "alive"
          : "unresponsive"
        : "terminal";
      return `[${job.id}] ${job.status} health=${health} exit=${job.exitCode ?? "?"} ${formatJobElapsed(job)}  ${job.commandDisplay.slice(0, 80)}`;
    };
    const header = sessionId
      ? `Session background jobs (${durable.length} total, session ${sessionId}):`
      : `Background jobs (${durable.length} total):`;
    const lines = [header, ...shown.map(format)];
    if (omitted > 0) {
      lines.push(
        `… ${omitted} older terminal job(s) omitted — use shell.tail with a known id if needed.`,
      );
    }
    if (live.length === 0) {
      lines.push("None currently running.");
    }
    return { ok: true, output: lines.join("\n") };
  }

  private resolveJobId(input: string): string | undefined {
    if (this.jobs.has(input)) return input;
    const inputBase = basename(input);
    for (const job of this.jobs.values()) {
      const artifacts = [
        job.artifactPath,
        job.stdoutArtifact,
        job.stderrArtifact,
        ...job.artifacts.stdout.chunks,
        ...job.artifacts.stderr.chunks,
      ];
      if (
        artifacts.some((path) => input === path || inputBase === basename(path)) ||
        inputBase.includes(`-${job.id}.`)
      ) {
        return job.id;
      }
    }
    return undefined;
  }

  getJob(id: string): BackgroundJob | undefined {
    const resolved = this.resolveJobId(id);
    const job = resolved ? this.jobs.get(resolved) : undefined;
    if (job) this.refreshJobLiveness(job);
    return job;
  }

  getPendingNotifications(sessionId?: string): ResponderNotification[] {
    return [...this.notifications.values()]
      .filter((notification) =>
        !notification.acknowledgedAt &&
        (!sessionId || notification.ownerSessionId === sessionId),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  pendingNotifications(sessionId?: string): ResponderNotification[] {
    return this.getPendingNotifications(sessionId);
  }

  markDelivered(notificationId: string): boolean {
    const notification = this.notifications.get(notificationId);
    if (!notification) return false;
    if (!notification.deliveredAt) {
      const deliveredAt = new Date().toISOString();
      notification.deliveredAt = deliveredAt;
      if (!this.persistSync()) {
        notification.deliveredAt = undefined;
        return false;
      }
      this.emit({ type: "notification", jobId: notification.jobId, notificationId });
    }
    return true;
  }

  markAnalyzed(notificationId: string): boolean {
    const notification = this.notifications.get(notificationId);
    if (!notification?.deliveredAt) return false;
    if (!notification.analyzedAt) {
      notification.analyzedAt = new Date().toISOString();
      if (!this.persistSync()) {
        notification.analyzedAt = undefined;
        return false;
      }
      this.emit({
        type: "notification",
        jobId: notification.jobId,
        notificationId,
      });
    }
    return true;
  }

  acknowledge(notificationId: string): boolean {
    const notification = this.notifications.get(notificationId);
    if (!notification?.analyzedAt) return false;
    if (!notification.acknowledgedAt) {
      notification.acknowledgedAt = new Date().toISOString();
      if (!this.persistSync()) {
        notification.acknowledgedAt = undefined;
        return false;
      }
      this.pruneTerminalJobs();
      this.persistSync();
      this.emit({ type: "notification", jobId: notification.jobId, notificationId });
    }
    return true;
  }

  linkJob(jobId: string, metadata: JobLinkMetadata): BackgroundJob | undefined {
    const resolved = this.resolveJobId(jobId);
    const job = resolved ? this.jobs.get(resolved) : undefined;
    if (!job || !this.isDurable(job)) return undefined;
    const previousJob: JobLinkMetadata = {
      taskId: job.taskId,
      parentTaskId: job.parentTaskId,
      wakeOnCompletion: job.wakeOnCompletion,
      monitor: job.monitor,
      responder: job.responder,
    };
    const existingNotification = this.notificationForJob(job.id);
    const previousNotification = existingNotification
      ? {
          taskId: existingNotification.taskId,
          parentTaskId: existingNotification.parentTaskId,
          wakeOnCompletion: existingNotification.wakeOnCompletion,
          monitor: existingNotification.monitor,
          responder: existingNotification.responder,
        }
      : undefined;
    if (metadata.taskId !== undefined) job.taskId = metadata.taskId;
    if (metadata.parentTaskId !== undefined) job.parentTaskId = metadata.parentTaskId;
    if (metadata.wakeOnCompletion !== undefined) job.wakeOnCompletion = metadata.wakeOnCompletion;
    if (metadata.monitor !== undefined) job.monitor = metadata.monitor;
    if (metadata.responder !== undefined) job.responder = metadata.responder;
    const completion = this.ensureCompletionNotification(job);
    if (completion.notification) {
      if (metadata.taskId !== undefined) completion.notification.taskId = metadata.taskId;
      if (metadata.parentTaskId !== undefined) completion.notification.parentTaskId = metadata.parentTaskId;
      if (metadata.wakeOnCompletion !== undefined) completion.notification.wakeOnCompletion = metadata.wakeOnCompletion;
      if (metadata.monitor !== undefined) completion.notification.monitor = metadata.monitor;
      if (metadata.responder !== undefined) completion.notification.responder = metadata.responder;
    }
    if (!this.persistSync()) {
      job.taskId = previousJob.taskId;
      job.parentTaskId = previousJob.parentTaskId;
      job.wakeOnCompletion = previousJob.wakeOnCompletion;
      job.monitor = previousJob.monitor;
      job.responder = previousJob.responder;
      if (completion.created && completion.notification) {
        this.notifications.delete(completion.notification.id);
      } else if (completion.notification && previousNotification) {
        completion.notification.taskId = previousNotification.taskId;
        completion.notification.parentTaskId = previousNotification.parentTaskId;
        completion.notification.wakeOnCompletion = previousNotification.wakeOnCompletion;
        completion.notification.monitor = previousNotification.monitor;
        completion.notification.responder = previousNotification.responder;
      }
      return undefined;
    }
    this.emit({ type: "job", jobId: job.id });
    if (completion.notification) {
      this.emit({ type: "notification", jobId: job.id, notificationId: completion.notification.id });
    }
    return job;
  }

  async tailJob(id: string, bytesOrCursor?: number | TailCursor): Promise<ToolResult> {
    const resolved = this.resolveJobId(id);
    const job = resolved ? this.jobs.get(resolved) : undefined;
    if (!job) {
      const known = [...this.jobs.keys()].join(", ") || "none";
      return { ok: false, output: `Job "${id}" not found. Canonical job IDs: ${known}.`, exitCode: 1 };
    }
    this.refreshJobLiveness(job);
    const cursor = typeof bytesOrCursor === "number" ? { bytes: bytesOrCursor } : (bytesOrCursor ?? {});
    const stream = cursor.stream ?? "stdout";
    if (stream === "combined" && cursor.offset !== undefined) {
      return {
        ok: false,
        output:
          "Incremental offsets are stream-specific. Poll stdout and stderr separately when using offset/nextOffset; combined is snapshot-only.",
        exitCode: 1,
      };
    }
    const paths = stream === "stderr" ? job.artifacts.stderr.chunks : stream === "stdout" ? job.artifacts.stdout.chunks : [...job.artifacts.stdout.chunks, ...job.artifacts.stderr.chunks];
    const readablePaths = paths.length > 0 ? paths : [stream === "stderr" ? job.stderrArtifact : job.stdoutArtifact];
    const path = readablePaths.at(-1)!;
    try {
      const sizes = await Promise.all(readablePaths.map(async (chunkPath) => ({ path: chunkPath, size: (await stat(chunkPath)).size })));
      const total = sizes.reduce((sum, entry) => sum + entry.size, 0);
      const max = Math.max(1, Math.min(cursor.bytes ?? DEFAULT_TAIL_BYTES, 1024 * 1024));
      const start = cursor.offset === undefined ? Math.max(0, total - max) : Math.max(0, Math.min(cursor.offset, total));
      const length = Math.min(max, total - start);
      const parts: Buffer[] = [];
      let logical = 0;
      let remaining = length;
      for (const entry of sizes) {
        const chunkStart = logical;
        const chunkEnd = logical + entry.size;
        logical = chunkEnd;
        if (remaining <= 0 || start >= chunkEnd) continue;
        const localStart = Math.max(0, start - chunkStart);
        const localLength = Math.min(remaining, entry.size - localStart);
        const handle = await open(entry.path, "r");
        const buffer = Buffer.alloc(localLength);
        try { await handle.read(buffer, 0, localLength, localStart); } finally { await handle.close(); }
        parts.push(buffer);
        remaining -= localLength;
      }
      let combined = Buffer.concat(parts);
      // A fixed byte window can land mid-character (e.g. inside the 3-byte
      // "•" redaction marker). Trim any dangling lead byte(s) off the end so
      // decoding never mangles a character; the trimmed bytes are re-read
      // (and land on a boundary) on the caller's next offset-based poll.
      const trim = start + combined.length < total ? trailingIncompleteBytes(combined) : 0;
      if (trim > 0) combined = combined.subarray(0, combined.length - trim);
      const nextOffset = start + (length - remaining) - trim;
      return {
        ok: true,
        output:
          `[${job.id}] ${job.status} exit=${job.exitCode ?? "?"} signal=${job.signal ?? "?"} ` +
          `stream=${stream} offset=${start} nextOffset=${nextOffset} total=${total}:\n` +
          combined.toString("utf8"),
        outputPath: path,
        backgroundJob: {
          id: job.id,
          status: job.status,
          artifactPath: path,
          nextOffset,
          ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
          ...(job.signal !== undefined ? { signal: job.signal } : {}),
        },
      };
    } catch (error) {
      return { ok: false, output: `Failed to read job output: ${error instanceof Error ? error.message : String(error)}`, exitCode: 1 };
    }
  }

  async stopJob(
    id: string,
    options?: { signal?: NodeJS.Signals; graceMs?: number; escalate?: boolean; suppressWake?: boolean },
  ): Promise<ToolResult> {
    const resolved = this.resolveJobId(id);
    const job = resolved ? this.jobs.get(resolved) : undefined;
    if (!job || !resolved) return { ok: false, output: `Job "${id}" not found.`, exitCode: 1 };
    id = resolved;
    const inFlightFinalization = this.finalizations.get(id);
    if (inFlightFinalization) {
      const persisted = await inFlightFinalization;
      return persisted
        ? { ok: true, output: `Job "${id}" completed while stop was requested.` }
        : { ok: false, output: `Job "${id}" completed, but its terminal state could not be persisted.`, exitCode: 1 };
    }
    if (!this.isLive(job)) return { ok: false, output: `Job "${id}" is already ${job.status}.`, exitCode: 1 };
    const pid = job.pid;
    if (!pid) return { ok: false, output: `Job "${id}" has no process id to stop.`, exitCode: 1 };

    const processGroupId = process.platform !== "win32" ? job.processGroupId : undefined;
    const targetAlive = (): boolean => {
      if (!processGroupId) return processAlive(pid);
      try { process.kill(-processGroupId, 0); return true; } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    const identityMatches = (): boolean => {
      if (process.platform === "win32") return processAlive(pid);
      const current = processIdentity(pid);
      return Boolean(current && job.processIdentity && current === job.processIdentity);
    };
    if (targetAlive() && (!processAlive(pid) || !identityMatches())) {
      return {
        ok: false,
        output: `Refused to signal job "${id}": its persisted process identity no longer matches pid ${pid}.`,
        exitCode: 1,
      };
    }
    const child = this.processes.get(id);
    const childClose = child
      ? new Promise<void>((resolve) => child.once("close", () => resolve()))
      : undefined;

    this.clearJobDeadline(id);
    const previousStatus = job.status;
    const previousWakeOnCompletion = job.wakeOnCompletion;
    if (options?.suppressWake) job.wakeOnCompletion = false;
    job.status = "stopping";
    if (!this.persistSync()) {
      job.status = previousStatus;
      job.wakeOnCompletion = previousWakeOnCompletion;
      if (!job.timeoutAt || Date.parse(job.timeoutAt) > Date.now()) this.scheduleJobDeadline(job);
      return { ok: false, output: `Failed to persist stop state for job "${id}"; no signal was sent.`, exitCode: 1 };
    }
    this.emit({ type: "job", jobId: id });
    this.abortControllers.get(id)?.abort();
    let processGroupVerified = false;
    const send = (
      signal: NodeJS.Signals,
      allowVerifiedGroup: boolean,
    ): "sent" | "gone" | "identity-mismatch" | "failed" => {
      if (!targetAlive()) return "gone";
      if (processAlive(pid) && identityMatches()) {
        processGroupVerified = true;
      } else if (!(processGroupId && processGroupVerified && allowVerifiedGroup)) {
        return "identity-mismatch";
      }
      try {
        processGroupId ? process.kill(-processGroupId, signal) : process.kill(pid, signal);
        return "sent";
      } catch {
        return targetAlive() ? "failed" : "gone";
      }
    };
    const restoreRunning = (): void => {
      job.status = "running";
      if (!job.timeoutAt || Date.parse(job.timeoutAt) > Date.now()) this.scheduleJobDeadline(job);
      this.persistSync();
      this.emit({ type: "job", jobId: id });
    };
    const graceful = options?.signal ?? "SIGTERM";
    const firstSignal = send(graceful, false);
    if (firstSignal === "identity-mismatch" || firstSignal === "failed") {
      restoreRunning();
      return {
        ok: false,
        output: firstSignal === "identity-mismatch"
          ? `Refused to signal job "${id}": process identity changed immediately before stop.`
          : `Failed to signal job "${id}".`,
        exitCode: 1,
      };
    }
    const waitForExit = async (ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (!targetAlive()) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return !targetAlive();
    };
    let stopped = firstSignal === "gone" || await waitForExit(options?.graceMs ?? 2_000);
    let actualSignal: NodeJS.Signals = graceful;
    if (!stopped && options?.escalate !== false) {
      actualSignal = "SIGKILL";
      const escalated = send(actualSignal, true);
      if (escalated === "identity-mismatch" || escalated === "failed") {
        restoreRunning();
        return {
          ok: false,
          output: escalated === "identity-mismatch"
            ? `Refused to escalate job "${id}": process identity changed before SIGKILL.`
            : `Failed to escalate job "${id}" with SIGKILL.`,
          exitCode: 1,
        };
      }
      stopped = escalated === "gone" || await waitForExit(1_000);
    }
    if (!stopped) {
      restoreRunning();
      return { ok: false, output: `Job "${id}" remains alive after ${actualSignal}.`, exitCode: 1 };
    }

    if (childClose) await childClose;
    let terminalPersisted = true;
    const eventFinalization = this.finalizations.get(id);
    if (eventFinalization) terminalPersisted = await eventFinalization;
    if (this.isLive(job)) {
      terminalPersisted = await this.finalizeJob(job, "killed", { signal: actualSignal });
    }
    if (!terminalPersisted) {
      return {
        ok: false,
        output: `Job "${id}" stopped, but its terminal state and completion notification could not be persisted.`,
        exitCode: 1,
      };
    }
    return { ok: true, output: `Job "${id}" stopped and termination verified (${actualSignal}).` };
  }

  async cancelAll(sessionId: string): Promise<ToolResult> {
    if (!sessionId) {
      return { ok: false, output: "cancelAll requires a non-empty session id.", exitCode: 1 };
    }
    const targets = [...this.jobs.values()].filter(
      (job) => this.isDurable(job) && job.ownerSessionId === sessionId && this.isLive(job),
    );
    const priorWake = new Map(targets.map((job) => [job.id, job.wakeOnCompletion]));
    for (const job of targets) {
      job.wakeOnCompletion = false;
      const notification = this.notificationForJob(job.id);
      if (notification) notification.wakeOnCompletion = false;
    }
    if (!this.persistSync()) {
      for (const job of targets) job.wakeOnCompletion = priorWake.get(job.id);
      return {
        ok: false,
        output: `Failed to persist wake suppression for session ${sessionId}; no jobs were cancelled.`,
        exitCode: 1,
      };
    }
    for (const job of targets) this.emit({ type: "job", jobId: job.id });

    const outcomes = await Promise.all(targets.map(async (job) => {
      const current = this.jobs.get(job.id);
      if (!current || !this.isLive(current)) return { id: job.id, ok: true, output: "already terminal" };
      try {
        const result = await this.stopJob(job.id, { suppressWake: true });
        return { id: job.id, ok: result.ok, output: result.output };
      } catch (error) {
        return { id: job.id, ok: false, output: error instanceof Error ? error.message : String(error) };
      }
    }));

    const acknowledgedAt = new Date().toISOString();
    const notificationSnapshots: Array<{
      notification: ResponderNotification;
      wakeOnCompletion: boolean;
      deliveredAt?: string | undefined;
      acknowledgedAt?: string | undefined;
    }> = [];
    for (const notification of this.notifications.values()) {
      if (notification.ownerSessionId !== sessionId || notification.acknowledgedAt) continue;
      notificationSnapshots.push({
        notification,
        wakeOnCompletion: notification.wakeOnCompletion,
        deliveredAt: notification.deliveredAt,
        acknowledgedAt: notification.acknowledgedAt,
      });
      notification.wakeOnCompletion = false;
      notification.deliveredAt ??= acknowledgedAt;
      notification.acknowledgedAt = acknowledgedAt;
    }
    const acknowledgementsPersisted = this.persistSync();
    if (!acknowledgementsPersisted) {
      for (const snapshot of notificationSnapshots) {
        snapshot.notification.wakeOnCompletion = snapshot.wakeOnCompletion;
        snapshot.notification.deliveredAt = snapshot.deliveredAt;
        snapshot.notification.acknowledgedAt = snapshot.acknowledgedAt;
      }
    } else {
      for (const snapshot of notificationSnapshots) {
        this.emit({
          type: "notification",
          jobId: snapshot.notification.jobId,
          notificationId: snapshot.notification.id,
        });
      }
      this.pruneTerminalJobs();
      this.persistSync();
    }
    const failures = outcomes.filter((outcome) => !outcome.ok);
    if (failures.length > 0 || !acknowledgementsPersisted) {
      const details = failures.map((failure) => `[${failure.id}] ${failure.output}`);
      if (!acknowledgementsPersisted) details.push("Completion notifications could not be durably acknowledged.");
      return {
        ok: false,
        output:
          `Cancelled ${outcomes.length - failures.length}/${outcomes.length} background job(s) for session ${sessionId}; ` +
          `${details.length} failure(s):\n${details.join("\n")}`,
        exitCode: 1,
      };
    }
    return {
      ok: true,
      output: targets.length === 0
        ? `No running background jobs for session ${sessionId}; pending notifications were acknowledged.`
        : `Cancelled ${targets.length} background job(s) for session ${sessionId}; wake notifications were suppressed and acknowledged.`,
    };
  }

  getRunningJobs(sessionId?: string): BackgroundJob[] {
    for (const job of this.jobs.values()) this.refreshJobLiveness(job);
    return [...this.jobs.values()].filter(
      (job) =>
        this.isDurable(job) &&
        this.isLive(job) &&
        this.matchesSession(job, sessionId),
    );
  }

  getRecentJobs(limit = 50, sessionId?: string): BackgroundJob[] {
    for (const job of this.jobs.values()) this.refreshJobLiveness(job);
    return [...this.jobs.values()]
      .filter(
        (job) => this.isDurable(job) && this.matchesSession(job, sessionId),
      )
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }

  /** Drop stale terminal durable jobs and all leftover ephemeral rows. */
  pruneTerminalJobs(): void {
    const now = Date.now();
    for (const [id, notification] of this.notifications) {
      const job = this.jobs.get(notification.jobId);
      if (
        !job ||
        (notification.acknowledgedAt && job.status !== "lost")
      ) {
        this.notifications.delete(id);
      }
    }
    const durableTerminal: BackgroundJob[] = [];
    for (const [id, job] of this.jobs) {
      if (!this.isDurable(job)) {
        // Safety: never keep ephemeral rows that are not live.
        if (!this.isLive(job)) this.jobs.delete(id);
        continue;
      }
      if (this.isLive(job)) continue;
      const notification = this.notificationForJob(job.id);
      if (notification && !notification.acknowledgedAt) continue;
      const ended = job.endedAt ? Date.parse(job.endedAt) : Date.parse(job.startedAt);
      if (Number.isFinite(ended) && now - ended > TERMINAL_JOB_MAX_AGE_MS) {
        this.jobs.delete(id);
        continue;
      }
      durableTerminal.push(job);
    }
    if (durableTerminal.length <= MAX_DURABLE_TERMINAL_JOBS) return;
    durableTerminal.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const job of durableTerminal.slice(MAX_DURABLE_TERMINAL_JOBS)) {
      this.jobs.delete(job.id);
    }
  }

  private loadAndReconcile(): void {
    try {
      let parsed: PersistedRegistry | undefined;
      const sourcePath = existsSync(this.registryPath)
        ? this.registryPath
        : this.transientV2RegistryPath;
      if (!existsSync(sourcePath)) return;
      try {
        const candidate = JSON.parse(readFileSync(sourcePath, "utf8")) as PersistedRegistry;
        if ((candidate.schemaVersion === 1 || candidate.schemaVersion === 2) && Array.isArray(candidate.jobs)) {
          parsed = candidate;
        }
      } catch { /* a corrupt current registry must not replay stale v1 state */ }
      if (!parsed) return;
      if (parsed.schemaVersion === 2 && Array.isArray(parsed.notifications)) {
        const notifiedJobs = new Set<string>();
        for (const notification of parsed.notifications) {
          if (!notification || typeof notification.id !== "string" || typeof notification.jobId !== "string") continue;
          if (notifiedJobs.has(notification.jobId)) continue;
          notifiedJobs.add(notification.jobId);
          this.notifications.set(notification.id, notification);
        }
      }
      for (const job of parsed.jobs) {
        if (job.kind === "ephemeral" || looksLikeEphemeralToolTrack(job)) continue;
        job.kind = "durable";
        if (["starting", "running", "stopping"].includes(job.status)) {
          const identity = processIdentity(job.pid);
          if (!processAlive(job.pid) || !identity || !job.processIdentity || identity !== job.processIdentity) {
            job.status = "lost";
            job.endedAt = new Date().toISOString();
          } else {
            job.status = "running";
            job.heartbeatAt = new Date().toISOString();
          }
        }
        this.jobs.set(job.id, job);
        this.ensureCompletionNotification(job);
        this.scheduleJobDeadline(job);
      }
      for (const [id, notification] of this.notifications) {
        const job = this.jobs.get(notification.jobId);
        if (!job?.responder) this.notifications.delete(id);
      }
      this.pruneTerminalJobs();
      this.persistSync();
    } catch { /* Corrupt registries are ignored, never trusted as running. */ }
  }

  /** Only durable jobs and responder notifications are written to disk. */
  private registry(): PersistedRegistryV2 {
    return {
      schemaVersion: 2,
      jobs: [...this.jobs.values()].filter((job) => this.isDurable(job)),
      notifications: [...this.notifications.values()],
    };
  }
  private scheduleRegistryRetry(): void {
    if (this.registryRetryTimer) return;
    const timer = setTimeout(() => {
      this.registryRetryTimer = undefined;
      if (!this.persistSync()) this.scheduleRegistryRetry();
    }, 250);
    timer.unref?.();
    this.registryRetryTimer = timer;
  }

  private persistSync(): boolean {
    try {
      mkdirSync(this.jobsDir, { recursive: true });
      const temp = `${this.registryPath}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.registry(), null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, this.registryPath);
      return true;
    } catch {
      return false;
    }
  }
  private async persist(): Promise<void> {
    if (!this.persistSync()) throw new Error("Failed to persist the background-job registry.");
  }
}

export const jobManager = new JobManager();
