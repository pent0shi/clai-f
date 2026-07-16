import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let root = "";
let previousLogDir: string | undefined;

afterEach(async () => {
  if (previousLogDir === undefined) delete process.env.CLAI_LOG_DIR;
  else process.env.CLAI_LOG_DIR = previousLogDir;
  vi.resetModules();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("local diagnostic export", () => {
  it("exports IDs and state while omitting prompts, commands, output, and secrets", async () => {
    root = await mkdtemp(join(tmpdir(), "clai-diagnostics-"));
    previousLogDir = process.env.CLAI_LOG_DIR;
    process.env.CLAI_LOG_DIR = join(root, "logs");
    vi.resetModules();
    const { auditLog, exportDiagnostics } = await import("../src/store/logs.js");
    const secret = "sk-super-secret-value";
    await auditLog("tool.result", {
      sessionId: "session-1",
      toolCallId: "call-2",
      status: "failed",
      reason: "timeout",
      prompt: "private user request",
      command: `curl -H Authorization:${secret}`,
      output: "private project source",
    });
    const destination = join(root, "diagnostic.json");
    const receipt = await exportDiagnostics(destination);
    const text = await readFile(destination, "utf8");

    expect(receipt.events).toBe(1);
    expect(text).toContain("session-1");
    expect(text).toContain("call-2");
    expect(text).toContain("failed");
    expect(text).not.toContain("private user request");
    expect(text).not.toContain("private project source");
    expect(text).not.toContain(secret);
  });
});
