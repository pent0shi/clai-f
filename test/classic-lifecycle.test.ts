import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const replSource = readFileSync(join(root, "src/repl.ts"), "utf8");
const promptSource = readFileSync(join(root, "src/repl/prompt-line.ts"), "utf8");

describe("classic exit boundary", () => {
  it("resolves an exit intent from the prompt instead of exiting the process", async () => {
    const { PROMPT_EXIT_INTENT } = await import("../src/repl/prompt-line.js");
    expect(PROMPT_EXIT_INTENT.length).toBeGreaterThan(0);
    expect(promptSource).not.toMatch(/process\.exit\(/);
    expect(replSource).toContain("if (rawLine === PROMPT_EXIT_INTENT) break;");
  });

  it("routes every classic exit through one idempotent shutdown", () => {
    const exits = replSource.match(/process\.exit\(/g) ?? [];
    // Only the single shutdown boundary may terminate the process.
    expect(exits).toHaveLength(1);
    expect(replSource).toContain("const shutdown = async (code: number)");
    expect(replSource).toContain("await finalizeSession();");
    expect(replSource).toContain("void shutdown(0)");
  });

  it("treats unknown fatal errors as fatal instead of suppressing them", () => {
    expect(replSource).not.toContain("error suppressed");
    expect(replSource).toContain("void shutdown(1)");
    expect(replSource).toContain("redactSecrets(message)");
  });
});

describe("classic session reset", () => {
  it("rotates identity, allowances, plan approval and workspace", async () => {
    const { resetClassicSessionContext } = await import("../src/repl.js");
    const { createSessionPolicy } = await import("../src/agent/session-policy.js");
    const { getActiveSessionWorkspace } = await import(
      "../src/store/session-workspace.js"
    );

    const state = { session: createSessionPolicy() };
    state.session.allow.add("shell.exec");
    state.session.planApproved.value = true;
    state.session.pentestAuthorized.value = true;
    const previousId = state.session.sessionId;
    const previousWorkspace = getActiveSessionWorkspace()?.folderName;

    resetClassicSessionContext(state);

    expect(state.session.sessionId).not.toBe(previousId);
    expect(state.session.allow.size).toBe(0);
    expect(state.session.planApproved.value).toBe(false);
    expect(state.session.pentestAuthorized.value).toBe(false);
    const workspace = getActiveSessionWorkspace()?.folderName;
    expect(workspace).toBeTruthy();
    if (previousWorkspace) expect(workspace).not.toBe(previousWorkspace);
  });

  it("wires /clean to the shared reset", () => {
    const cleanBlock = replSource.slice(
      replSource.indexOf('case "/clean": {'),
      replSource.indexOf('case "/update":'),
    );
    expect(cleanBlock).toContain("state.historyId = undefined;");
    expect(cleanBlock).toContain("resetClassicSessionContext(state);");
  });
});
