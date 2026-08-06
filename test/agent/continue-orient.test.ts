import { describe, expect, it } from "vitest";
import {
  buildContinueOrientation,
  extractRecentToolHints,
  looksLikeContinueOrResumePrompt,
  shouldInjectContinueOrientation,
} from "../../src/agent/continue-orient.js";
import type { SessionPlan } from "../../src/store/plan.js";
import type { BackgroundJob } from "../../src/tools/jobs.js";
import type { ChatMessage } from "../../src/types.js";

function job(partial: Partial<BackgroundJob> & { id: string }): BackgroundJob {
  return {
    id: partial.id,
    command: partial.command ?? "ffuf -u http://x/FUZZ",
    commandDisplay: partial.commandDisplay ?? partial.command ?? "ffuf -u http://x/FUZZ",
    cwd: partial.cwd ?? "/tmp",
    status: partial.status ?? "running",
    startedAt: partial.startedAt ?? new Date().toISOString(),
    artifactPath: partial.artifactPath ?? "/tmp/a",
    stdoutArtifact: partial.stdoutArtifact ?? "/tmp/o",
    stderrArtifact: partial.stderrArtifact ?? "/tmp/e",
    artifacts: partial.artifacts ?? {
      stdout: { path: "/tmp/o", chunks: [], bytes: 0, droppedBytes: 0, redacted: false, sha256: "" },
      stderr: { path: "/tmp/e", chunks: [], bytes: 0, droppedBytes: 0, redacted: false, sha256: "" },
    },
    redactionProfile: "default",
    ownerSessionId: "s1",
  };
}

const plan: SessionPlan = {
  sessionId: "s1" as SessionPlan["sessionId"],
  goal: "Assess target",
  detail: "recon then fuzz",
  kind: "pentest",
  status: "executing",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  tasks: [
    { id: "t1", title: "DNS", state: "done" },
    { id: "t2", title: "Content discovery ffuf", state: "in_progress" },
    { id: "t3", title: "Auth testing", state: "pending" },
  ],
};

describe("continue-orient", () => {
  it("detects continue / resume phrasing", () => {
    expect(looksLikeContinueOrResumePrompt("continue")).toBe(true);
    expect(looksLikeContinueOrResumePrompt("resume")).toBe(true);
    expect(looksLikeContinueOrResumePrompt("pick up where you left off")).toBe(
      true,
    );
    expect(looksLikeContinueOrResumePrompt("build a todo app with auth")).toBe(
      false,
    );
  });

  it("injects on continue with open task and live job", () => {
    expect(
      shouldInjectContinueOrientation({
        prompt: "continue",
        plan,
        history: [
          { role: "user", content: "pentest x" },
          { role: "tool", content: "Tool shell.start result ok", name: "shell.start", ok: true },
        ],
        runningJobs: [job({ id: "abc", status: "running" })],
      }),
    ).toBe(true);
  });

  it("does not inject on pure informational questions", () => {
    expect(
      shouldInjectContinueOrientation({
        prompt: "what did you find so far?",
        plan,
        informationalQuery: true,
        runningJobs: [job({ id: "abc" })],
      }),
    ).toBe(false);
  });

  it("builds briefing with jobs, open task, and recent tools", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "start" },
      {
        role: "tool",
        name: "shell.start",
        ok: true,
        content: "Tool shell.start result (exit=0, ok=true):\njob abc running ffuf",
      },
    ];
    const text = buildContinueOrientation({
      prompt: "continue",
      plan,
      history,
      runningJobs: [job({ id: "abc", status: "running" })],
    });
    expect(text).toMatch(/CONTINUE \/ RECOVER MID-WORK/);
    expect(text).toMatch(/in_progress|Content discovery/i);
    expect(text).toMatch(/\[abc\]/);
    expect(text).toMatch(/shell\.jobs/);
    expect(text).toMatch(/do not mark tasks done/i);
    expect(text).toMatch(/higher-level roadmap/i);
    expect(text).toMatch(/append omitted work with task\.add/i);
    expect(text).toMatch(/shell\.start/);
  });

  it("extracts recent tool hints newest-last order", () => {
    const hints = extractRecentToolHints([
      { role: "tool", name: "a", content: "first", ok: true },
      { role: "user", content: "x" },
      { role: "tool", name: "b", content: "second", ok: false },
    ]);
    expect(hints.map((h) => h.name)).toEqual(["a", "b"]);
    expect(hints[1]?.ok).toBe(false);
  });
});
