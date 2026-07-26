// Deterministic durable work envelope for compaction.
//
// Narrative memory is model-written and therefore lossy. The envelope is built
// from canonical stores (plan, outcome contract, evidence, responder ledger,
// mutation ledger) so file changes, proven checks, unresolved criteria, failed
// approaches and the exact next step survive every compaction verbatim.
import { relative } from "node:path";
import type { ToolCall } from "../types.js";
import type { OutcomeEnvelope } from "./outcomes.js";
import { scratchWriteTargetPaths } from "./scratch-write.js";
import {
  foregroundActiveTask,
  foregroundRemaining,
  foregroundTasks,
  responderOpenTasks,
  type SessionPlan,
} from "../store/plan.js";

export const DURABLE_ENVELOPE_PREFIX = "DURABLE WORK ENVELOPE";

// Max entries rendered per list before a bounded overflow marker.
const MAX_LIST_ENTRIES = 20;
// Max chars of a single rendered statement.
const MAX_STATEMENT_CHARS = 180;

export type FileMutationKind = "created" | "modified" | "deleted";

const MUTATION_KIND_BY_TOOL: ReadonlyMap<string, FileMutationKind> = new Map([
  ["fs.write", "created"],
  ["fs.writeMany", "created"],
  ["fs.edit", "modified"],
  ["fs.replaceLines", "modified"],
  ["fs.append", "modified"],
  ["fs.delete", "deleted"],
]);

// Session-scoped record of successful filesystem mutations and durable
// artifacts. Insertion order is preserved so the envelope is stable between
// compactions of the same work.
export class WorkLedger {
  private readonly files = new Map<string, FileMutationKind>();
  private readonly artifacts = new Set<string>();

  recordToolCall(call: ToolCall, ok: boolean, artifactPath?: string): void {
    if (artifactPath) this.artifacts.add(artifactPath);
    if (!ok) return;
    const kind = MUTATION_KIND_BY_TOOL.get(call.name);
    if (!kind) return;
    for (const path of scratchWriteTargetPaths(call)) {
      const existing = this.files.get(path);
      // A create followed by edits is still a create; a delete always wins.
      if (kind === "deleted" || existing === undefined) {
        this.files.set(path, kind);
      }
    }
  }

  pathsByKind(kind: FileMutationKind): string[] {
    return [...this.files.entries()]
      .filter(([, value]) => value === kind)
      .map(([path]) => path);
  }

  artifactPaths(): string[] {
    return [...this.artifacts];
  }

  get size(): number {
    return this.files.size + this.artifacts.size;
  }
}

export interface ResponderEnvelopeState {
  readonly unread: readonly string[];
  readonly consumed: readonly string[];
}

export interface DurableEnvelopeInput {
  readonly plan?: SessionPlan | undefined;
  readonly outcome?: OutcomeEnvelope | undefined;
  readonly ledger?: WorkLedger | undefined;
  readonly responder?: ResponderEnvelopeState | undefined;
  readonly projectRoot?: string | undefined;
  readonly packageManager?: string | undefined;
  readonly scopeSummary?: string | undefined;
}

function clip(text: string, max = MAX_STATEMENT_CHARS): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1)}…`;
}

function renderList(paths: readonly string[], root?: string | undefined): string {
  const shown = paths.slice(0, MAX_LIST_ENTRIES).map((path) => {
    if (!root) return path;
    const rel = relative(root, path);
    return rel && !rel.startsWith("..") ? rel : path;
  });
  const overflow = paths.length - shown.length;
  return overflow > 0
    ? `${shown.join(", ")} (+${overflow} more)`
    : shown.join(", ");
}

function planLines(plan: SessionPlan, lines: string[]): void {
  const foreground = foregroundTasks(plan);
  const active = foregroundActiveTask(plan);
  const remaining = foregroundRemaining(plan);
  lines.push(
    `Plan ${plan.sessionId} (${plan.status}): ${clip(plan.goal || "(no goal)")} — ${foreground.length - remaining.length}/${foreground.length} foreground tasks done`,
  );
  if (active) {
    lines.push(`Active foreground task: ${active.id} ${clip(active.title)}`);
  }
  const next = remaining.find((task) => task.id !== active?.id);
  if (next) lines.push(`Next foreground task: ${next.id} ${clip(next.title)}`);
  const open = responderOpenTasks(plan);
  if (open.length > 0) {
    lines.push(
      `Open responder children: ${open.map((task) => task.id).slice(0, MAX_LIST_ENTRIES).join(", ")}`,
    );
  }
}

function outcomeLines(outcome: OutcomeEnvelope, lines: string[]): void {
  const proven = outcome.outcome.criteria.filter(
    (criterion) => criterion.status === "proven",
  );
  const unresolved = outcome.outcome.criteria.filter(
    (criterion) =>
      criterion.status === "unproven" ||
      criterion.status === "supported" ||
      criterion.status === "refuted",
  );
  lines.push(`Outcome ${outcome.outcome.kind}: ${outcome.outcome.status}`);
  if (proven.length > 0) {
    lines.push(
      `Proven criteria: ${proven.map((c) => `${c.id} ${clip(c.statement, 80)}`).slice(0, MAX_LIST_ENTRIES).join("; ")}`,
    );
  }
  if (unresolved.length > 0) {
    lines.push(
      `Unresolved criteria: ${unresolved
        .map((c) => `${c.id} (${c.status}${c.required ? ", required" : ""}) ${clip(c.statement, 80)}`)
        .slice(0, MAX_LIST_ENTRIES)
        .join("; ")}`,
    );
  }
  const passes = outcome.evidence.filter((record) => record.result === "pass");
  if (passes.length > 0) {
    const recent = passes.slice(-MAX_LIST_ENTRIES);
    lines.push(
      `Verified checks: ${recent.map((record) => `${record.source.tool} ${clip(record.observation, 70)}`).join("; ")}`,
    );
  }
  if (outcome.failedHypotheses.length > 0) {
    const recent = outcome.failedHypotheses.slice(-MAX_LIST_ENTRIES);
    lines.push(
      `Failed approaches (do not repeat): ${recent.map((entry) => `${entry.signature} — ${clip(entry.premise, 90)}`).join("; ")}`,
    );
  }
}

// Render the envelope. Returns undefined when there is no canonical state worth
// preserving, so compaction does not inject an empty block.
export function buildDurableEnvelope(
  input: DurableEnvelopeInput,
): string | undefined {
  const lines: string[] = [];
  if (input.projectRoot) {
    lines.push(
      `Project root: ${input.projectRoot}${input.packageManager ? ` (package manager: ${input.packageManager})` : ""}`,
    );
  }
  if (input.scopeSummary) lines.push(`Engagement scope: ${clip(input.scopeSummary, 240)}`);
  if (input.plan) planLines(input.plan, lines);
  if (input.outcome) outcomeLines(input.outcome, lines);
  if (input.responder) {
    if (input.responder.unread.length > 0) {
      lines.push(`Unread responder results: ${input.responder.unread.join(", ")}`);
    }
    if (input.responder.consumed.length > 0) {
      lines.push(
        `Consumed responder results (never re-read): ${input.responder.consumed.join(", ")}`,
      );
    }
  }
  const ledger = input.ledger;
  if (ledger && ledger.size > 0) {
    const created = ledger.pathsByKind("created");
    const modified = ledger.pathsByKind("modified");
    const deleted = ledger.pathsByKind("deleted");
    const artifacts = ledger.artifactPaths();
    if (created.length > 0) {
      lines.push(`Files created: ${renderList(created, input.projectRoot)}`);
    }
    if (modified.length > 0) {
      lines.push(`Files modified: ${renderList(modified, input.projectRoot)}`);
    }
    if (deleted.length > 0) {
      lines.push(`Files deleted: ${renderList(deleted, input.projectRoot)}`);
    }
    if (artifacts.length > 0) {
      lines.push(`Artifacts on disk: ${renderList(artifacts)}`);
    }
  }
  if (lines.length === 0) return undefined;
  return [
    `${DURABLE_ENVELOPE_PREFIX} (canonical; authoritative over summarized narrative)`,
    ...lines,
  ].join("\n");
}

export function isDurableEnvelopeContent(content: string): boolean {
  return content.startsWith(DURABLE_ENVELOPE_PREFIX);
}
