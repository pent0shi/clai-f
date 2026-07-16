import { mkdir, appendFile, readFile, writeFile, rm, chown } from "node:fs/promises";
import { fixOwner, fixOwnerSync, handlePermissionError, safeExists } from "../os/permissions.js";

import { join } from "node:path";
import { tmpdir } from "node:os";
import { getConfig } from "./config.js";
import { getPlanDir } from "./paths.js";
import {
  applyPlanOperation,
  validatePlanDag,
  type PlanOperation,
  type VersionedPlanStep,
  type VersionedTaskPlan,
} from "../agent/task-plan.js";

/**
 * Session-scoped plan + task persistence.
 *
 * A plan is a comprehensive, human-readable description of HOW the agent
 * intends to accomplish a multi-step goal (coding OR pentesting), paired
 * with an ordered checklist of tasks. The agent has the plan in context for
 * the whole session, marks tasks done as it completes them, and the user can
 * view it in a pager (Ctrl+P) or approve execution with /implement.
 *
 * Storage mirrors history.ts: SQLite when better-sqlite3 is available,
 * otherwise an always-present JSONL log. Plans are keyed by a session id so
 * each REPL session keeps its own plan, and resuming a session reloads it.
 */

const planDir = getPlanDir();
const jsonlFile =
  process.env.CLAI_PLAN_FILE ??
  (process.env.CLAI_PLAN_DIR || process.env.CLAI_DATA_DIR
    ? join(planDir, "plans.jsonl")
    : process.env.VITEST_WORKER_ID
    ? join(tmpdir(), `clai-plans-${process.env.VITEST_WORKER_ID}.jsonl`)
    : join(planDir, "plans.jsonl"));
const dbFile = join(planDir, "history.db");
const sqliteModuleName = "better-sqlite3";

export type TaskState = "pending" | "in_progress" | "done" | "failed" | "skipped";
export type PlanStatus = "draft" | "approved" | "in_progress" | "completed" | "abandoned";

/** Durable, task-scoped facts from successful work. These survive compaction and resume. */
export interface TaskEvidence {
  successWorkCount: number;
  lastOkTool?: string | undefined;
  sawSourceWrite?: boolean | undefined;
  sawFeatureWrite?: boolean | undefined;
  sawInstallOk?: boolean | undefined;
  sawScaffoldOk?: boolean | undefined;
  /** Local app: shell.start / npm run dev. */
  sawDevServerStart?: boolean | undefined;
  /** Local app: successful localhost HTTP probe. */
  sawLocalHttpProbeOk?: boolean | undefined;
  /** Local app: job log shows ready + URL (Vite/Next/etc.). */
  sawServerReady?: boolean | undefined;
  /** Local app: port LISTEN evidence (lsof/ss). */
  sawPortListening?: boolean | undefined;
  /** Pentest: successful remote recon tool against a target. */
  sawRemoteReconOk?: boolean | undefined;
  /** Pentest: active test / exploit-style tool against a target. */
  sawRemoteActiveTestOk?: boolean | undefined;
}

export interface PlanTask {
  id: string;
  title: string;
  state: TaskState;
  note?: string | undefined;
  /** Successful task-scoped evidence, persisted with the plan for resume safety. */
  evidence?: TaskEvidence | undefined;
  /** Model-supplied slugs (id/name) that resolve to this task via task.update. */
  aliases?: string[] | undefined;
  dependencies?: string[] | undefined;
  resourceLocks?: string[] | undefined;
  supersededBy?: string | undefined;
}

/** Durable side-channel facts that survive compaction/resume. */
export interface PlanMeta {
  projectRoot?: string | undefined;
  packageManager?: string | undefined;
  devCommand?: string | undefined;
}

export interface SessionPlan {
  schemaVersion?: 2 | undefined;
  version?: number | undefined;
  sessionId: string;
  goal: string;
  detail: string;
  tasks: PlanTask[];
  status: PlanStatus;
  kind: string;
  createdAt: string;
  updatedAt: string;
  meta?: PlanMeta | undefined;
}

function serializeTasksPayload(plan: SessionPlan): string {
  return JSON.stringify({
    schemaVersion: 2,
    version: plan.version,
    tasks: plan.tasks,
    ...(plan.meta && Object.keys(plan.meta).length > 0 ? { meta: plan.meta } : {}),
  });
}

function deserializeTasksPayload(raw: string): {
  tasks: PlanTask[];
  meta?: PlanMeta | undefined;
  version: number;
} {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return { tasks: parsed as PlanTask[], version: 1 };
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { tasks?: unknown }).tasks)
    ) {
      const obj = parsed as { tasks: PlanTask[]; meta?: PlanMeta; version?: number };
      return {
        tasks: obj.tasks,
        meta: obj.meta,
        version: typeof obj.version === "number" && obj.version >= 1 ? obj.version : 1,
      };
    }
  } catch {
    /* ignore */
  }
  return { tasks: [], version: 1 };
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

async function loadDatabase(): Promise<DatabaseLike | undefined> {
  // Tests and JSONL-fallback installs skip SQLite entirely.
  if (process.env.CLAI_PLAN_FILE || process.env.VITEST_WORKER_ID) return undefined;
  if (cachedDb) return cachedDb;
  if (sqliteUnavailable) return undefined;
  try {
    await mkdir(planDir, { recursive: true });
    await fixOwner(planDir);
    const imported = (await import(sqliteModuleName)) as {
      default?: DatabaseCtor;
    } & DatabaseCtor;
    const Ctor = imported.default ?? imported;
    cachedDb = new Ctor(dbFile);
    fixOwnerSync(dbFile);
    cachedDb.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        session_id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        detail TEXT NOT NULL,
        tasks_json TEXT NOT NULL,
        status TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    return cachedDb;
  } catch (err: any) {
    if (err && err.code === "EACCES") {
      handlePermissionError(err);
    }
    sqliteUnavailable = true;
    return undefined;
  }
}

function newTaskId(index: number): string {
  return `t${index + 1}`;
}

/** True when a title is only a bare checklist id (t1, t2, …), not real work. */
export function isBareTaskIdTitle(title: string): boolean {
  return /^t\d+$/i.test(title.trim());
}

/**
 * Drop phantom tasks whose title is just `t1`/`t2`/… (models sometimes
 * interleave bare ids with real titles). Keeps real task ids stable so
 * in-flight task.update calls still resolve.
 */
export function stripBareTaskIdTasks(tasks: PlanTask[]): PlanTask[] {
  return tasks.filter((t) => t.title.trim() && !isBareTaskIdTitle(t.title));
}

export function tasksFromTitles(titles: string[]): PlanTask[] {
  return titles
    .map((title) => title.trim())
    .filter((title) => Boolean(title) && !isBareTaskIdTitle(title))
    .map((title, index) => ({
      id: newTaskId(index),
      title,
      state: "pending" as TaskState,
      dependencies: index > 0 ? [newTaskId(index - 1)] : [],
      resourceLocks: [],
    }));
}

export function createPlan(input: {
  sessionId: string;
  goal: string;
  detail: string;
  taskTitles: string[];
  kind?: string | undefined;
  meta?: PlanMeta | undefined;
}): SessionPlan {
  const now = new Date().toISOString();
  const plan: SessionPlan = {
    schemaVersion: 2,
    version: 1,
    sessionId: input.sessionId,
    goal: input.goal.trim() || "Untitled plan",
    detail: input.detail.trim(),
    tasks: tasksFromTitles(input.taskTitles),
    status: "draft",
    kind: input.kind?.trim() || "general",
    createdAt: now,
    updatedAt: now,
  };
  if (input.meta && Object.keys(input.meta).length > 0) {
    plan.meta = input.meta;
  }
  return plan;
}

export function patchPlanMeta(
  plan: SessionPlan,
  patch: PlanMeta,
): SessionPlan {
  plan.meta = { ...(plan.meta ?? {}), ...patch };
  return plan;
}

export async function savePlan(plan: SessionPlan): Promise<void> {
  plan.updatedAt = new Date().toISOString();
  if (getConfig().privateMode) return; // never persist in private mode
  const db = await loadDatabase();
  if (db) {
    db.prepare(
      `INSERT INTO plans (session_id, goal, detail, tasks_json, status, kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         goal=excluded.goal, detail=excluded.detail, tasks_json=excluded.tasks_json,
         status=excluded.status, kind=excluded.kind, updated_at=excluded.updated_at`,
    ).run(
      plan.sessionId,
      plan.goal,
      plan.detail,
      serializeTasksPayload(plan),
      plan.status,
      plan.kind,
      plan.createdAt,
      plan.updatedAt,
    );
    return;
  }
  await appendJsonl(plan);
}

async function appendJsonl(plan: SessionPlan): Promise<void> {
  try {
    await mkdir(planDir, { recursive: true });
    await fixOwner(planDir);
    // JSONL fallback keeps the latest record per session; we compact on write
    // so the file does not grow unbounded for a long-lived session.
    const existing = await readAllJsonl();
    const map = new Map(existing.map((p) => [p.sessionId, p]));
    map.set(plan.sessionId, plan);
    const body = [...map.values()].map((p) => JSON.stringify(p)).join("\n");
    await writeFile(jsonlFile, body ? `${body}\n` : "", { mode: 0o600 });
    await fixOwner(jsonlFile);
  } catch (err: any) {
    handlePermissionError(err);
  }
}

async function readAllJsonl(): Promise<SessionPlan[]> {
  if (!(await safeExists(jsonlFile))) return [];
  try {
    const raw = await readFile(jsonlFile, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SessionPlan);
  } catch (err: any) {
    if (err && err.code === "EACCES") {
      handlePermissionError(err);
    }
    return [];
  }
}

/** Upgrade legacy persisted plans without changing task ids or states. */
function normalizePersistedPlan(plan: SessionPlan): SessionPlan {
  return {
    ...plan,
    schemaVersion: 2,
    version:
      typeof plan.version === "number" && plan.version >= 1
        ? plan.version
        : 1,
    tasks: plan.tasks.map((task, index) => ({
      ...task,
      dependencies: [
        ...(task.dependencies ?? (index > 0 ? [plan.tasks[index - 1]!.id] : [])),
      ],
      resourceLocks: [...(task.resourceLocks ?? [])],
    })),
  };
}

/** Heal plans that stored bare `t1`/`t2` strings as task titles. */
function healBareIdTasks(plan: SessionPlan): {
  plan: SessionPlan;
  healed: boolean;
} {
  const cleaned = stripBareTaskIdTasks(plan.tasks);
  if (cleaned.length === plan.tasks.length) return { plan, healed: false };
  return { plan: { ...plan, tasks: cleaned }, healed: true };
}

export async function loadPlan(sessionId: string): Promise<SessionPlan | undefined> {
  const db = await loadDatabase();
  if (db) {
    const row = db
      .prepare(
        "SELECT session_id, goal, detail, tasks_json, status, kind, created_at, updated_at FROM plans WHERE session_id = ?",
      )
      .get(sessionId) as
      | {
          session_id: string;
          goal: string;
          detail: string;
          tasks_json: string;
          status: string;
          kind: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return undefined;
    const { tasks, meta, version } = deserializeTasksPayload(row.tasks_json);
    const plan: SessionPlan = {
      schemaVersion: 2,
      version,
      sessionId: row.session_id,
      goal: row.goal,
      detail: row.detail,
      tasks,
      status: row.status as PlanStatus,
      kind: row.kind,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (meta) plan.meta = meta;
    const needsNormalization = plan.tasks.some(
      (task) => task.dependencies === undefined || task.resourceLocks === undefined,
    );
    const normalized = normalizePersistedPlan(plan);
    const { plan: healed, healed: dirty } = healBareIdTasks(normalized);
    if (dirty || needsNormalization) {
      // Persist upgrades so resumed SQLite and JSONL plans share dependency semantics.
      await savePlan(healed);
    }
    return healed;
  }
  const found = (await readAllJsonl()).find((p) => p.sessionId === sessionId);
  if (!found) return undefined;
  const needsNormalization = found.tasks.some(
    (task) => task.dependencies === undefined || task.resourceLocks === undefined,
  );
  const normalized = normalizePersistedPlan(found);
  const { plan: healed, healed: dirty } = healBareIdTasks(normalized);
  if (dirty || needsNormalization) await savePlan(healed);
  return healed;
}

export async function deletePlan(sessionId: string): Promise<void> {
  try {
    const db = await loadDatabase();
    if (db) {
      db.prepare("DELETE FROM plans WHERE session_id = ?").run(sessionId);
      return;
    }
    const existing = await readAllJsonl();
    const remaining = existing.filter((p) => p.sessionId !== sessionId);
    if (remaining.length === existing.length) return;
    await mkdir(planDir, { recursive: true });
    await fixOwner(planDir);
    const body = remaining.map((p) => JSON.stringify(p)).join("\n");
    await writeFile(jsonlFile, body ? `${body}\n` : "", { mode: 0o600 });
    await fixOwner(jsonlFile);
  } catch (err: any) {
    handlePermissionError(err);
  }
}

export async function clearAllPlans(): Promise<void> {
  const db = await loadDatabase();
  if (db) {
    try {
      db.exec("DELETE FROM plans;");
    } catch {
      /* ignore */
    }
  }
  if (await safeExists(jsonlFile)) {
    try {
      await rm(jsonlFile, { force: true });
    } catch {
      /* ignore */
    }
  }
}

// Task mutations

const toDomainStatus = (state: TaskState): VersionedPlanStep["status"] =>
  state === "in_progress" ? "running" : state;
const fromDomainStatus = (state: VersionedPlanStep["status"]): TaskState =>
  state === "running" ? "in_progress" : state;

function toVersionedTaskPlan(plan: SessionPlan): VersionedTaskPlan {
  return {
    schemaVersion: 2,
    version: plan.version ?? 1,
    id: plan.sessionId,
    goal: plan.goal,
    complexity: "standard",
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    steps: plan.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      kind: "other",
      status: toDomainStatus(task.state),
      notes: task.note,
      dependencies: [...(task.dependencies ?? [])],
      resourceLocks: [...(task.resourceLocks ?? [])],
      supersededBy: task.supersededBy,
    })),
  };
}

export function applySessionPlanOperation(
  plan: SessionPlan,
  operation: PlanOperation,
): SessionPlan {
  const updated = applyPlanOperation(toVersionedTaskPlan(plan), operation);
  const prior = new Map(plan.tasks.map((task) => [task.id, task]));
  return {
    ...plan,
    version: updated.version,
    updatedAt: updated.updatedAt,
    tasks: updated.steps.map((step) => ({
      id: step.id,
      title: step.title,
      state: fromDomainStatus(step.status),
      note: step.notes,
      evidence: prior.get(step.id)?.evidence,
      aliases: prior.get(step.id)?.aliases,
      dependencies: [...(step.dependencies ?? [])],
      resourceLocks: [...(step.resourceLocks ?? [])],
      supersededBy: step.supersededBy,
    })),
  };
}

export function validateSessionPlan(plan: SessionPlan): { ok: true } | { ok: false; reason: string } {
  return validatePlanDag(toVersionedTaskPlan(plan));
}

export function readyPlanTasks(plan: SessionPlan): PlanTask[] {
  const done = new Set(
    plan.tasks
      .filter((task) => task.state === "done" || task.state === "skipped")
      .map((task) => task.id),
  );
  const held = new Set(
    plan.tasks
      .filter((task) => task.state === "in_progress")
      .flatMap((task) => task.resourceLocks ?? []),
  );
  return plan.tasks.filter(
    (task) =>
      task.state === "pending" &&
      !task.supersededBy &&
      (task.dependencies ?? []).every((dependency) => done.has(dependency)) &&
      !(task.resourceLocks ?? []).some((resource) => held.has(resource)),
  );
}

export function markTask(
  plan: SessionPlan,
  taskId: string,
  state: TaskState,
  note?: string | undefined,
): boolean {
  const task = plan.tasks.find((t) => t.id === taskId);
  if (!task) return false;
  task.state = state;
  if (note !== undefined) task.note = note;
  plan.version = (plan.version ?? 1) + 1;
  plan.updatedAt = new Date().toISOString();
  return true;
}

/** Mark the first not-yet-finished task as the given state. */
export function markNextTask(plan: SessionPlan, state: TaskState): PlanTask | undefined {
  const task = plan.tasks.find((t) => t.state === "pending" || t.state === "in_progress");
  if (!task) return undefined;
  task.state = state;
  plan.version = (plan.version ?? 1) + 1;
  plan.updatedAt = new Date().toISOString();
  return task;
}

export function planProgress(plan: SessionPlan): { done: number; total: number } {
  const done = plan.tasks.filter((t) => t.state === "done").length;
  return { done, total: plan.tasks.length };
}

export function isPlanTerminal(plan: SessionPlan): boolean {
  return (
    plan.tasks.length > 0 &&
    plan.tasks.every(
      (t) => t.state === "done" || t.state === "skipped" || t.state === "failed",
    )
  );
}

export function isPlanSuccessful(plan: SessionPlan): boolean {
  return (
    plan.tasks.length > 0 &&
    plan.tasks.every((t) => t.state === "done" || t.state === "skipped")
  );
}

/** @deprecated Use isPlanTerminal or isPlanSuccessful explicitly. */
export function isPlanComplete(plan: SessionPlan): boolean {
  return isPlanSuccessful(plan);
}
