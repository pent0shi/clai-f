import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, type WriteStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ToolResult } from "../types.js";
import { redactSecrets } from "../llm/provider.js";
import { safeCwd } from "../os/cwd.js";
import { getJobsDir } from "../store/paths.js";
import { resolveShell } from "./shell.js";

export type JobStatus = "starting" | "running" | "exited" | "failed" | "stopping" | "killed" | "lost";

export interface JobArtifactReceipt {
  path: string;
  chunks: string[];
  bytes: number;
  droppedBytes: number;
  redacted: boolean;
  sha256: string;
}

/**
 * durable  — shell.start / auto-backgrounded servers (listed by shell.jobs, persisted)
 * ephemeral — per-tool stall tracking in the agent runner (never listed, never persisted)
 */
export type JobKind = "durable" | "ephemeral";

export interface BackgroundJob {
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

interface PersistedRegistry { schemaVersion: 1; jobs: BackgroundJob[] }
interface TailCursor { stream?: "stdout" | "stderr" | "combined"; offset?: number; bytes?: number }

/** Safe detached process form. stdinText is written once, then stdin is closed. */
export interface BackgroundSpawnSpec {
  command: string;
  argv: string[];
  stdinText?: string | undefined;
  /** Non-secret display text persisted in the registry and artifacts. */
  display?: string | undefined;
}

export interface StartJobOptions {
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
const TOTAL_STREAM_BYTES = 16 * 1024 * 1024;
const DEFAULT_TAIL_BYTES = 8_000;
const REGISTRY_FILE = "registry-v1.json";
/** Cap durable terminal jobs kept on disk/in memory (per process). */
const MAX_DURABLE_TERMINAL_JOBS = 80;
/** Drop terminal durable jobs older than this on load/list. */
const TERMINAL_JOB_MAX_AGE_MS = 48 * 60 * 60 * 1000;
/** Max lines shell.jobs returns to the model (running first, then recent). */
const LIST_JOBS_MAX_LINES = 40;

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
    const value = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {
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
  private index = 0;
  private currentBytes = 0;
  private hash = createHash("sha256");
  private pending = "";
  private static readonly REDACTION_OVERLAP_CHARS = 4096;

  constructor(private readonly receipt: JobArtifactReceipt) {}

  append(raw: Buffer | string): void {
    this.pending += Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
    // Complete lines are safe to redact as a unit, including secrets split
    // across arbitrary process data events. Keep an unterminated tail as the
    // overlap window for the next event.
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

  close(): void {
    if (this.pending) this.writeRedacted(this.pending);
    this.pending = "";
    this.stream?.end();
    this.stream = undefined;
  }

  private writeRedacted(source: string): void {
    const safe = redactSecrets(source);
    if (safe !== source) this.receipt.redacted = true;
    let data = Buffer.from(safe, "utf8");
    if (this.receipt.bytes >= TOTAL_STREAM_BYTES) {
      this.receipt.droppedBytes += data.length;
      return;
    }
    if (this.receipt.bytes + data.length > TOTAL_STREAM_BYTES) {
      const keep = TOTAL_STREAM_BYTES - this.receipt.bytes;
      this.receipt.droppedBytes += data.length - keep;
      data = data.subarray(0, keep);
    }
    while (data.length > 0) {
      if (!this.stream || this.currentBytes >= PER_FILE_BYTES) this.rotate();
      const room = PER_FILE_BYTES - this.currentBytes;
      const part = data.subarray(0, room);
      this.stream!.write(part);
      this.hash.update(part);
      this.currentBytes += part.length;
      this.receipt.bytes += part.length;
      data = data.subarray(part.length);
    }
    this.receipt.sha256 = this.hash.copy().digest("hex");
  }

  private rotate(): void {
    this.stream?.end();
    const path = this.index === 0 ? this.receipt.path : `${this.receipt.path}.${this.index}`;
    this.index += 1;
    this.currentBytes = 0;
    this.receipt.chunks.push(path);
    this.stream = createWriteStream(path, { flags: "w", mode: 0o600 });
  }
}

export class JobManager {
  private jobs = new Map<string, BackgroundJob>();
  private processes = new Map<string, ChildProcess>();
  private writers = new Map<string, { stdout: RotatingRedactedWriter; stderr: RotatingRedactedWriter }>();
  private abortControllers = new Map<string, AbortController>();
  private deadlineTimers = new Map<string, NodeJS.Timeout>();
  private readonly registryPath: string;

  constructor(private readonly jobsDir = getJobsDir()) {
    this.registryPath = join(this.jobsDir, REGISTRY_FILE);
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

  private matchesSession(
    job: BackgroundJob,
    sessionId: string | undefined,
  ): boolean {
    if (!sessionId) return true;
    // Strict: only this session's durable jobs (never leak other sessions).
    return job.ownerSessionId === sessionId;
  }

  private clearJobDeadline(id: string): void {
    const timer = this.deadlineTimers.get(id);
    if (timer) clearTimeout(timer);
    this.deadlineTimers.delete(id);
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
    void this.persist();
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
    // Ephemeral tool-track rows must not bloat registry-v1.json (was the
    // root cause of 1000+ fake "jobs" and multi-GB RAM).
    if (this.isDurable(tracked)) void this.persist();
  }

  updateJobStatus(id: string, status: JobStatus, exitCode?: number): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = status;
    if (exitCode !== undefined) job.exitCode = exitCode;
    if (!["running", "starting", "stopping"].includes(status)) {
      job.endedAt = new Date().toISOString();
    }
    this.abortControllers.delete(id);
    this.processes.delete(id);
    if (!this.isLive(job)) this.clearJobDeadline(id);
    // Drop finished tool-track rows immediately — they are not background jobs.
    if (!this.isDurable(job) && !this.isLive(job)) {
      this.jobs.delete(id);
      return;
    }
    if (this.isDurable(job)) {
      this.pruneTerminalJobs();
      void this.persist();
    }
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
    await this.persist();

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
        stdout.close();
        stderr.close();
        job.status = "failed";
        job.exitCode = 127;
        job.endedAt = new Date().toISOString();
        await this.persist();
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
      child.stdout?.on("data", (chunk: Buffer) => { stdout.append(chunk); job.heartbeatAt = new Date().toISOString(); void this.persist(); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr.append(chunk); job.heartbeatAt = new Date().toISOString(); void this.persist(); });
      child.on("close", (code, signal) => {
        if (expiryTimer) clearTimeout(expiryTimer);
        this.clearJobDeadline(id);
        job.exitCode = code ?? undefined;
        job.signal = signal ?? undefined;
        job.status = signal ? "killed" : code === 0 ? "exited" : "failed";
        job.endedAt = new Date().toISOString();
        stdout.close(); stderr.close();
        this.processes.delete(id); this.writers.delete(id);
        void this.persist();
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (expiryTimer) clearTimeout(expiryTimer);
        this.clearJobDeadline(id);
        const code = error.code ?? "UNKNOWN";
        stderr.append(`Background process error [${code}]: ${error.message}\n`);
        job.status = "failed";
        job.exitCode = 127;
        job.endedAt = new Date().toISOString();
        stdout.close(); stderr.close();
        this.processes.delete(id); this.writers.delete(id);
        void this.persist();
      });

      // Best-effort detection for shell-level failures such as command-not-found
      // immediately after the command shell launches. This bounded window is
      // not an application readiness guarantee; callers must tail/probe.
      await new Promise<void>((resolve) => {
        if (!this.isLive(job)) {
          resolve();
          return;
        }
        const onClose = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          child.off("close", onClose);
          resolve();
        }, 30);
        child.once("close", onClose);
      });
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
        job.status = alive ? "running" : "failed";
        if (!alive) {
          job.exitCode ??= 1;
          job.endedAt ??= new Date().toISOString();
        }
        await this.persist().catch(() => undefined);
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
      job.status = "failed";
      job.exitCode = 127;
      job.endedAt = new Date().toISOString();
      await this.persist().catch(() => undefined);
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
      const elapsedEnd = job.endedAt
        ? new Date(job.endedAt).getTime()
        : Date.now();
      const elapsed = Math.max(
        0,
        Math.round(
          (elapsedEnd - new Date(job.startedAt).getTime()) / 1000,
        ),
      );
      const health = this.isLive(job)
        ? processAlive(job.pid)
          ? "alive"
          : "unresponsive"
        : "terminal";
      return `[${job.id}] ${job.status} health=${health} exit=${job.exitCode ?? "?"} ${elapsed}s  ${job.commandDisplay.slice(0, 80)}`;
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

  async stopJob(id: string, options?: { signal?: NodeJS.Signals; graceMs?: number; escalate?: boolean }): Promise<ToolResult> {
    const resolved = this.resolveJobId(id);
    const job = resolved ? this.jobs.get(resolved) : undefined;
    if (!job || !resolved) return { ok: false, output: `Job "${id}" not found.`, exitCode: 1 };
    id = resolved;
    if (job.status !== "running" && job.status !== "starting") return { ok: false, output: `Job "${id}" is already ${job.status}.`, exitCode: 1 };
    this.clearJobDeadline(id);
    job.status = "stopping"; await this.persist();
    this.abortControllers.get(id)?.abort();
    const pid = job.pid;
    const send = (signal: NodeJS.Signals): boolean => {
      if (!pid) return false;
      try { process.platform !== "win32" && job.processGroupId ? process.kill(-job.processGroupId, signal) : process.kill(pid, signal); return true; } catch { return !processAlive(pid); }
    };
    const graceful = options?.signal ?? "SIGTERM";
    if (!send(graceful) && processAlive(pid)) { job.status = "running"; if (!job.timeoutAt || Date.parse(job.timeoutAt) > Date.now()) this.scheduleJobDeadline(job); await this.persist(); return { ok: false, output: `Failed to signal job "${id}".`, exitCode: 1 }; }
    const waitForExit = async (ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) { if (!processAlive(pid)) return true; await new Promise((resolve) => setTimeout(resolve, 25)); }
      return !processAlive(pid);
    };
    let stopped = await waitForExit(options?.graceMs ?? 2_000);
    let actualSignal: NodeJS.Signals = graceful;
    if (!stopped && options?.escalate !== false) { actualSignal = "SIGKILL"; send(actualSignal); stopped = await waitForExit(1_000); }
    if (!stopped) { job.status = "running"; if (!job.timeoutAt || Date.parse(job.timeoutAt) > Date.now()) this.scheduleJobDeadline(job); await this.persist(); return { ok: false, output: `Job "${id}" remains alive after ${actualSignal}.`, exitCode: 1 }; }
    job.status = "killed"; job.signal = actualSignal; job.endedAt = new Date().toISOString();
    this.abortControllers.delete(id); this.processes.delete(id); this.writers.get(id)?.stdout.close(); this.writers.get(id)?.stderr.close(); this.writers.delete(id);
    await this.persist();
    return { ok: true, output: `Job "${id}" stopped and termination verified (${actualSignal}).` };
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
    const durableTerminal: BackgroundJob[] = [];
    for (const [id, job] of this.jobs) {
      if (!this.isDurable(job)) {
        // Safety: never keep ephemeral rows that are not live.
        if (!this.isLive(job)) this.jobs.delete(id);
        continue;
      }
      if (this.isLive(job)) continue;
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
      if (!existsSync(this.registryPath)) return;
      const parsed = JSON.parse(readFileSync(this.registryPath, "utf8")) as PersistedRegistry;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.jobs)) return;
      for (const job of parsed.jobs) {
        // Historical pollution: tool-stall rows were persisted as if they were
        // background jobs (command like "fs.list /path"). Drop them on load.
        if (job.kind === "ephemeral") continue;
        if (looksLikeEphemeralToolTrack(job)) continue;
        job.kind = "durable";
        if (["starting", "running", "stopping"].includes(job.status)) {
          const identity = processIdentity(job.pid);
          if (!processAlive(job.pid) || !identity || !job.processIdentity || identity !== job.processIdentity) {
            job.status = "lost";
            job.endedAt = new Date().toISOString();
          } else {
            // The process identity is still verified. Restore any persisted
            // deadline after insertion; an already-expired deadline schedules
            // immediate stopJob(), which verifies termination before marking it.
            job.status = "running";
            job.heartbeatAt = new Date().toISOString();
          }
        }
        this.jobs.set(job.id, job);
        this.scheduleJobDeadline(job);
      }
      this.pruneTerminalJobs();
      this.persistSync();
    } catch { /* Corrupt registries are ignored, never trusted as running. */ }
  }

  /** Only durable jobs are written to disk. */
  private registry(): PersistedRegistry {
    return {
      schemaVersion: 1,
      jobs: [...this.jobs.values()].filter((j) => this.isDurable(j)),
    };
  }
  private persistSync(): void {
    try {
      mkdirSync(this.jobsDir, { recursive: true });
      const temp = `${this.registryPath}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.registry(), null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, this.registryPath);
    } catch { /* best effort during constructor reconciliation */ }
  }
  private async persist(): Promise<void> {
    this.persistSync();
  }
}

export const jobManager = new JobManager();
