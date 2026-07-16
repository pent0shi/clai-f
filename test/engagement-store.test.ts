import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beginEngagementAction,
  createFinding,
  finishEngagementAction,
  loadEngagement,
  openEngagement,
  recordEngagementCheckpoint,
  reconcileEngagementJob,
  renderEngagementReport,
  saveEngagement,
  transitionFinding,
} from "../src/store/engagement.js";
import type { EngagementScope } from "../src/store/scope.js";

const scope: EngagementScope = {
  name: "restart fixture",
  authorizedTargets: ["app.test"],
  excludedTargets: ["admin.app.test"],
  allowedPhases: ["recon", "enumeration", "exploitation"],
  createdAt: "2026-07-16T00:00:00.000Z",
};

let dataDir = "";
let previousDataDir: string | undefined;

beforeEach(async () => {
  previousDataDir = process.env.CLAI_DATA_DIR;
  dataDir = await mkdtemp(join(tmpdir(), "clai-engagement-"));
  process.env.CLAI_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.CLAI_DATA_DIR;
  else process.env.CLAI_DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

describe("durable engagement graph", () => {
  it("survives restart-style save/load and reopens the same authorization", async () => {
    const graph = await openEngagement(scope);
    graph.coverage.push({ dimension: "web endpoints", state: "covered", rationale: "enumerated routes" });
    graph.residualRisk.push("Authenticated admin role was unavailable");
    await saveEngagement(graph);

    const loaded = await loadEngagement(graph.id);
    const reopened = await openEngagement(scope);
    expect(loaded).toMatchObject({ id: graph.id, schemaVersion: 1 });
    expect(reopened.id).toBe(graph.id);
    expect(reopened.coverage[0]?.dimension).toBe("web endpoints");
    expect(reopened.residualRisk).toEqual(["Authenticated admin role was unavailable"]);
  });

  it("merges parallel action saves without temp collisions or lost sibling records", async () => {
    const base = await openEngagement(scope);
    const first = structuredClone(base);
    const second = structuredClone(base);
    beginEngagementAction(first, {
      tool: "dns.lookup",
      target: "app.test",
      phase: "recon",
      capability: "dns-enumeration",
      authorized: true,
      reason: "authorized by engagement scope",
    });
    beginEngagementAction(second, {
      tool: "net.scan",
      target: "app.test",
      phase: "recon",
      capability: "active-enumeration",
      authorized: true,
      reason: "authorized by engagement scope",
    });

    await Promise.all([saveEngagement(first), saveEngagement(second)]);

    const loaded = await loadEngagement(base.id);
    expect(loaded?.actions.map((action) => action.tool).sort()).toEqual([
      "dns.lookup",
      "net.scan",
    ]);
    const files = await readdir(join(dataDir, "engagements"));
    expect(files).toEqual([`${base.id}.json`]);
  });

  it("records authorization, target, test case, evidence, and scanner leads without verifying them", async () => {
    const graph = await openEngagement(scope);
    const action = beginEngagementAction(graph, {
      tool: "net.scan",
      target: "app.test",
      phase: "recon",
      capability: "active-enumeration",
      authorized: true,
      reason: "authorized by engagement scope",
    });
    const evidence = finishEngagementAction(graph, action.id, {
      ok: true,
      scannerLead: true,
      observation: "Scanner reported a possible outdated service",
      artifactPath: "/tmp/scan.txt",
    });
    const finding = createFinding(graph, {
      title: "Possible outdated service",
      targetId: action.targetId,
      evidenceIds: [evidence.id],
    });

    expect(action.status).toBe("inconclusive");
    expect(graph.testCases[0]?.status).toBe("inconclusive");
    expect(finding.state).toBe("suspected");
    expect(() => transitionFinding(graph, finding.id, "verified", { impact: "Potential RCE" })).toThrow(/transition|reproduction|evidence/);
  });

  it("persists incremental durable scan checkpoints without treating scanner output as verification", async () => {
    const graph = await openEngagement(scope);
    const action = beginEngagementAction(graph, {
      tool: "net.scan",
      target: "app.test",
      phase: "recon",
      capability: "active-enumeration",
      authorized: true,
      reason: "authorized by engagement scope",
    });
    recordEngagementCheckpoint(graph, {
      actionId: action.id,
      jobId: "job-1",
      status: "running",
      artifactPath: "/tmp/job-1.stdout.log",
      offset: 4096,
      observation: "first service-discovery checkpoint",
    });
    reconcileEngagementJob(graph, {
      jobId: "job-1",
      status: "exited",
      artifactPath: "/tmp/job-1.stdout.log",
      offset: 8192,
      observation: "scan completed; results remain an inconclusive scanner lead",
    });
    await saveEngagement(graph);
    const loaded = await loadEngagement(graph.id);
    expect(loaded?.checkpoints).toHaveLength(2);
    expect(loaded?.checkpoints[0]).toMatchObject({ jobId: "job-1", offset: 4096 });
    expect(loaded?.actions[0]?.status).toBe("inconclusive");
    expect(loaded?.findings).toHaveLength(0);
  });

  it("requires reproduction, impact, and linked evidence before verification and reports all required sections", async () => {
    const graph = await openEngagement(scope);
    const action = beginEngagementAction(graph, {
      tool: "http.fetch",
      target: "app.test",
      phase: "exploitation",
      capability: "exploitation",
      authorized: true,
      reason: "authorized by engagement scope",
    });
    const evidence = finishEngagementAction(graph, action.id, {
      ok: true,
      observation: "Controlled request reproduced cross-role data access",
      artifactPath: "/tmp/repro.json",
    });
    const verified = createFinding(graph, { title: "Cross-role data access", targetId: action.targetId });
    transitionFinding(graph, verified.id, "reproduced", {
      reproduction: "As role A, request role B resource by identifier",
      impact: "Role A can read role B records",
      evidenceIds: [evidence.id],
    });
    transitionFinding(graph, verified.id, "verified");
    const lead = createFinding(graph, { title: "Unconfirmed cache issue", targetId: action.targetId });
    transitionFinding(graph, lead.id, "inconclusive");
    graph.coverage.push({ dimension: "authorization", state: "covered", rationale: "two roles compared" });
    graph.residualRisk.push("No privileged administrator account supplied");

    const report = renderEngagementReport(graph);
    expect(report).toContain("Verified findings\n- Cross-role data access (verified)");
    expect(report).toContain("Inconclusive leads\n- Unconfirmed cache issue (inconclusive)");
    expect(report).toContain("Coverage\n- authorization: covered");
    expect(report).toContain("Exclusions\n- admin.app.test");
    expect(report).toContain("Residual risk\n- No privileged administrator account supplied");
  });
});
