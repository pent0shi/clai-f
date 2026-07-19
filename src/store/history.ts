import {
  appendFile,
  copyFile,
  mkdir,
  readdir,
  open,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
  chown,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import {
  isInternalChatMessage,
  type ChatMessage,
  type ToolCall,
  type ToolResult,
} from "../types.js";
import type { TranscriptItem } from "../tui/state.js";
import { redactSecrets } from "../llm/provider.js";
import { getConfig } from "./config.js";
import { safeCwd } from "../os/cwd.js";
import { fixOwner, fixOwnerSync, handlePermissionError, safeExists } from "../os/permissions.js";
import { getHistoryDir } from "./paths.js";
import { getActiveSessionWorkspace } from "./session-workspace.js";

/** Live paths so CLAI_DATA_DIR / CLAI_HISTORY_DIR always apply (and tests work). */
function historyDirPath(): string {
  return getHistoryDir();
}
function dbFilePath(): string {
  return join(historyDirPath(), "history.db");
}
function jsonlFilePath(): string {
  return join(historyDirPath(), "history.jsonl");
}
function jsonlLockFilePath(): string {
  return join(historyDirPath(), "history.jsonl.lock");
}
function jsonlLockReaperPath(): string {
  return join(historyDirPath(), "history.jsonl.lock.reaper");
}
/** Sessions pruned by retention land here — never hard-deleted on autosave. */
function archiveFilePath(): string {
  return join(historyDirPath(), "history-archive.jsonl");
}
/** Rolling pre-write snapshots of the active history file. */
function backupDirPath(): string {
  return join(historyDirPath(), "history-backups");
}
/** Max rolling backups kept under history-backups/. */
const MAX_HISTORY_BACKUPS = 12;

const sqliteModuleName = "better-sqlite3";

/** Persisted token/context footer snapshot (survives /history resume). */
export interface PersistedContextUsage {
  contextTokens: number;
  contextLimit?: number | undefined;
  lastCompletionTokens?: number | undefined;
  sessionPromptTokens?: number | undefined;
  sessionCompletionTokens?: number | undefined;
  exact: boolean;
}

export interface HistoryRecord {
  id: string;
  /** Unique writer generation, compared before the per-writer revision. */
  writerGeneration?: string | undefined;
  /**
   * Monotonic whole-snapshot revision within one writer generation. Unlike
   * updatedAt, this records capture order rather than I/O completion order.
   */
  revision?: number | undefined;
  name?: string | undefined;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  messages: ChatMessage[];
  /**
   * Optional TUI display transcript. Older records only have `messages`;
   * they still restore as user/assistant summaries.
   */
  transcript?: TranscriptItem[] | undefined;
  /**
   * Last known context fill (prefer exact API usage). Without this, resume
   * falls back to a cheap estimate that under-counts vs live turns.
   */
  contextUsage?: PersistedContextUsage | undefined;
  /**
   * Session workspace folder name under `{tmpdir}/clai/`
   * (e.g. `a3f9c1-18-07-2026-14-24-23`). Bound on resume so scratch +
   * tool outputs stay isolated per history session.
   */
  workspaceFolder?: string | undefined;
  /** 6-digit hex code that prefixes {@link workspaceFolder}. */
  workspaceCode?: string | undefined;
}

/** Snapshot the active session workspace for history persistence. */
function workspaceFieldsFromActive(existing?: HistoryRecord): {
  workspaceFolder?: string | undefined;
  workspaceCode?: string | undefined;
} {
  // Prefer the already-persisted folder so rebinding mid-session never
  // renames a live workspace out from under open artifact paths.
  if (existing?.workspaceFolder) {
    return {
      workspaceFolder: existing.workspaceFolder,
      workspaceCode: existing.workspaceCode,
    };
  }
  const active = getActiveSessionWorkspace();
  if (active) {
    return {
      workspaceFolder: active.folderName,
      workspaceCode: active.code,
    };
  }
  return {};
}

export interface ToolCallRecord {
  id: string;
  sessionId: string;
  createdAt: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  exitCode?: number | undefined;
  output: string;
}

interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): Statement;
}

type DatabaseCtor = new (path: string) => DatabaseLike;

let cachedDb: DatabaseLike | undefined;
let sqliteUnavailable = false;
let cachedSessionList:
  | { historyDir: string; records: HistoryRecord[]; cachedAt: number }
  | undefined;
let sessionListGeneration = 0;
/** Keep repeated /history opens fast while bounding cross-process staleness. */
const SESSION_LIST_CACHE_TTL_MS = 1_000;

function invalidateSessionListCache(): void {
  sessionListGeneration += 1;
  cachedSessionList = undefined;
}

async function loadDatabase(): Promise<DatabaseLike | undefined> {
  if (cachedDb) return cachedDb;
  if (sqliteUnavailable) return undefined;
  try {
    await mkdir(historyDirPath(), { recursive: true });
    await fixOwner(historyDirPath());
    const imported = (await import(sqliteModuleName)) as {
      default?: DatabaseCtor;
    } & DatabaseCtor;
    const Ctor = imported.default ?? imported;
    cachedDb = new Ctor(dbFilePath());
    fixOwnerSync(dbFilePath());
    cachedDb.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        writer_generation TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        cwd TEXT NOT NULL,
        messages_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        name TEXT NOT NULL,
        args_json TEXT NOT NULL,
        ok INTEGER NOT NULL,
        exit_code INTEGER,
        output TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_session_id ON tool_calls(session_id);
    `);
    const sessionColumns = cachedDb
      .prepare("PRAGMA table_info(sessions)")
      .all() as Array<{ name?: string }>;
    if (!sessionColumns.some((column) => column.name === "writer_generation")) {
      cachedDb.exec("ALTER TABLE sessions ADD COLUMN writer_generation TEXT;");
    }
    if (!sessionColumns.some((column) => column.name === "revision")) {
      cachedDb.exec(
        "ALTER TABLE sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;",
      );
    }
    return cachedDb;
  } catch (err: any) {
    if (err && err.code === "EACCES") {
      handlePermissionError(err);
    }
    sqliteUnavailable = true;
    return undefined;
  }
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function scrubMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    const { images: _images, ...rest } = message;
    // Drop image bytes from persisted history — base64 blobs would bloat the
    // store and they're not useful to replay. The text content (which
    // includes a note that an image was attached) is kept and redacted.
    return { ...rest, content: redactSecrets(message.content) };
  });
}

function scrubTranscript(items?: TranscriptItem[] | undefined): TranscriptItem[] | undefined {
  if (!items) return undefined;
  // Drop UI chrome notices — they must never bloat saved history item counts.
  const durable = items.filter((item) => item.kind !== "notice");
  return durable.map((item) => {
    switch (item.kind) {
      case "user":
        return { ...item, text: redactSecrets(item.text), done: true };
      case "assistant":
        return { ...item, text: redactSecrets(item.text), streaming: false, done: true };
      case "thinking":
        return { ...item, content: redactSecrets(item.content), done: true };
      case "tool":
        return {
          ...item,
          argsDisplay: redactSecrets(item.argsDisplay),
          output: redactSecrets(item.output),
          summary: item.summary ? redactSecrets(item.summary) : item.summary,
          status: item.status === "running" ? "ok" : item.status,
          done: true,
        };
      case "plan":
        return { ...item, done: true };
      case "compacted":
        return {
          ...item,
          summary: redactSecrets(item.summary),
          originalItems: scrubTranscript(item.originalItems) ?? [],
          done: true,
        };
      default: {
        // notice already filtered; keep exhaustiveness for future kinds
        return item;
      }
    }
  });
}

const JSONL_LOCK_STALE_MS = 60_000;
const JSONL_LOCK_RETRIES = 200;

/** Serialize stale-lock reclamation and recheck the owner while holding it. */
async function reapStaleJsonlLock(): Promise<void> {
  let reaper: Awaited<ReturnType<typeof open>>;
  const reaperToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    reaper = await open(jsonlLockReaperPath(), "wx", 0o600);
    try {
      await reaper.writeFile(reaperToken);
    } catch (error) {
      await reaper.close().catch(() => undefined);
      await rm(jsonlLockReaperPath(), { force: true }).catch(() => undefined);
      throw error;
    }
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    const existingToken = await readFile(jsonlLockReaperPath(), "utf8").catch(
      () => undefined,
    );
    const reaperStat = await stat(jsonlLockReaperPath()).catch(() => undefined);
    if (
      !reaperStat ||
      Date.now() - reaperStat.mtimeMs <= JSONL_LOCK_STALE_MS
    ) {
      return;
    }
    const confirmed = await readFile(jsonlLockReaperPath(), "utf8").catch(
      () => undefined,
    );
    if (confirmed !== undefined && confirmed === existingToken) {
      await rm(jsonlLockReaperPath(), { force: true }).catch(() => undefined);
    }
    return;
  }
  try {
    const token = await readFile(jsonlLockFilePath(), "utf8").catch(
      () => undefined,
    );
    const lockStat = await stat(jsonlLockFilePath()).catch(() => undefined);
    if (!lockStat || Date.now() - lockStat.mtimeMs <= JSONL_LOCK_STALE_MS) {
      return;
    }
    // The live owner refreshes mtime periodically. A stale marker—including
    // an empty marker left between open/write—is therefore safe to reclaim.
    const confirmed = await readFile(jsonlLockFilePath(), "utf8").catch(
      () => undefined,
    );
    if (confirmed !== undefined && confirmed === token) {
      await rm(jsonlLockFilePath(), { force: true });
    }
  } finally {
    await reaper.close().catch(() => undefined);
    const currentReaper = await readFile(jsonlLockReaperPath(), "utf8").catch(
      () => undefined,
    );
    if (currentReaper === reaperToken) {
      await rm(jsonlLockReaperPath(), { force: true }).catch(() => undefined);
    }
  }
}

/**
 * Cross-process lock around JSONL read/modify/rename. Atomic rename protects
 * readers, but without this lock two clai processes can both read the same
 * base file and then each replace it, dropping whichever session they did not
 * observe. The lock is transient and stale crash leftovers self-heal.
 */
async function acquireJsonlWriteLock(): Promise<() => Promise<void>> {
  await mkdir(historyDirPath(), { recursive: true });
  for (let attempt = 0; attempt < JSONL_LOCK_RETRIES; attempt += 1) {
    try {
      const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const handle = await open(jsonlLockFilePath(), "wx", 0o600);
      try {
        await handle.writeFile(token);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(jsonlLockFilePath(), { force: true }).catch(() => undefined);
        throw error;
      }
      const heartbeat = setInterval(() => {
        const now = new Date();
        void utimes(jsonlLockFilePath(), now, now).catch(() => undefined);
      }, JSONL_LOCK_STALE_MS / 3);
      heartbeat.unref();
      return async () => {
        clearInterval(heartbeat);
        await handle.close().catch(() => undefined);
        const currentToken = await readFile(jsonlLockFilePath(), "utf8").catch(
          () => undefined,
        );
        if (currentToken === token) {
          await rm(jsonlLockFilePath(), { force: true }).catch(() => undefined);
        }
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      await reapStaleJsonlLock();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("timed out waiting for history write lock");
}

/**
 * Serializes every JSONL mutation through a single promise chain so concurrent
 * autosaves never interleave a read with another writer's truncating write.
 * Without this, a reader could observe a half-written (or momentarily empty)
 * file and then persist back only its own record, wiping every other session.
 */
let jsonlWriteChain: Promise<void> = Promise.resolve();
/** Shared one-time orphan/archive recovery; writes await it, UI listings may not. */
let recoveryPromise: Promise<void> | undefined;

function mutateJsonl(
  update: (records: HistoryRecord[]) => HistoryRecord[],
): Promise<void> {
  invalidateSessionListCache();
  const run = jsonlWriteChain.then(async () => {
    try {
      await ensureHistoryRecovered();
      const releaseLock = await acquireJsonlWriteLock();
      try {
        const current = await readJsonlRecordsFrom(jsonlFilePath());
        const next = update(current);
        await writeJsonlAtomic(next);
        // A list may have been loaded after the pre-write invalidation but
        // before the atomic rename completed. Never leave that snapshot cached.
        invalidateSessionListCache();
      } finally {
        await releaseLock();
      }
    } catch (err: any) {
      handlePermissionError(err);
    }
  });
  // Keep the chain alive even if this task rejects, so later writes still run.
  jsonlWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function updatedAtMs(record: HistoryRecord): number {
  const t = Date.parse(record.updatedAt || record.createdAt || "");
  return Number.isFinite(t) ? t : 0;
}

function historyRevision(record: HistoryRecord | undefined): number {
  const revision = record?.revision;
  return typeof revision === "number" &&
    Number.isSafeInteger(revision) &&
    revision > 0
    ? revision
    : 0;
}

function historyWriterGeneration(
  record: HistoryRecord | undefined,
): string | undefined {
  const generation = record?.writerGeneration;
  return typeof generation === "string" && generation.length > 0
    ? generation
    : undefined;
}

/**
 * Compare snapshots by writer generation, then capture revision. Legacy rows
 * without a generation retain revision/timestamp fallback for compatibility.
 */
export function compareHistoryFreshness(
  left: HistoryRecord,
  right: HistoryRecord,
): number {
  const leftGeneration = historyWriterGeneration(left);
  const rightGeneration = historyWriterGeneration(right);
  if (leftGeneration || rightGeneration) {
    if (!leftGeneration) return -1;
    if (!rightGeneration) return 1;
    const generationDelta = leftGeneration.localeCompare(rightGeneration);
    if (generationDelta !== 0) return generationDelta;
  }

  const revisionDelta = historyRevision(left) - historyRevision(right);
  if (revisionDelta !== 0) return revisionDelta;
  if (historyRevision(left) > 0) return 0;
  return updatedAtMs(left) - updatedAtMs(right);
}

function freshestHistoryRecord(
  records: readonly HistoryRecord[],
): HistoryRecord | undefined {
  let freshest: HistoryRecord | undefined;
  for (const record of records) {
    if (!freshest || compareHistoryFreshness(record, freshest) > 0) {
      freshest = record;
    }
  }
  return freshest;
}

/** Keep the newest captured version of each session id. */
export function dedupeHistoryById(
  records: readonly HistoryRecord[],
): HistoryRecord[] {
  const byId = new Map<string, HistoryRecord>();
  for (const record of records) {
    if (!record?.id) continue;
    const prev = byId.get(record.id);
    // Preserve the first source on an exact tie. JSONL is passed first during
    // cross-backend merge and is the durable canonical copy.
    if (!prev || compareHistoryFreshness(record, prev) > 0) {
      byId.set(record.id, record);
    }
  }
  return [...byId.values()];
}

export function sortHistoryByUpdatedDesc(
  records: readonly HistoryRecord[],
): HistoryRecord[] {
  return [...records].sort((a, b) => updatedAtMs(b) - updatedAtMs(a));
}

/**
 * Apply retention by *recency* (not file order). Pruned sessions are returned
 * separately so callers can archive them — never silently destroy history.
 * limit <= 0 means unlimited (keep everything).
 */
export function partitionByRetention(
  records: readonly HistoryRecord[],
  limit: number,
): { kept: HistoryRecord[]; pruned: HistoryRecord[] } {
  const unique = sortHistoryByUpdatedDesc(dedupeHistoryById(records));
  if (!limit || limit <= 0 || unique.length <= limit) {
    return { kept: unique, pruned: [] };
  }
  return {
    kept: unique.slice(0, limit),
    pruned: unique.slice(limit),
  };
}

/** Read and parse all valid JSONL records from any path. */
async function readJsonlRecordsFrom(path: string): Promise<HistoryRecord[]> {
  if (!(await safeExists(path))) return [];
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as HistoryRecord;
        } catch {
          return null;
        }
      })
      .filter((record): record is HistoryRecord => record !== null);
  } catch (err: any) {
    if (err && err.code === "EACCES") handlePermissionError(err);
    return [];
  }
}

async function appendRecordsToFile(
  path: string,
  records: readonly HistoryRecord[],
): Promise<void> {
  if (records.length === 0) return;
  await mkdir(historyDirPath(), { recursive: true });
  await fixOwner(historyDirPath());
  const chunk = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
  // Append is best-effort durable; archive growth is unbounded by design so
  // retention never permanently loses a conversation.
  await appendFile(path, chunk, { mode: 0o600 });
  await fixOwner(path).catch(() => undefined);
}

async function backupActiveHistory(): Promise<void> {
  if (!(await safeExists(jsonlFilePath()))) return;
  try {
    await mkdir(backupDirPath(), { recursive: true });
    await fixOwner(backupDirPath());
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = join(backupDirPath(), `history-${stamp}.jsonl`);
    await copyFile(jsonlFilePath(), dest);
    await fixOwner(dest).catch(() => undefined);
    // Keep only the newest N backups.
    const names = (await readdir(backupDirPath()))
      .filter((n) => n.startsWith("history-") && n.endsWith(".jsonl"))
      .sort()
      .reverse();
    for (const old of names.slice(MAX_HISTORY_BACKUPS)) {
      await rm(join(backupDirPath(), old), { force: true }).catch(() => undefined);
    }
  } catch {
    // Backup is best-effort; never block the autosave path.
  }
}

/**
 * Scan leftover write temps + the archive for sessions missing from the
 * active file and merge them back. Fixes history that was pruned by the old
 * slice(-200) retention or left in .tmp after a crashed rename.
 */
export async function recoverOrphanedHistory(): Promise<{
  recovered: number;
  sources: string[];
}> {
  const sources: string[] = [];
  const extras: HistoryRecord[] = [];
  const releaseLock = await acquireJsonlWriteLock();
  try {

  try {
    const names = await readdir(historyDirPath());
    for (const name of names) {
      // Live write temps: history.jsonl.<pid>.<stamp>.tmp
      if (
        name.startsWith("history.jsonl.") &&
        name.endsWith(".tmp")
      ) {
        const path = join(historyDirPath(), name);
        const rows = await readJsonlRecordsFrom(path);
        if (rows.length === 0) {
          // Empty crash leftovers — safe to remove.
          await rm(path, { force: true }).catch(() => undefined);
          continue;
        }
        extras.push(...rows);
        sources.push(name);
      }
    }
  } catch {
    /* dir may not exist yet */
  }

  // Also fold in archive (sessions previously pruned).
  if (await safeExists(archiveFilePath())) {
    const archived = await readJsonlRecordsFrom(archiveFilePath());
    if (archived.length > 0) {
      extras.push(...archived);
      sources.push("history-archive.jsonl");
    }
  }

  // Rolling backups (last-resort recovery of wiped active files).
  try {
    if (await safeExists(backupDirPath())) {
      const backups = (await readdir(backupDirPath()))
        .filter((n) => n.startsWith("history-") && n.endsWith(".jsonl"))
        .sort()
        .reverse()
        .slice(0, 3);
      for (const name of backups) {
        const rows = await readJsonlRecordsFrom(join(backupDirPath(), name));
        if (rows.length > 0) {
          extras.push(...rows);
          sources.push(`history-backups/${name}`);
        }
      }
    }
  } catch {
    /* ignore */
  }

  if (extras.length === 0) return { recovered: 0, sources: [] };

  const active = await readJsonlRecordsFrom(jsonlFilePath());
  const activeById = new Map(active.map((record) => [record.id, record]));
  const merged = dedupeHistoryById([...active, ...extras]);
  const recoveredCount = merged.filter((record) => {
    const previous = activeById.get(record.id);
    return !previous || compareHistoryFreshness(record, previous) > 0;
  }).length;
  if (recoveredCount === 0) {
    return { recovered: 0, sources };
  }

  // Write WITHOUT applying retention so recovery cannot re-prune.
  await mkdir(historyDirPath(), { recursive: true });
  await fixOwner(historyDirPath());
  if (await safeExists(jsonlFilePath())) await backupActiveHistory();
  const sorted = sortHistoryByUpdatedDesc(merged);
  // Stable chronological file order (oldest first) for append-friendly diffs.
  sorted.reverse();
  const body = sorted.length
    ? `${sorted.map((item) => JSON.stringify(item)).join("\n")}\n`
    : "";
  const tmpFile = `${jsonlFilePath()}.recover.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFile(tmpFile, body, { mode: 0o600 });
  try {
    await rename(tmpFile, jsonlFilePath());
  } catch (err) {
    await rm(tmpFile, { force: true }).catch(() => undefined);
    throw err;
  }
  await fixOwner(jsonlFilePath());

  // Successful recovery: drop non-empty orphan temps we already merged.
  for (const name of sources) {
    if (name.startsWith("history.jsonl.") && name.endsWith(".tmp")) {
      await rm(join(historyDirPath(), name), { force: true }).catch(() => undefined);
    }
  }

    return { recovered: recoveredCount, sources };
  } finally {
    await releaseLock();
  }
}

function startHistoryRecovery(): Promise<void> {
  if (!recoveryPromise) {
    recoveryPromise = recoverOrphanedHistory()
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        // A background recovery may have merged archive/temp records after a
        // picker list was published; force the next /history to refresh.
        invalidateSessionListCache();
      });
  }
  return recoveryPromise;
}

async function ensureHistoryRecovered(): Promise<void> {
  await startHistoryRecovery();
}

/**
 * Apply retention (archive pruned sessions) and write the active file
 * atomically. Never hard-deletes pruned chats — they go to history-archive.jsonl.
 */
async function writeJsonlAtomic(records: HistoryRecord[]): Promise<void> {
  invalidateSessionListCache();
  await mkdir(historyDirPath(), { recursive: true });
  await fixOwner(historyDirPath());

  const limit = getConfig().historyRetentionLimit;
  const { kept, pruned } = partitionByRetention(records, limit);

  if (pruned.length > 0) {
    // Durable archive before the active file shrinks.
    await appendRecordsToFile(archiveFilePath(), pruned);
  }

  // If we would shrink (or replace) the on-disk set, snapshot first.
  if (await safeExists(jsonlFilePath())) {
    const existing = await readJsonlRecordsFrom(jsonlFilePath());
    if (kept.length < existing.length || pruned.length > 0) {
      await backupActiveHistory();
    }
  }

  // Refuse to write an empty file over a non-empty one unless the caller
  // intentionally has zero records (e.g. clear after archiving).
  if (kept.length === 0 && (await safeExists(jsonlFilePath()))) {
    const existing = await readJsonlRecordsFrom(jsonlFilePath());
    if (existing.length > 0 && records.length > 0) {
      // Something went wrong in partitioning — keep the safer set.
      const safe = sortHistoryByUpdatedDesc(dedupeHistoryById(existing));
      safe.reverse();
      const body = `${safe.map((item) => JSON.stringify(item)).join("\n")}\n`;
      const tmpFile = `${jsonlFilePath()}.${process.pid}.${Date.now().toString(36)}.tmp`;
      await writeFile(tmpFile, body, { mode: 0o600 });
      try {
        await rename(tmpFile, jsonlFilePath());
      } catch (err) {
        await rm(tmpFile, { force: true }).catch(() => undefined);
        throw err;
      }
      await fixOwner(jsonlFilePath());
      return;
    }
  }

  // File order: oldest → newest (matches classic append style).
  const ordered = sortHistoryByUpdatedDesc(kept);
  ordered.reverse();
  const body = ordered.length
    ? `${ordered.map((item) => JSON.stringify(item)).join("\n")}\n`
    : "";
  const tmpFile = `${jsonlFilePath()}.${process.pid}.${Date.now().toString(36)}.${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`;
  await writeFile(tmpFile, body, { mode: 0o600 });
  try {
    await rename(tmpFile, jsonlFilePath());
  } catch (err) {
    // Keep the temp file on rename failure so recovery can pick it up —
    // only remove empty temps.
    try {
      const st = await readFile(tmpFile).catch(() => null);
      if (!st || st.length === 0) {
        await rm(tmpFile, { force: true }).catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
    throw err;
  }
  await fixOwner(jsonlFilePath());
}

function serializeSessionPayload(record: HistoryRecord): string {
  return JSON.stringify({
    messages: record.messages,
    transcript: record.transcript,
    ...(record.contextUsage ? { contextUsage: record.contextUsage } : {}),
    ...(record.workspaceFolder
      ? {
          workspaceFolder: record.workspaceFolder,
          workspaceCode: record.workspaceCode,
        }
      : {}),
  });
}

/** SQLite mirror write with atomic generation/revision rejection. */
function upsertSqlite(db: DatabaseLike, record: HistoryRecord): void {
  db.prepare(
    `INSERT INTO sessions
       (id, name, created_at, updated_at, writer_generation, revision, cwd, messages_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       writer_generation = excluded.writer_generation,
       revision = excluded.revision,
       cwd = excluded.cwd,
       messages_json = excluded.messages_json
     WHERE (sessions.writer_generation IS NULL AND excluded.writer_generation IS NOT NULL)
        OR excluded.writer_generation > sessions.writer_generation
        OR (excluded.writer_generation = sessions.writer_generation
            AND excluded.revision >= sessions.revision)
        OR (sessions.writer_generation IS NULL AND excluded.writer_generation IS NULL
            AND excluded.revision >= sessions.revision)`,
  ).run(
    record.id,
    record.name ?? null,
    record.createdAt,
    record.updatedAt,
    historyWriterGeneration(record) ?? null,
    historyRevision(record),
    record.cwd,
    serializeSessionPayload(record),
  );
}

export async function saveSession(
  messages: ChatMessage[],
  name?: string | undefined,
  transcript?: TranscriptItem[] | undefined,
  contextUsage?: PersistedContextUsage | undefined,
  revision?: number | undefined,
  writerGeneration?: string | undefined,
): Promise<HistoryRecord> {
  // Auto-derive a readable name from the first real user message if none provided
  if (!name) {
    const firstUser = messages.find(
      (m) => m.role === "user" && !isInternalChatMessage(m),
    );
    if (firstUser) {
      const preview = firstUser.content.slice(0, 60).replace(/\n/g, " ").trim();
      name = preview + (firstUser.content.length > 60 ? "…" : "");
    }
  }

  const now = new Date().toISOString();
  const workspace = workspaceFieldsFromActive();
  const record: HistoryRecord = {
    id: newId(),
    ...(writerGeneration ? { writerGeneration } : {}),
    revision:
      typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0
        ? revision
        : 1,
    name,
    createdAt: now,
    updatedAt: now,
    cwd: safeCwd(),
    messages: scrubMessages(messages),
    transcript: scrubTranscript(transcript),
    ...(contextUsage ? { contextUsage } : {}),
    ...workspace,
  };

  // Private mode: never persist chat content. Caller still gets a record
  // back (so /save echoes a usable id) but nothing hits disk.
  if (getConfig().privateMode) return record;

  invalidateSessionListCache();
  const db = await loadDatabase();

  const canonical = await upsertJsonl(record);
  if (db) {
    upsertSqlite(db, canonical);
    await enforceSqliteRetention(db);
    invalidateSessionListCache();
  }
  return canonical;
}

export async function upsertSession(
  id: string,
  messages: ChatMessage[],
  name?: string | undefined,
  transcript?: TranscriptItem[] | undefined,
  contextUsage?: PersistedContextUsage | undefined,
  revision?: number | undefined,
  writerGeneration?: string | undefined,
): Promise<HistoryRecord> {
  const existing = await getSession(id);
  const requestedRevision =
    typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0
      ? revision
      : undefined;
  const firstUser = messages.find(
    (message) => message.role === "user" && !isInternalChatMessage(message),
  );
  const derivedName = firstUser
    ? firstUser.content.slice(0, 60).replace(/\n/g, " ").trim() +
      (firstUser.content.length > 60 ? "…" : "")
    : undefined;
  const now = new Date().toISOString();
  const workspace = workspaceFieldsFromActive(existing);
  const effectiveWriterGeneration =
    writerGeneration ?? existing?.writerGeneration;
  const record: HistoryRecord = {
    id,
    ...(effectiveWriterGeneration
      ? { writerGeneration: effectiveWriterGeneration }
      : {}),
    revision:
      requestedRevision ??
      (writerGeneration ? 1 : historyRevision(existing) + 1),
    name: name ?? existing?.name ?? derivedName,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    cwd: safeCwd(),
    messages: scrubMessages(messages),
    transcript: scrubTranscript(transcript),
    ...(contextUsage
      ? { contextUsage }
      : existing?.contextUsage
        ? { contextUsage: existing.contextUsage }
        : {}),
    ...workspace,
  };

  if (
    existing &&
    requestedRevision !== undefined &&
    compareHistoryFreshness(record, existing) <= 0
  ) {
    return existing;
  }
  if (getConfig().privateMode) return record;

  invalidateSessionListCache();
  const db = await loadDatabase();
  const canonical = await upsertJsonl(record);
  if (db) {
    upsertSqlite(db, canonical);
    await enforceSqliteRetention(db);
    invalidateSessionListCache();
  }
  return canonical;
}

async function enforceSqliteRetention(db: DatabaseLike): Promise<void> {
  const limit = getConfig().historyRetentionLimit;
  if (!limit || limit <= 0) return;
  // Archive rows about to be deleted, then delete — never hard-drop without
  // a JSONL archive copy.
  try {
    const doomed = db
      .prepare(
        `SELECT id, name, created_at, updated_at, writer_generation, revision, cwd, messages_json FROM sessions
         WHERE id NOT IN (SELECT id FROM sessions ORDER BY updated_at DESC LIMIT ?)`,
      )
      .all(Math.floor(limit)) as unknown[];
    const records = doomed.map(rowToSession);
    if (records.length > 0) await appendRecordsToFile(archiveFilePath(), records);
  } catch {
    /* archive best-effort */
  }
  db.exec(
    `DELETE FROM sessions WHERE id NOT IN (SELECT id FROM sessions ORDER BY updated_at DESC LIMIT ${Math.floor(limit)});`,
  );
}

async function upsertJsonl(record: HistoryRecord): Promise<HistoryRecord> {
  let canonical = record;
  await mutateJsonl((records) => {
    const idx = records.findIndex((item) => item.id === record.id);
    if (idx >= 0) {
      const current = records[idx];
      if (current && compareHistoryFreshness(record, current) > 0) {
        records[idx] = record;
      } else if (current) {
        canonical = current;
      }
    } else {
      records.push(record);
    }
    return records;
  });
  return canonical;
}

export async function saveToolCall(
  sessionId: string,
  call: ToolCall,
  result: ToolResult,
): Promise<ToolCallRecord> {
  const record: ToolCallRecord = {
    id: newId(),
    sessionId,
    createdAt: new Date().toISOString(),
    name: call.name,
    args: call.args,
    ok: result.ok,
    exitCode: result.exitCode,
    output: redactSecrets(result.output),
  };
  invalidateSessionListCache();
  const db = await loadDatabase();
  if (db) {
    db.prepare(
      "INSERT INTO tool_calls (id, session_id, created_at, name, args_json, ok, exit_code, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      record.id,
      record.sessionId,
      record.createdAt,
      record.name,
      JSON.stringify(record.args),
      record.ok ? 1 : 0,
      record.exitCode ?? null,
      record.output,
    );
  }
  return record;
}

function rowToSession(row: unknown): HistoryRecord {
  const data = row as {
    id: string;
    name: string | null;
    created_at: string;
    updated_at: string;
    writer_generation?: string | null | undefined;
    revision?: number | undefined;
    cwd: string;
    messages_json: string;
  };
  const parsed = JSON.parse(data.messages_json) as
    | ChatMessage[]
    | {
        messages?: ChatMessage[];
        transcript?: TranscriptItem[];
        contextUsage?: PersistedContextUsage;
        workspaceFolder?: string;
        workspaceCode?: string;
      };
  const messages = Array.isArray(parsed) ? parsed : parsed.messages ?? [];
  return {
    id: data.id,
    writerGeneration: data.writer_generation ?? undefined,
    revision:
      typeof data.revision === "number" && data.revision > 0
        ? data.revision
        : undefined,
    name: data.name ?? undefined,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    cwd: data.cwd,
    messages,
    transcript: Array.isArray(parsed) ? undefined : parsed.transcript,
    contextUsage: Array.isArray(parsed) ? undefined : parsed.contextUsage,
    workspaceFolder: Array.isArray(parsed) ? undefined : parsed.workspaceFolder,
    workspaceCode: Array.isArray(parsed) ? undefined : parsed.workspaceCode,
  };
}

async function listJsonlSessions(limit: number): Promise<HistoryRecord[]> {
  try {
    const records = sortHistoryByUpdatedDesc(
      dedupeHistoryById(await readJsonlRecordsFrom(jsonlFilePath())),
    );
    if (!limit || limit <= 0) return records;
    return records.slice(0, limit);
  } catch (err: any) {
    if (err && err.code === "EACCES") {
      handlePermissionError(err);
    }
    return [];
  }
}


function mergeSessionLists(
  ...lists: readonly (readonly HistoryRecord[])[]
): HistoryRecord[] {
  return sortHistoryByUpdatedDesc(dedupeHistoryById(lists.flat()));
}

export async function listSessions(
  limit = 20,
  options: { recovery?: "blocking" | "background" } = {},
): Promise<HistoryRecord[]> {
  if (options.recovery === "background") {
    void startHistoryRecovery();
  } else {
    await ensureHistoryRecovered();
  }

  const cacheKey = historyDirPath();
  const now = Date.now();
  if (
    cachedSessionList?.historyDir === cacheKey &&
    now - cachedSessionList.cachedAt <= SESSION_LIST_CACHE_TTL_MS
  ) {
    const cached = cachedSessionList.records;
    return !limit || limit <= 0 ? [...cached] : cached.slice(0, limit);
  }

  // Do not let a slow pre-write/pre-recovery read overwrite a newer cache.
  // Every mutation increments this generation before and after persistence.
  const loadGeneration = sessionListGeneration;

  const [fromJsonl, db] = await Promise.all([
    listJsonlSessions(0),
    loadDatabase(),
  ]);
  let fromDb: HistoryRecord[] = [];
  if (db) {
    try {
      const rows = db
        .prepare(
          "SELECT id, name, created_at, updated_at, writer_generation, revision, cwd, messages_json FROM sessions ORDER BY updated_at DESC",
        )
        .all();
      fromDb = rows.map(rowToSession);
    } catch {
      fromDb = [];
    }
  }
  // Active + SQLite only. Archive/pruned sessions are merged back into the
  // active file by recoverOrphanedHistory() (called on /history open), so
  // they reappear there rather than staying invisible forever.
  const merged = mergeSessionLists(fromJsonl, fromDb);
  if (sessionListGeneration === loadGeneration) {
    cachedSessionList = {
      historyDir: cacheKey,
      records: merged,
      cachedAt: Date.now(),
    };
  }
  if (!limit || limit <= 0) return [...merged];
  return merged.slice(0, limit);
}

export async function getSession(
  sessionId: string,
): Promise<HistoryRecord | undefined> {
  await ensureHistoryRecovered();
  const db = await loadDatabase();
  let fromDb: HistoryRecord | undefined;
  if (db) {
    const row = db
      .prepare(
        "SELECT id, name, created_at, updated_at, writer_generation, revision, cwd, messages_json FROM sessions WHERE id = ?",
      )
      .get(sessionId);
    if (row) fromDb = rowToSession(row);
  }
  const fromJsonl = (await readJsonlRecordsFrom(jsonlFilePath())).find(
    (session) => session.id === sessionId,
  );
  // Also check archive for sessions pruned from the active set.
  const fromArchive = fromJsonl
    ? undefined
    : (await readJsonlRecordsFrom(archiveFilePath())).find((s) => s.id === sessionId);

  const candidates = [fromJsonl, fromDb, fromArchive].filter(
    (record): record is HistoryRecord => Boolean(record),
  );
  const freshest = freshestHistoryRecord(candidates);
  if (!freshest) return undefined;

  // Heal split-brain stores on selection. This is especially important across
  // upgrades where optional SQLite availability changes between launches.
  if (!fromJsonl || compareHistoryFreshness(freshest, fromJsonl) > 0) {
    await upsertJsonl(freshest);
  }
  if (db && (!fromDb || compareHistoryFreshness(freshest, fromDb) > 0)) {
    upsertSqlite(db, freshest);
    await enforceSqliteRetention(db);
    invalidateSessionListCache();
  }
  return freshest;
}

export function getHistoryPath(): string {
  // Prefer JSONL as the durable path users can inspect/backup; SQLite is
  // optional acceleration when better-sqlite3 is installed.
  return jsonlFilePath();
}


export async function clearAllHistory(): Promise<{
  cleared: boolean;
  detail: string;
}> {
  let detail = "";
  await ensureHistoryRecovered();

  try {
    const snapshot = await readJsonlRecordsFrom(jsonlFilePath());
    if (snapshot.length > 0) {
      await backupActiveHistory();
      detail += `backed up ${snapshot.length} session(s); `;
    }
  } catch (error) {
    detail += `backup error: ${error instanceof Error ? error.message : String(error)}; `;
  }

  try {
    invalidateSessionListCache();
    const db = await loadDatabase();
    if (db) {
      db.exec("DELETE FROM sessions; DELETE FROM tool_calls;");
      detail += "sqlite cleared; ";
    }
  } catch (error) {
    detail += `sqlite error: ${error instanceof Error ? error.message : String(error)}; `;
  }
  if (await safeExists(jsonlFilePath())) {
    try {
      // Move aside rather than unlink so crash mid-clear still leaves a file.
      const clearedCopy = join(
        historyDirPath(),
        `history-cleared-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
      );
      await rename(jsonlFilePath(), clearedCopy).catch(async () => {
        await copyFile(jsonlFilePath(), clearedCopy).catch(() => undefined);
        await rm(jsonlFilePath(), { force: true });
      });
      detail += `jsonl moved to ${clearedCopy} (recoverable)`;
    } catch (error) {
      detail += `jsonl error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  // Plans live alongside history (same DB / a sibling JSONL). Clearing
  // history should clear stored plans too so nothing leaks across a reset.
  try {
    const { clearAllPlans } = await import("./plan.js");
    await clearAllPlans();
    detail += "; plans cleared";
  } catch {
    /* plan store optional */
  }
  invalidateSessionListCache();
  return { cleared: true, detail: detail.trim() };
}

export function getJsonlHistoryPath(): string {
  return jsonlFilePath();
}

export function getHistoryArchivePath(): string {
  return archiveFilePath();
}

export function getHistoryBackupDir(): string {
  return backupDirPath();
}
