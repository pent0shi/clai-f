import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDataDir } from "../store/paths.js";

export type OutcomeKind = "answer" | "build" | "bugfix" | "operation" | "pentest";
export type OutcomeStatus = "active" | "succeeded" | "partial" | "blocked" | "failed" | "aborted" | "paused_budget";
export type CriterionStatus = "unproven" | "supported" | "proven" | "refuted" | "waived";
export type EvidenceKind = "observation" | "automated-check" | "process-start" | "readiness" | "probe" | "reproduction" | "impact" | "artifact" | "scanner-lead";

export interface OutcomeCriterion {
  id: string;
  statement: string;
  required: boolean;
  status: CriterionStatus;
  evidenceIds: string[];
  revision: number;
  domain?: "general" | "feature" | "bugfix" | "server" | "pentest-finding" | undefined;
}

export interface OutcomeContract {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  userIntent: string;
  kind: OutcomeKind;
  criteria: OutcomeCriterion[];
  assumptions: string[];
  constraints: string[];
  status: OutcomeStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceRecord {
  schemaVersion: 1;
  id: string;
  outcomeId: string;
  criterionIds: string[];
  taskId?: string | undefined;
  source: { tool: string; callId: string; artifact?: string | undefined };
  kind: EvidenceKind;
  observedAt: string;
  freshness: "current" | "stale";
  strength: "supporting" | "decisive";
  observation: string;
  result: "pass" | "fail" | "inconclusive";
  environment?: Record<string, string> | undefined;
  outcomeRevision: number;
}

export interface OutcomeEnvelope {
  schemaVersion: 1;
  outcome: OutcomeContract;
  evidence: EvidenceRecord[];
  failedHypotheses: Array<{ signature: string; premise: string; observedAt: string }>;
}

const fileFor = (sessionId: string): string => join(getDataDir(), "outcomes", `${encodeURIComponent(sessionId)}.json`);

/**
 * Serialize snapshots for one session without serializing tool execution.
 * A queue is necessary in addition to unique temp files: otherwise an older
 * snapshot can win the final rename after a newer parallel completion.
 */
const outcomeSaveQueues = new Map<string, Promise<void>>();

function mergeOutcomeEnvelopes(
  existing: OutcomeEnvelope | undefined,
  incoming: OutcomeEnvelope,
): OutcomeEnvelope {
  if (!existing || existing.outcome.id !== incoming.outcome.id) {
    return incoming;
  }
  if (incoming.outcome.revision < existing.outcome.revision) {
    return existing;
  }
  if (incoming.outcome.revision > existing.outcome.revision) {
    return incoming;
  }
  const evidence = [
    ...new Map(
      [...existing.evidence, ...incoming.evidence].map((record) => [record.id, record]),
    ).values(),
  ];
  const failedHypotheses = [
    ...new Map(
      [...existing.failedHypotheses, ...incoming.failedHypotheses].map((item) => [
        `${item.signature}\u0000${item.premise}`,
        item,
      ]),
    ).values(),
  ];
  const criteria = [
    ...new Map(
      [...existing.outcome.criteria, ...incoming.outcome.criteria].map((criterion) => [
        criterion.id,
        criterion,
      ]),
    ).values(),
  ].map((criterion) => {
    const prior = existing.outcome.criteria.find((item) => item.id === criterion.id);
    const evidenceIds = [...new Set([...(prior?.evidenceIds ?? []), ...criterion.evidenceIds])];
    const linked = evidence.filter(
      (record) =>
        evidenceIds.includes(record.id) &&
        record.criterionIds.includes(criterion.id) &&
        record.freshness === "current",
    );
    let status: CriterionStatus = "unproven";
    if (criterion.status === "waived" || prior?.status === "waived") {
      status = "waived";
    } else if (
      linked.some((record) => record.result === "pass" && record.strength === "decisive")
    ) {
      status = "proven";
    } else if (linked.some((record) => record.result === "fail")) {
      status = "refuted";
    } else if (linked.some((record) => record.result === "pass")) {
      status = "supported";
    }
    return {
      ...criterion,
      status,
      evidenceIds,
    };
  });
  const outcome: OutcomeContract = {
    ...existing.outcome,
    ...incoming.outcome,
    criteria,
    updatedAt:
      existing.outcome.updatedAt >= incoming.outcome.updatedAt
        ? existing.outcome.updatedAt
        : incoming.outcome.updatedAt,
  };
  outcome.status = deriveOutcomeStatus(outcome, evidence);
  return { schemaVersion: 1, outcome, evidence, failedHypotheses };
}

export function createOutcome(input: {
  sessionId: string;
  userIntent: string;
  kind: OutcomeKind;
  criteria: Array<Pick<OutcomeCriterion, "statement" | "required" | "domain"> & { id?: string }>;
}): OutcomeContract {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: randomUUID(),
    sessionId: input.sessionId,
    userIntent: input.userIntent,
    kind: input.kind,
    criteria: input.criteria.map((criterion) => ({
      id: criterion.id ?? randomUUID(),
      statement: criterion.statement,
      required: criterion.required,
      status: "unproven",
      evidenceIds: [],
      revision: 1,
      domain: criterion.domain,
    })),
    assumptions: [],
    constraints: [],
    status: "active",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export function reviseOutcome(outcome: OutcomeContract, criteria: OutcomeContract["criteria"]): OutcomeContract {
  const revision = outcome.revision + 1;
  return {
    ...outcome,
    revision,
    status: "active",
    criteria: criteria.map((criterion) => ({ ...criterion, revision, status: criterion.status === "waived" ? "waived" : "unproven", evidenceIds: [] })),
    updatedAt: new Date().toISOString(),
  };
}

export function linkEvidence(outcome: OutcomeContract, evidence: EvidenceRecord): void {
  if (evidence.outcomeId !== outcome.id || evidence.outcomeRevision !== outcome.revision) {
    throw new Error("evidence belongs to a different outcome or revision");
  }
  if (evidence.freshness !== "current") throw new Error("stale evidence cannot prove a criterion");
  for (const criterionId of evidence.criterionIds) {
    const criterion = outcome.criteria.find((item) => item.id === criterionId);
    if (!criterion) throw new Error(`unknown criterion: ${criterionId}`);
    if (!criterion.evidenceIds.includes(evidence.id)) criterion.evidenceIds.push(evidence.id);
    if (evidence.result === "pass") criterion.status = evidence.strength === "decisive" ? "proven" : "supported";
    else if (evidence.result === "fail") criterion.status = "refuted";
  }
  outcome.updatedAt = new Date().toISOString();
}

export function validateCriterionEvidence(criterion: OutcomeCriterion, records: readonly EvidenceRecord[]): { ok: boolean; reason?: string } {
  const linked = records.filter((record) => criterion.evidenceIds.includes(record.id) && record.criterionIds.includes(criterion.id) && record.freshness === "current" && record.result === "pass");
  if (criterion.status === "waived") return { ok: true };
  if (criterion.status !== "proven" || linked.length === 0) return { ok: false, reason: "criterion lacks current decisive linked evidence" };
  if (criterion.domain === "bugfix" && criterion.id === "reproduction") {
    const allLinked = records.filter(
      (record) =>
        criterion.evidenceIds.includes(record.id) &&
        record.criterionIds.includes(criterion.id) &&
        record.freshness === "current",
    );
    if (!allLinked.some((record) => record.kind === "reproduction" && record.result === "fail")) {
      return { ok: false, reason: "bug criterion lacks failing before/reproduction evidence" };
    }
    if (!allLinked.some((record) => record.kind === "reproduction" && record.result === "pass")) {
      return { ok: false, reason: "bug criterion lacks passing after-fix reproduction evidence" };
    }
  }
  if (criterion.domain === "server") {
    const kinds = new Set(linked.map((record) => record.kind));
    for (const required of ["process-start", "readiness", "probe"] as const) {
      if (!kinds.has(required)) return { ok: false, reason: `server criterion lacks ${required} evidence` };
    }
  }
  if (criterion.domain === "pentest-finding") {
    const kinds = new Set(linked.map((record) => record.kind));
    if (!kinds.has("reproduction") || !kinds.has("impact") || !kinds.has("artifact")) {
      return { ok: false, reason: "pentest finding lacks reproduction, impact, or artifact evidence" };
    }
    if (linked.every((record) => record.kind === "scanner-lead")) return { ok: false, reason: "scanner output is a lead, not a verified finding" };
  }
  return { ok: true };
}

export function deriveOutcomeStatus(outcome: OutcomeContract, records: readonly EvidenceRecord[]): OutcomeStatus {
  const required = outcome.criteria.filter((criterion) => criterion.required);
  return required.every((criterion) => validateCriterionEvidence(criterion, records).ok) ? "succeeded" : "partial";
}

export function saveOutcomeState(envelope: OutcomeEnvelope): Promise<void> {
  const sessionId = envelope.outcome.sessionId;
  const previous = outcomeSaveQueues.get(sessionId) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(async () => {
    const dir = join(getDataDir(), "outcomes");
    const path = fileFor(sessionId);
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dir, { recursive: true });
    try {
      // Merge the latest durable state with this caller's snapshot. Parallel
      // tool calls can hold independent clones, so queueing alone would still
      // make the last whole-file snapshot erase sibling receipts.
      let existing: OutcomeEnvelope | undefined;
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as OutcomeEnvelope;
        if (parsed.schemaVersion === 1) existing = parsed;
      } catch {
        // First save or corrupt prior state: write the incoming valid envelope.
      }
      const merged = mergeOutcomeEnvelopes(existing, envelope);
      const serialized = `${JSON.stringify(merged, null, 2)}\n`;
      await writeFile(temp, serialized, { mode: 0o600 });
      await rename(temp, path);
    } finally {
      // rename removes the temp on success; unlink is only for failed writes.
      await unlink(temp).catch(() => undefined);
    }
  });
  outcomeSaveQueues.set(sessionId, queued);
  void queued.finally(() => {
    if (outcomeSaveQueues.get(sessionId) === queued) {
      outcomeSaveQueues.delete(sessionId);
    }
  }).catch(() => undefined);
  return queued;
}

export async function loadOutcomeState(sessionId: string): Promise<OutcomeEnvelope | undefined> {
  try {
    const parsed = JSON.parse(await readFile(fileFor(sessionId), "utf8")) as Partial<OutcomeEnvelope>;
    if (parsed.schemaVersion !== 1 || !parsed.outcome || !Array.isArray(parsed.evidence)) return undefined;
    // Conservative migration: old completion labels never become evidenced success.
    const outcome = { ...parsed.outcome };
    if (outcome.status === "succeeded" && deriveOutcomeStatus(outcome, parsed.evidence) !== "succeeded") outcome.status = "partial";
    return { schemaVersion: 1, outcome, evidence: parsed.evidence, failedHypotheses: parsed.failedHypotheses ?? [] };
  } catch {
    return undefined;
  }
}

export function createEvidence(input: Omit<EvidenceRecord, "schemaVersion" | "id" | "observedAt">): EvidenceRecord {
  return { schemaVersion: 1, id: randomUUID(), observedAt: new Date().toISOString(), ...input };
}

export function inferOutcomeKind(input: {
  userIntent: string;
  buildLike?: boolean;
  pentestLike?: boolean;
}): OutcomeKind {
  if (input.pentestLike) return "pentest";
  if (/\b(?:fix|bug|regression|broken|error|failure)\b/i.test(input.userIntent)) return "bugfix";
  if (input.buildLike) return "build";
  if (/\b(?:start|serve|deploy|run|operate)\b/i.test(input.userIntent)) return "operation";
  return "answer";
}

export function defaultOutcomeCriteria(
  kind: OutcomeKind,
  userIntent: string,
): Array<Pick<OutcomeCriterion, "id" | "statement" | "required" | "domain">> {
  if (kind === "build") {
    const criteria: Array<Pick<OutcomeCriterion, "id" | "statement" | "required" | "domain">> = [
      { id: "implementation", statement: `Requested change is implemented: ${userIntent}`, required: true, domain: "feature" },
      { id: "verification", statement: "Changed behavior passes an automated or direct behavioral check", required: true, domain: "feature" },
    ];
    if (/\b(?:server|website|web app|localhost|serve|dev server)\b/i.test(userIntent)) {
      criteria.push({ id: "server", statement: "The requested server is started, ready, and independently probed", required: true, domain: "server" });
    }
    return criteria;
  }
  if (kind === "bugfix") {
    return [
      { id: "reproduction", statement: "The reported failure is reproduced or characterized", required: true, domain: "bugfix" },
      { id: "implementation", statement: "A targeted fix is implemented", required: true, domain: "bugfix" },
      { id: "verification", statement: "A current check demonstrates the failure is resolved", required: true, domain: "bugfix" },
    ];
  }
  if (kind === "operation") {
    return [{ id: "server", statement: "The requested operation is started, ready, and independently probed", required: true, domain: "server" }];
  }
  if (kind === "pentest") {
    return [
      { id: "assessment", statement: "Authorized assessment activity completed with retained evidence", required: true, domain: "general" },
      { id: "finding", statement: "Any reported finding is reproduced with impact and artifact evidence", required: false, domain: "pentest-finding" },
    ];
  }
  return [{ id: "answer", statement: "The response directly addresses the current user intent", required: true, domain: "general" }];
}

export async function openOutcomeState(input: {
  sessionId: string;
  userIntent: string;
  kind: OutcomeKind;
  continueExisting?: boolean;
}): Promise<OutcomeEnvelope> {
  const existing = await loadOutcomeState(input.sessionId);
  if (existing && input.continueExisting && existing.outcome.status !== "succeeded") return existing;
  return {
    schemaVersion: 1,
    outcome: createOutcome({
      sessionId: input.sessionId,
      userIntent: input.userIntent,
      kind: input.kind,
      criteria: defaultOutcomeCriteria(input.kind, input.userIntent),
    }),
    evidence: [],
    failedHypotheses: existing?.failedHypotheses ?? [],
  };
}

export function recordFailedHypothesis(
  envelope: OutcomeEnvelope,
  input: { signature: string; premise: string },
): void {
  const duplicate = envelope.failedHypotheses.some(
    (item) => item.signature === input.signature && item.premise === input.premise,
  );
  if (!duplicate) {
    envelope.failedHypotheses.push({ ...input, observedAt: new Date().toISOString() });
  }
}

export function recordToolEvidence(
  envelope: OutcomeEnvelope,
  input: {
    tool: string;
    callId: string;
    ok: boolean;
    output: string;
    artifact?: string | undefined;
    taskId?: string | undefined;
    args?: Record<string, unknown> | undefined;
  },
): EvidenceRecord[] {
  const ids = new Set(envelope.outcome.criteria.map((criterion) => criterion.id));
  const command = typeof input.args?.command === "string" ? input.args.command : "";
  const url = typeof input.args?.url === "string" ? input.args.url : "";
  const records: EvidenceRecord[] = [];
  const add = (
    criterionIds: string[],
    kind: EvidenceKind,
    strength: EvidenceRecord["strength"],
  ): void => {
    const linked = criterionIds.filter((id) => ids.has(id));
    if (linked.length === 0) return;
    const evidence = createEvidence({
      outcomeId: envelope.outcome.id,
      outcomeRevision: envelope.outcome.revision,
      criterionIds: linked,
      taskId: input.taskId,
      source: { tool: input.tool, callId: input.callId, artifact: input.artifact },
      kind,
      freshness: "current",
      strength,
      observation: input.output.slice(0, 4_000),
      result: input.ok ? "pass" : "fail",
    });
    envelope.evidence.push(evidence);
    linkEvidence(envelope.outcome, evidence);
    records.push(evidence);
  };

  const isWrite = /^(?:fs\.(?:write|writeMany|edit|replaceLines|append))$/.test(input.tool);
  const isCheck = input.tool === "shell.exec" && /\b(?:test|vitest|jest|pytest|typecheck|lint|build|check)\b/i.test(command);
  const isProbe = input.tool === "http.fetch" || (input.tool === "shell.exec" && /\bcurl\b/i.test(command));
  const isStart = input.tool === "shell.start";
  const isReady = input.tool === "shell.tail" && /\b(?:ready|listening|started|localhost|127\.0\.0\.1)\b/i.test(input.output);
  const isScanner = input.tool === "net.scan" || input.tool === "pentest.recon" || /\b(?:nmap|nikto|nuclei|ffuf|gobuster)\b/i.test(command);
  const isActiveSecurity = input.tool === "http.fetch" && !/^(?:GET|HEAD|OPTIONS)?$/i.test(String(input.args?.method ?? "GET"));

  if (isWrite) add(["implementation"], "artifact", "supporting");
  if (isCheck) add(["verification", "implementation"], "automated-check", "decisive");
  if (isCheck && envelope.outcome.kind === "bugfix") add(["reproduction"], "reproduction", "decisive");
  if (isStart) add(["server"], "process-start", "decisive");
  if (isReady) add(["server"], "readiness", "decisive");
  if (isProbe) add(["server"], "probe", "decisive");
  if (isScanner) add(["assessment", "finding"], "scanner-lead", "supporting");
  if (isActiveSecurity) add(["assessment"], "reproduction", "decisive");
  if (envelope.outcome.kind === "pentest" && input.artifact && input.ok) add(["assessment"], "artifact", "decisive");
  if (input.tool === "web.search" || input.tool === "web.fetch" || input.tool === "fs.read") {
    add(["answer", "reproduction"], "observation", "supporting");
  }
  envelope.outcome.status = deriveOutcomeStatus(envelope.outcome, envelope.evidence);
  return records;
}

export function recordAnswerEvidence(
  envelope: OutcomeEnvelope,
  answer: string,
): EvidenceRecord | undefined {
  const criterion = envelope.outcome.criteria.find((item) => item.id === "answer");
  if (!criterion || !answer.trim()) return undefined;
  const evidence = createEvidence({
    outcomeId: envelope.outcome.id,
    outcomeRevision: envelope.outcome.revision,
    criterionIds: [criterion.id],
    source: { tool: "assistant.final", callId: `final-${envelope.outcome.revision}` },
    kind: "observation",
    freshness: "current",
    strength: "decisive",
    observation: answer.slice(0, 4_000),
    result: "pass",
  });
  envelope.evidence.push(evidence);
  linkEvidence(envelope.outcome, evidence);
  envelope.outcome.status = deriveOutcomeStatus(envelope.outcome, envelope.evidence);
  return evidence;
}
