import { describe, expect, it } from "vitest";
import {
  isPlanReminderMilestone,
  maybeAppendPlanModeReminder,
  planModeResearchReminder,
  shouldAttachPlanModeReminder,
  PLAN_REMINDER_FIRST_STEP,
  PLAN_REMINDER_STEP_INTERVAL,
} from "../../src/agent/plan-mode-reminders.js";

describe("plan-mode reminders", () => {
  it("milestones start at 15 then every 10", () => {
    expect(isPlanReminderMilestone(14)).toBe(false);
    expect(isPlanReminderMilestone(15)).toBe(true);
    expect(isPlanReminderMilestone(20)).toBe(false);
    expect(isPlanReminderMilestone(25)).toBe(true);
    expect(isPlanReminderMilestone(35)).toBe(true);
    expect(PLAN_REMINDER_FIRST_STEP).toBe(15);
    expect(PLAN_REMINDER_STEP_INTERVAL).toBe(10);
  });

  it("only attaches in plan mode without draft plan at milestones", () => {
    const base = {
      isPlanMode: true,
      planApproved: false,
      hasDraftPlan: false,
      productiveStep: 15,
      alreadyRemindedAt: new Set<number>(),
    };
    expect(shouldAttachPlanModeReminder(base)).toBe(true);
    expect(
      shouldAttachPlanModeReminder({ ...base, isPlanMode: false }),
    ).toBe(false);
    expect(
      shouldAttachPlanModeReminder({ ...base, planApproved: true }),
    ).toBe(false);
    expect(
      shouldAttachPlanModeReminder({ ...base, hasDraftPlan: true }),
    ).toBe(false);
    expect(
      shouldAttachPlanModeReminder({ ...base, productiveStep: 16 }),
    ).toBe(false);
    expect(
      shouldAttachPlanModeReminder({
        ...base,
        alreadyRemindedAt: new Set([15]),
      }),
    ).toBe(false);
  });

  it("appends a calm note without changing success markers", () => {
    const body = "Tool http.fetch result (exit=0, ok=true):\nstatus 200";
    const { content, reminded } = maybeAppendPlanModeReminder(body, {
      isPlanMode: true,
      planApproved: false,
      hasDraftPlan: false,
      productiveStep: 15,
      alreadyRemindedAt: new Set(),
      step: 15,
      kindHint: "pentest",
    });
    expect(reminded).toBe(true);
    expect(content.startsWith(body)).toBe(true);
    expect(content).toContain("[plan-mode note · step 15]");
    expect(content).toContain("plan.create");
    expect(content.length - body.length).toBeLessThan(500);
  });

  it("reminder text stays informational (no hard stop wording)", () => {
    const text = planModeResearchReminder({ step: 25, kindHint: "pentest" });
    expect(text).toMatch(/step 25/);
    expect(text.toLowerCase()).not.toMatch(/you must stop|abort now|forbidden/);
  });
});
