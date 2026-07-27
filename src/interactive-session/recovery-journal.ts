/**
 * Crash-recovery journal for live interactive sessions.
 *
 * Interactive sessions are never reattachable: this file exists only so a crash
 * cannot leave an orphaned process tree behind. It therefore stores cleanup
 * evidence and nothing else — no command, cwd, input, environment, or output.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../store/paths.js";
import {
  processIdentityTracker,
  type ProcessIdentityComparison,
} from "../os/process-identity.js";
import { terminateProcessTree } from "../os/process-tree.js";

const JOURNAL_FILE = "registry-v1.json";
const SCHEMA_VERSION = 1;

export interface JournalRecord {
  readonly id: string;
  /** Hashed owner id: enough to group records, never the conversation id. */
  readonly ownerHash: string;
  readonly pid: number | undefined;
  readonly processGroupId: number | undefined;
  readonly identity: string | undefined;
  readonly platform: NodeJS.Platform;
  readonly startedAt: number;
  readonly artifactPath: string;
  /** True once a pid was confirmed by the OS. */
  readonly launchConfirmed: boolean;
}

interface PersistedJournal {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly sessions: JournalRecord[];
}

export type ReconciliationOutcome =
  | "terminated"
  | "gone"
  | "identity-mismatch"
  | "unverified"
  | "launch-failed";

export interface ReconciliationEntry {
  readonly id: string;
  readonly outcome: ReconciliationOutcome;
}

export function hashOwner(ownerId: string): string {
  return createHash("sha256").update(ownerId).digest("hex").slice(0, 16);
}

export interface RecoveryJournalProcessDeps {
  readonly compareIdentity: (
    pid: number | undefined,
    identity: string | undefined,
  ) => ProcessIdentityComparison;
  readonly terminateTree: (
    pid: number,
    options: { signal: NodeJS.Signals; processGroupId?: number | undefined },
  ) => unknown;
}

const defaultProcessDeps: RecoveryJournalProcessDeps = {
  compareIdentity: (pid, identity) => processIdentityTracker.compare(pid, identity),
  terminateTree: terminateProcessTree,
};

export class RecoveryJournal {
  private readonly path: string;
  private readonly process: RecoveryJournalProcessDeps;
  private records = new Map<string, JournalRecord>();

  constructor(
    private readonly directory = join(getDataDir(), "interactive-sessions"),
    processDeps: Partial<RecoveryJournalProcessDeps> = {},
  ) {
    this.path = join(this.directory, JOURNAL_FILE);
    this.process = { ...defaultProcessDeps, ...processDeps };
  }

  upsert(record: JournalRecord): void {
    this.records.set(record.id, record);
    this.persist();
  }

  remove(id: string): void {
    if (!this.records.delete(id)) return;
    this.persist();
  }

  /** Load prior records without trusting any of them as running. */
  load(): JournalRecord[] {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as PersistedJournal;
      if (parsed?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.sessions)) {
        return [];
      }
      return parsed.sessions;
    } catch {
      return [];
    }
  }

  /**
   * Reconcile prior records before tools are enabled. Only an identity match
   * authorizes signalling; `unknown` identity is reported unverified and left
   * alone so a recycled pid is never killed.
   */
  reconcile(): ReconciliationEntry[] {
    const prior = this.load();
    const results: ReconciliationEntry[] = [];
    for (const record of prior) {
      results.push({ id: record.id, outcome: this.reconcileOne(record) });
    }
    this.records.clear();
    this.persist();
    return results;
  }

  private reconcileOne(record: JournalRecord): ReconciliationOutcome {
    if (!record.launchConfirmed || !record.pid) return "launch-failed";
    const comparison = this.process.compareIdentity(record.pid, record.identity);
    if (comparison === "gone") return "gone";
    if (comparison === "mismatch") return "identity-mismatch";
    if (comparison === "unknown") return "unverified";
    this.process.terminateTree(record.pid, {
      signal: "SIGKILL",
      ...(record.processGroupId !== undefined
        ? { processGroupId: record.processGroupId }
        : {}),
    });
    return "terminated";
  }

  private persist(): void {
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const payload: PersistedJournal = {
        schemaVersion: SCHEMA_VERSION,
        sessions: [...this.records.values()],
      };
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
      renameSync(temp, this.path);
    } catch {
      // A journal write failure must never block a session operation; the worst
      // case is an unreconciled orphan, which cleanup already reports.
    }
  }

  /** Remove the journal file entirely; used when no live sessions remain. */
  clear(): void {
    this.records.clear();
    try {
      rmSync(this.path, { force: true });
    } catch {
      // Best effort.
    }
  }
}
