import { describe, expect, it } from "vitest";
import {
  budgetRemaining,
  consumeBudget,
  createRecoveryBudgets,
  freestyleClaimsAppReady,
  looksLikeShallowPentestReport,
  recoveryForMissingFeature,
  recoveryForPrematureComplete,
  recoveryForShallowPentest,
} from "../src/agent/must-continue.js";
import { shouldYieldForResponderBeforeReport } from "../src/agent/runner.js";
import { createPlan } from "../src/store/plan.js";
import { scopeContextMessage } from "../src/agent/scope-context.js";
import { isReadOnlyReconTool } from "../src/agent/task-evidence.js";

describe("recovery budgets", () => {
  it("tracks and exhausts budgets", () => {
    const b = createRecoveryBudgets();
    expect(budgetRemaining(b, "forcePlan")).toBe(true);
    consumeBudget(b, "forcePlan");
    consumeBudget(b, "forcePlan");
    expect(budgetRemaining(b, "forcePlan")).toBe(false);
    consumeBudget(b, "freshnessUsed");
    expect(budgetRemaining(b, "freshnessUsed")).toBe(false);
  });

  it("builds feature and premature-complete messages", () => {
    expect(recoveryForMissingFeature("/tmp/app").message).toMatch(/feature/i);
    const r = recoveryForPrematureComplete({
      unfinished: [{ id: "t2", title: "implement", state: "pending" }],
      next: { id: "t2", title: "implement", state: "pending" },
      pentest: false,
      errorFix: false,
    });
    expect(r.message).toMatch(/t2/);
    expect(r.notice).toMatch(/unfinished/i);
  });
});

describe("shallow pentest report", () => {
  it("flags ports-only write-ups without deep tests", () => {
    expect(
      looksLikeShallowPentestReport(
        "Assessment complete. Open ports 80, 443. Server header nginx. Missing security headers noted.",
        { productiveSteps: 5, sawActiveTest: false },
      ),
    ).toBe(true);
    expect(
      looksLikeShallowPentestReport(
        "Confirmed IDOR on /api/users/{id} — accessed another user's data. PoC attached.",
        { productiveSteps: 5, sawActiveTest: false },
      ),
    ).toBe(false);
    expect(
      looksLikeShallowPentestReport(
        "Open ports 80 and 443 only.",
        { productiveSteps: 5, sawActiveTest: true },
      ),
    ).toBe(false);
    expect(recoveryForShallowPentest().message).toMatch(/threat model/i);
  });
});

describe("freestyle ready claims", () => {
  it("detects run-yourself style completion prose", () => {
    expect(freestyleClaimsAppReady("Run npm run dev to start")).toBe(true);
    expect(freestyleClaimsAppReady("Here is a random note")).toBe(false);
  });
});

describe("read-only recon tools", () => {
  it("allows recon tools without task bracket", () => {
    expect(isReadOnlyReconTool("dns.lookup")).toBe(true);
    expect(isReadOnlyReconTool("http.fetch")).toBe(true);
    expect(isReadOnlyReconTool("net.scan")).toBe(true);
    expect(isReadOnlyReconTool("fs.write")).toBe(false);
    expect(isReadOnlyReconTool("shell.exec")).toBe(false);
  });
});

describe("scope context", () => {
  it("renders authorized and excluded targets", () => {
    const msg = scopeContextMessage({
      name: "acme",
      authorizedTargets: ["app.example.com"],
      excludedTargets: ["blog.example.com"],
      createdAt: new Date().toISOString(),
    });
    expect(msg).toMatch(/ENGAGEMENT SCOPE/);
    expect(msg).toContain("app.example.com");
    expect(msg).toContain("blog.example.com");
  });

  it("returns undefined when inactive", () => {
    expect(scopeContextMessage(undefined)).toBeUndefined();
    expect(
      scopeContextMessage({ authorizedTargets: [], createdAt: "x" }),
    ).toBeUndefined();
  });
});


describe("final report responder deferral", () => {
  it("yields for an outstanding responder only when all foreground work is reporting", () => {
    const plan = createPlan({
      sessionId: "report-yield",
      goal: "assessment",
      detail: "test then report",
      kind: "pentest",
      taskTitles: ["Enumerate endpoints", "Compile final report"],
    });
    plan.tasks[0]!.state = "done";
    plan.tasks[1]!.state = "pending";

    expect(
      shouldYieldForResponderBeforeReport(
        plan,
        [{ responder: true } as never],
        [],
      ),
    ).toBe(true);
    expect(
      shouldYieldForResponderBeforeReport(
        plan,
        [],
        [{ responder: true, analyzedAt: undefined } as never],
      ),
    ).toBe(true);
    expect(
      shouldYieldForResponderBeforeReport(
        plan,
        [],
        [{ id: "current", responder: true, analyzedAt: undefined } as never],
        "current",
      ),
    ).toBe(false);
    expect(
      shouldYieldForResponderBeforeReport(
        plan,
        [],
        [{ id: "other", responder: true, analyzedAt: undefined } as never],
        "current",
      ),
    ).toBe(true);
    expect(
      shouldYieldForResponderBeforeReport(
        plan,
        [],
        [{ responder: true, analyzedAt: "done" } as never],
      ),
    ).toBe(false);

    plan.tasks[0]!.state = "pending";
    expect(
      shouldYieldForResponderBeforeReport(
        plan,
        [{ responder: true } as never],
        [],
      ),
    ).toBe(false);
  });
});
