import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionRequest, CompletionResult } from "../../src/types.js";

const streamMock = vi.fn();

vi.mock("../../src/llm/router.js", () => ({
  streamWithProvider: (
    request: CompletionRequest,
    onToken: (t: string) => void,
  ): Promise<CompletionResult> => streamMock(request, onToken),
  completeWithProvider: vi.fn(),
}));

vi.mock("../../src/commands/providers.js", () => ({
  ensureProviderConfigured: vi.fn(async () => undefined),
}));

vi.mock("../../src/agent/confirm-port.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/agent/confirm-port.js")
  >("../../src/agent/confirm-port.js");
  const auto = {
    confirmTool: async () => true,
    confirmPlan: async () => true,
    confirmMany: async (items: Array<{ id: string }>) =>
      Object.fromEntries(items.map((i) => [i.id, true])),
  };
  return {
    ...actual,
    inquirerConfirmPort: auto,
  };
});

describe("native tool loop integration", () => {
  let cwd: string;
  let prevCwd: string;

  beforeEach(async () => {
    prevCwd = process.cwd();
    cwd = await mkdtemp(join(tmpdir(), "clai-native-"));
    process.chdir(cwd);
    streamMock.mockReset();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await rm(cwd, { recursive: true, force: true });
  });

  it("writes a file from native toolCalls without fence text", async () => {
    const target = join(cwd, "hello.ts");
    const body = "export const n = 42;\n";
    let turn = 0;
    streamMock.mockImplementation(
      async (
        request: CompletionRequest,
        onToken: (t: string) => void,
      ): Promise<CompletionResult> => {
        turn += 1;
        if (turn === 1) {
          // First turn: native fs.write
          expect(request.tools?.length).toBeGreaterThan(0);
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              {
                id: "call_write",
                name: "fs.write",
                args: { path: target, content: body },
              },
            ],
            finishReason: "tool_calls",
          };
        }
        // Second turn: final answer
        onToken("done");
        return {
          text: "done",
          provider: "openai",
          model: "gpt-test",
          finishReason: "stop",
        };
      },
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    const autoConfirm = {
      confirmTool: async () => true,
      confirmPlan: async () => true,
      confirmMany: async (items: Array<{ id: string }>) =>
        Object.fromEntries(items.map((i) => [i.id, true as const])),
    };
    const answer = await runAgentLoop("write hello.ts with n=42", {
      provider: "openai",
      model: "gpt-4o-mini",
      maxSteps: 5,
      confirm: autoConfirm as never,
    });

    const written = await readFile(target, "utf8");
    expect(written).toBe(body);
    expect(answer).toContain("done");
    // No fence protocol required in first model response
    expect(streamMock.mock.calls[0]![0].tools?.length).toBeGreaterThan(0);
  });
});
