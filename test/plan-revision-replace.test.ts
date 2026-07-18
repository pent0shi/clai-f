import { afterEach, describe, expect, it } from "vitest";
import { handlePlanTool } from "../src/agent/plan-tool.js";
import { buildPlanRevisionPrompt } from "../src/agent/plan-decision.js";
import { LoopGuard } from "../src/agent/loop-guard.js";
import { createSessionPolicy } from "../src/agent/session-policy.js";
import {
  clearAllPlans,
  createPlan,
  loadPlan,
  savePlan,
} from "../src/store/plan.js";

describe("plan.create draft revision replaces obsolete tasks", () => {
  afterEach(async () => {
    await clearAllPlans();
  });

  it("drops unmatched draft tasks when user revises frontend-only", async () => {
    const session = createSessionPolicy("draft-rewrite");
    const prior = createPlan({
      sessionId: "draft-rewrite",
      goal: "React blogging app",
      detail: "Next.js + Prisma + JWT",
      kind: "coding",
      taskTitles: [
        "Scaffold Next.js app",
        "Install dependencies",
        "Prisma schema + SQLite + seed",
        "Auth (JWT + middleware)",
        "Data layer + API routes",
        "Public UI",
        "Admin dashboard",
        "SEO + polish",
        "Verify build + runtime",
      ],
    });
    // Still awaiting accept — classic "suggest changes" path.
    prior.status = "draft";
    await savePlan(prior);

    const result = await handlePlanTool(
      {
        name: "plan.create",
        args: {
          goal: "Frontend-only React blogging app",
          detail:
            "Vite + React + TS SPA, glassmorphism, latest packages, localStorage — no backend",
          kind: "coding",
          tasks: [
            "Scaffold Vite + React + TS app",
            "Install latest dependencies",
            "Content + localStorage persistence",
            "Client-side admin gate",
            "Public UI (glassmorphism)",
            "Admin dashboard",
            "SEO + polish",
            "Verify build + runtime",
          ],
        },
      },
      session,
      { loopGuard: new LoopGuard(), step: 2 },
    );

    expect(result.ok).toBe(true);
    const loaded = await loadPlan("draft-rewrite");
    expect(loaded).toBeDefined();
    const titles = loaded!.tasks.map((t) => t.title);
    expect(titles).toEqual([
      "Scaffold Vite + React + TS app",
      "Install latest dependencies",
      "Content + localStorage persistence",
      "Client-side admin gate",
      "Public UI (glassmorphism)",
      "Admin dashboard",
      "SEO + polish",
      "Verify build + runtime",
    ]);
    // Backend leftovers must not survive a draft rewrite.
    expect(titles.some((t) => /Prisma|JWT|API routes|Next\.js/i.test(t))).toBe(
      false,
    );
    expect(loaded!.tasks).toHaveLength(8);
    // Matching titles keep their prior id when possible.
    const admin = loaded!.tasks.find((t) => t.title === "Admin dashboard");
    expect(admin?.id).toBe("t7");
    expect(loaded!.status).toBe("draft");
  });

  it("preserves matching title state on draft rewrite", async () => {
    const session = createSessionPolicy("draft-state");
    const prior = createPlan({
      sessionId: "draft-state",
      goal: "app",
      detail: "d",
      kind: "coding",
      taskTitles: ["Scaffold project", "Implement feature", "Verify"],
    });
    prior.status = "draft";
    // Unusual for draft, but prove title-match still maps state.
    prior.tasks[0]!.state = "done";
    await savePlan(prior);

    const result = await handlePlanTool(
      {
        name: "plan.create",
        args: {
          goal: "app",
          detail: "revised",
          kind: "coding",
          tasks: [
            "Scaffold project",
            "Implement feature",
            "Add glassmorphism theme",
            "Verify",
          ],
        },
      },
      session,
      { loopGuard: new LoopGuard(), step: 1 },
    );
    expect(result.ok, result.modelNote).toBe(true);
    const loaded = await loadPlan("draft-state");
    expect(loaded!.tasks.map((t) => t.title)).toEqual([
      "Scaffold project",
      "Implement feature",
      "Add glassmorphism theme",
      "Verify",
    ]);
    expect(loaded!.tasks[0]!.state).toBe("done");
    expect(loaded!.tasks[0]!.id).toBe("t1");
  });

  it("post-approval rewrite keeps finished work and drops obsolete pending", async () => {
    const session = createSessionPolicy("post-approve-rewrite");
    session.planApproved.value = true;
    const prior = createPlan({
      sessionId: "post-approve-rewrite",
      goal: "blog",
      detail: "full stack",
      kind: "coding",
      taskTitles: [
        "Scaffold Next.js",
        "Prisma schema",
        "Public UI",
        "Verify",
      ],
    });
    prior.status = "in_progress";
    prior.tasks[0]!.state = "done";
    prior.tasks[1]!.state = "pending";
    prior.tasks[2]!.state = "pending";
    prior.tasks[3]!.state = "pending";
    await savePlan(prior);

    const result = await handlePlanTool(
      {
        name: "plan.create",
        args: {
          goal: "blog frontend-only",
          detail: "no backend",
          kind: "coding",
          tasks: [
            "Scaffold Next.js",
            "Public UI glassmorphism",
            "localStorage content",
            "Verify",
          ],
        },
      },
      session,
      { loopGuard: new LoopGuard(), step: 2 },
    );

    expect(result.ok).toBe(true);
    const loaded = await loadPlan("post-approve-rewrite");
    const titles = loaded!.tasks.map((t) => t.title);
    expect(titles).not.toContain("Prisma schema");
    expect(titles).toContain("Scaffold Next.js");
    expect(loaded!.tasks.find((t) => t.title === "Scaffold Next.js")?.state).toBe(
      "done",
    );
  });

  it("revision prompt demands a complete decisive rewrite", () => {
    const prompt = buildPlanRevisionPrompt(
      "no need of backend only frontend, and use glassmorphism, and all latest packages",
      { planVersion: 2 },
    );
    expect(prompt).toMatch(/COMPLETE intended/i);
    expect(prompt).toMatch(/Omit obsolete/i);
    expect(prompt).toMatch(/decisively|decisive/i);
    expect(prompt).toMatch(/frontend-only/i);
    expect(prompt).not.toMatch(/smallest add\/edit\/remove/);
    expect(prompt).toContain("no need of backend only frontend");
  });
});
