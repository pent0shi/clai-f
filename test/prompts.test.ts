import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  renderAskSystemPrompt,
  renderAgentSystemPrompt,
  agentModeDirective,
  planModeDirective,
  _ASK_TEMPLATE,
  _AGENT_TEMPLATE,
  currentDateTimeContext,
} from "../src/prompts/index.js";

describe("prompt rendering", () => {
  it("ask prompt contains ask-mode, no-system-changes instruction", () => {
    const prompt = renderAskSystemPrompt();
    expect(prompt).toContain("ask mode");
    expect(prompt).toContain("do NOT modify the system");
  });

  it("ask prompt enables read-only web research", () => {
    const prompt = renderAskSystemPrompt();
    expect(prompt).toContain("web.search");
    expect(prompt).toContain("READ-ONLY");
    expect(prompt).toContain("CANNOT run shell commands");
  });

  it("ask prompt includes OS info and current date/time", () => {
    const prompt = renderAskSystemPrompt();
    // Should have replaced the {{os}} template
    expect(prompt).not.toContain("{{os}}");
    expect(prompt).not.toContain("{{shell}}");
    expect(prompt).not.toContain("{{datetime}}");
    expect(prompt).toMatch(/\(ISO hour:/);
  });

  it("agent prompt includes tool list", () => {
    const prompt = renderAgentSystemPrompt("shell.exec, fs.read, sysinfo");
    expect(prompt).toContain("shell.exec");
    expect(prompt).toContain("fs.read");
    expect(prompt).toContain("sysinfo");
  });

  it("agent prompt has no unresolved template variables", () => {
    const prompt = renderAgentSystemPrompt("shell.exec");
    expect(prompt).not.toContain("{{os}}");
    expect(prompt).not.toContain("{{cwd}}");
    expect(prompt).not.toContain("{{tool_list}}");
    expect(prompt).not.toContain("{{shell}}");
    expect(prompt).not.toContain("{{datetime}}");
  });

  it("agent prompt contains pentesting authorization reminder", () => {
    const prompt = renderAgentSystemPrompt("net.scan");
    expect(prompt).toContain("responsible for authorization");
  });

  it("agent prompt enforces honesty and current-info behavior", () => {
    const prompt = renderAgentSystemPrompt("shell.exec");
    // Anti-fabrication is the headline rule of the rewritten prompt.
    expect(prompt).toContain("HONESTY");
    expect(prompt).toContain("fabricated success");
    expect(prompt).toContain("report ONLY what the tool output actually showed");
    // Still steers to live data and concrete summaries.
    expect(prompt).toContain("web.search");
    expect(prompt).toContain("current/volatile facts");
    expect(prompt).toContain("summarize the concrete findings");
  });

  it("formats date/time context with an hour-stable ISO stamp", () => {
    const when = new Date("2026-05-29T12:34:56.000Z");
    const text = currentDateTimeContext(when);
    // Hour-stable: seconds must not appear in the ISO hour marker.
    expect(text).toMatch(/ISO hour:/);
    expect(text).toMatch(/T\d{2}:00:00\.000Z/);
    expect(text).not.toContain("12:34:56");
  });

  it("keeps system datetime stable within the same local hour", () => {
    const a = new Date("2026-05-29T15:01:02.000");
    const b = new Date("2026-05-29T15:59:58.000");
    expect(currentDateTimeContext(a)).toBe(currentDateTimeContext(b));
  });

  it("agent prompt distinguishes agent tasks vs plan tasks and verify-before-done", () => {
    const prompt = renderAgentSystemPrompt("task.update, plan.create, shell.exec");
    expect(prompt).toMatch(/AGENT-MODE TASKS vs PLAN-MODE TASKS/i);
    expect(prompt).toMatch(/read\/analyze results|read tool results|READ results/i);
    expect(prompt).toMatch(/typecheck|automated checks/i);
    expect(prompt).toMatch(/Never mark done before success|done only when|Never mark done because/i);
  });

  it("agentModeDirective requires evidence before task done + build testing", () => {
    const d = agentModeDirective();
    expect(d).toMatch(/working checklist/i);
    expect(d).toMatch(/Never mark done on hope/i);
    expect(d).toMatch(/typecheck|automated checks/i);
    expect(d).toMatch(/open the next task immediately/i);
  });

  it("planModeDirective is plan-as-deliverable, not execution", () => {
    const d = planModeDirective();
    expect(d).toMatch(/NOT agent-mode task execution/i);
    expect(d).toMatch(/plan\.create/i);
    expect(d).toMatch(/Do not implement/i);
    expect(d).toMatch(/1000%|comprehensive|architecture/i);
  });
});

describe("phase 11 — prompt template ↔ markdown drift", () => {
  it("system.ask.md content matches the inline ask template", () => {
    const md = readFileSync(
      resolve(__dirname, "../src/prompts/system.ask.md"),
      "utf8",
    )
      .replace(/\r\n/g, "\n")
      .trimEnd();
    const inline = _ASK_TEMPLATE.replace(/\r\n/g, "\n").trimEnd();
    expect(md).toBe(inline);
  });

  it("system.agent.md content matches the inline agent template", () => {
    const md = readFileSync(
      resolve(__dirname, "../src/prompts/system.agent.md"),
      "utf8",
    )
      .replace(/\r\n/g, "\n")
      .trimEnd();
    const inline = _AGENT_TEMPLATE.replace(/\r\n/g, "\n").trimEnd();
    expect(md).toBe(inline);
  });

  it("embedded prompts match on-disk markdown (brew/bun binary source)", () => {
    // embed-prompts.mjs must be re-run whenever .md changes; this catches drift.
    for (const name of ["system.ask.md", "system.agent.md"] as const) {
      const md = readFileSync(
        resolve(__dirname, `../src/prompts/${name}`),
        "utf8",
      ).replace(/\r\n/g, "\n");
      const embedded =
        name === "system.ask.md" ? _ASK_TEMPLATE : _AGENT_TEMPLATE;
      expect(embedded.replace(/\r\n/g, "\n")).toBe(md);
    }
  });
});
