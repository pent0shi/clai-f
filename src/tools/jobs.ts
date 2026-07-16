import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, type WriteStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ToolResult } from "../types.js";
import { redactSecrets } from "../llm/provider.js";
import { safeCwd } from "../os/cwd.js";
import { getJobsDir } from "../store/paths.js";

export type JobStatus = "starting" | "running" | "exited" | "failed" | "stopping" | "killed" | "lost";

export interface JobArtifactReceipt {
  path: string;
  chunks: string[];
  bytes: number;
  droppedBytes: number;
  redacted: boolean;
  sha256: string;
}

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
  name?: string | undefined;
  authorization?: { target: string; expiresAt?: string | undefined } | undefined;
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
  private readonly registryPath: string;

  constructor(private readonly jobsDir = getJobsDir()) {
    this.registryPath = join(this.jobsDir, REGISTRY_FILE);
    this.loadAndReconcile();
  }

  registerJob(id: string, job: BackgroundJob, ac?: AbortController, child?: ChildProcess): void {
    this.jobs.set(id, job);
    if (ac) this.abortControllers.set(id, ac);
    if (child) this.processes.set(id, child);
    void this.persist();
  }

  updateJobStatus(id: string, status: JobStatus, exitCode?: number): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = status;
    if (exitCode !== undefined) job.exitCode = exitCode;
    if (!["running", "starting", "stopping"].includes(status)) job.endedAt = new Date().toISOString();
    this.abortControllers.delete(id);
    this.processes.delete(id);
    void this.persist();
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
      ...(options?.name ? { name: options.name } : {}),
      ...(options?.authorization ? { authorization: options.authorization } : {}),
    };
    this.jobs.set(id, job);
    await this.persist();

    try {
      const detached = process.platform !== "win32";
      const child = typeof command === "string"
        ? spawn(command, {
            cwd,
            detached,
            shell: true,
            stdio: ["ignore", "pipe", "pipe"],
          })
        : spawn(command.command, command.argv, {
            cwd,
            detached,
            shell: false,
            stdio: [command.stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
          });
      // Sensitive input is never copied into the job record, display, logs, or
      // artifacts. Write it once to the child and close stdin immediately.
      if (typeof command !== "string" && command.stdinText !== undefined) {
        child.stdin?.end(command.stdinText);
      }
      job.pid = child.pid;
      job.processGroupId = detached ? child.pid : undefined;
      job.status = "running";
      job.heartbeatAt = new Date().toISOString();
      job.processIdentity = processIdentity(child.pid);
      const stdout = new RotatingRedactedWriter(job.artifacts.stdout);
      const stderr = new RotatingRedactedWriter(job.artifacts.stderr);
      stdout.append(`$ ${job.commandDisplay}\n\n`);
      this.processes.set(id, child);
      this.writers.set(id, { stdout, stderr });
      const expiresAt = options?.authorization?.expiresAt ? Date.parse(options.authorization.expiresAt) : Number.NaN;
      const expiryTimer = Number.isFinite(expiresAt) && expiresAt > Date.now()
        ? setTimeout(() => { void this.stopJob(id, { graceMs: 1_000 }); }, expiresAt - Date.now())
        : undefined;
      expiryTimer?.unref?.();
      child.stdout?.on("data", (chunk: Buffer) => { stdout.append(chunk); job.heartbeatAt = new Date().toISOString(); void this.persist(); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr.append(chunk); job.heartbeatAt = new Date().toISOString(); void this.persist(); });
      child.on("close", (code, signal) => {
        if (expiryTimer) clearTimeout(expiryTimer);
        job.exitCode = code ?? undefined;
        job.signal = signal ?? undefined;
        job.status = signal ? "killed" : code === 0 ? "exited" : "failed";
        job.endedAt = new Date().toISOString();
        stdout.close(); stderr.close();
        this.processes.delete(id); this.writers.delete(id);
        void this.persist();
      });
      child.on("error", () => {
        if (expiryTimer) clearTimeout(expiryTimer);
        job.status = "failed"; job.endedAt = new Date().toISOString();
        stdout.close(); stderr.close();
        this.processes.delete(id); this.writers.delete(id);
        void this.persist();
      });
      child.unref();
      await this.persist();
      return {
        ok: true,
        output:
          `Background job started: id=${id} (canonical job ID) pid=${child.pid ?? "?"}\n` +
          `Use shell.tail {"id":"${id}"} or shell.jobs; do not use the artifact filename as the id.\n` +
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
      job.status = "failed"; job.endedAt = new Date().toISOString(); await this.persist();
      return { ok: false, output: `Failed to start job: ${error instanceof Error ? error.message : String(error)}`, exitCode: 1 };
    }
  }

  listJobs(): ToolResult {
    if (this.jobs.size === 0) return { ok: true, output: "No background jobs." };
    const lines = [...this.jobs.values()].map((job) => {
      const elapsedEnd = job.endedAt ? new Date(job.endedAt).getTime() : Date.now();
      const elapsed = Math.max(0, Math.round((elapsedEnd - new Date(job.startedAt).getTime()) / 1000));
      const health = job.status === "running" ? (processAlive(job.pid) ? "alive" : "unresponsive") : "terminal";
      return `[${job.id}] ${job.status} health=${health} exit=${job.exitCode ?? "?"} ${elapsed}s  ${job.commandDisplay.slice(0, 60)}`;
    });
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
    return resolved ? this.jobs.get(resolved) : undefined;
  }

  async tailJob(id: string, bytesOrCursor?: number | TailCursor): Promise<ToolResult> {
    const resolved = this.resolveJobId(id);
    const job = resolved ? this.jobs.get(resolved) : undefined;
    if (!job) {
      const known = [...this.jobs.keys()].join(", ") || "none";
      return { ok: false, output: `Job "${id}" not found. Canonical job IDs: ${known}.`, exitCode: 1 };
    }
    const cursor = typeof bytesOrCursor === "number" ? { bytes: bytesOrCursor } : (bytesOrCursor ?? {});
    const stream = cursor.stream ?? "combined";
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
      const nextOffset = start + (length - remaining);
      return {
        ok: true,
        output:
          `[${job.id}] ${job.status} exit=${job.exitCode ?? "?"} signal=${job.signal ?? "?"} ` +
          `stream=${stream} offset=${start} nextOffset=${nextOffset} total=${total}:\n` +
          Buffer.concat(parts).toString("utf8"),
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
    job.status = "stopping"; await this.persist();
    this.abortControllers.get(id)?.abort();
    const pid = job.pid;
    const send = (signal: NodeJS.Signals): boolean => {
      if (!pid) return false;
      try { process.platform !== "win32" && job.processGroupId ? process.kill(-job.processGroupId, signal) : process.kill(pid, signal); return true; } catch { return !processAlive(pid); }
    };
    const graceful = options?.signal ?? "SIGTERM";
    if (!send(graceful) && processAlive(pid)) { job.status = "running"; await this.persist(); return { ok: false, output: `Failed to signal job "${id}".`, exitCode: 1 }; }
    const waitForExit = async (ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) { if (!processAlive(pid)) return true; await new Promise((resolve) => setTimeout(resolve, 25)); }
      return !processAlive(pid);
    };
    let stopped = await waitForExit(options?.graceMs ?? 2_000);
    let actualSignal: NodeJS.Signals = graceful;
    if (!stopped && options?.escalate !== false) { actualSignal = "SIGKILL"; send(actualSignal); stopped = await waitForExit(1_000); }
    if (!stopped) { job.status = "running"; await this.persist(); return { ok: false, output: `Job "${id}" remains alive after ${actualSignal}.`, exitCode: 1 }; }
    job.status = "killed"; job.signal = actualSignal; job.endedAt = new Date().toISOString();
    this.abortControllers.delete(id); this.processes.delete(id); this.writers.get(id)?.stdout.close(); this.writers.get(id)?.stderr.close(); this.writers.delete(id);
    await this.persist();
    return { ok: true, output: `Job "${id}" stopped and termination verified (${actualSignal}).` };
  }

  getRunningJobs(): BackgroundJob[] { return [...this.jobs.values()].filter((job) => job.status === "running" || job.status === "starting" || job.status === "stopping"); }
  getRecentJobs(limit = 50): BackgroundJob[] { return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit); }

  private loadAndReconcile(): void {
    try {
      if (!existsSync(this.registryPath)) return;
      const parsed = JSON.parse(readFileSync(this.registryPath, "utf8")) as PersistedRegistry;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.jobs)) return;
      for (const job of parsed.jobs) {
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
      }
      this.persistSync();
    } catch { /* Corrupt registries are ignored, never trusted as running. */ }
  }

  private registry(): PersistedRegistry { return { schemaVersion: 1, jobs: [...this.jobs.values()] }; }
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
