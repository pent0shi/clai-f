import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatImage, CompletionRequest, CompletionResult } from "../../src/types.js";

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
    // The canonical prompt is recomposed immediately before every provider
    // round and retains all authority-bearing state even under compact budgets.
    expect(streamMock).toHaveBeenCalledTimes(2);
    for (const [request] of streamMock.mock.calls as Array<[CompletionRequest]>) {
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      expect(system).toContain("CURRENT MODE: AGENT");
      expect(system).toContain("OUTCOME CONTRACT");
      expect(system).toContain("ACTIVE PLAN");
      expect(system).toContain("ENGAGEMENT SCOPE");
      expect(system).toContain("TASK STATE");
    }
    // No fence protocol required in first model response
    expect(streamMock.mock.calls[0]![0].tools?.length).toBeGreaterThan(0);
  });

  it("preserves parallel tool bodies and session-state ordering for the next model call", async () => {
    const evidencePath = join(cwd, "evidence.txt");
    const appPath = join(cwd, "index.js");
    const body = `BEGIN-${"x".repeat(16_000)}-END`;
    await writeFile(evidencePath, body, "utf8");
    let turn = 0;

    streamMock.mockImplementation(
      async (request: CompletionRequest): Promise<CompletionResult> => {
        turn += 1;
        if (turn === 1) {
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              { id: "call_list", name: "fs.list", args: { path: cwd } },
              { id: "call_read", name: "fs.read", args: { path: evidencePath } },
              { id: "call_check", name: "tool.check", args: { tools: ["node"] } },
            ],
            finishReason: "tool_calls",
          };
        }

        if (turn === 2) {
          const groupStart = request.messages.findIndex(
            (message) =>
              message.role === "assistant" && message.toolCalls?.length === 3,
          );
          expect(groupStart).toBeGreaterThanOrEqual(0);
          const toolGroup = request.messages.slice(groupStart + 1, groupStart + 4);
          expect(toolGroup.map((message) => message.role)).toEqual([
            "tool",
            "tool",
            "tool",
          ]);
          expect(toolGroup.map((message) => message.toolCallId)).toEqual([
            "call_list",
            "call_read",
            "call_check",
          ]);
          expect(toolGroup[0]?.content).toContain("evidence.txt");
          expect(toolGroup[1]?.content).toContain(body);
          expect(toolGroup[2]?.content).toMatch(/node/i);
          expect(toolGroup.map((message) => message.content).join("\n")).not.toMatch(
            /No stored body|\[context-note\]/i,
          );
          expect(request.messages[groupStart + 4]).toMatchObject({
            role: "system",
          });

          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              {
                id: "call_write",
                name: "fs.write",
                args: { path: appPath, content: 'console.log("ok");\n' },
              },
            ],
            finishReason: "tool_calls",
          };
        }

        if (turn === 3) {
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              {
                id: "call_verify",
                name: "shell.exec",
                args: { command: "node --check index.js", cwd },
              },
            ],
            finishReason: "tool_calls",
          };
        }

        return {
          text: "done",
          provider: "openai",
          model: "gpt-test",
          finishReason: "stop",
        };
      },
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    await expect(
      runAgentLoop("create a tiny JavaScript app after inspecting the project and tools", {
        provider: "openai",
        model: "gpt-4o-mini",
        maxSteps: 8,
      }),
    ).resolves.toContain("done");
    await expect(readFile(appPath, "utf8")).resolves.toBe('console.log("ok");\n');
    expect(streamMock).toHaveBeenCalledTimes(4);
  });

  it("recovers when action narration follows a productive tool step", async () => {
    let turn = 0;
    streamMock.mockImplementation(
      async (request: CompletionRequest, onToken: (token: string) => void) => {
        turn += 1;
        if (turn === 1) {
          return {
            text: "",
            provider: "gemini",
            model: "gemini-test",
            toolCalls: [
              { id: "call_list_first", name: "fs.list", args: { path: cwd } },
            ],
            finishReason: "tool_calls",
          };
        }
        if (turn === 2) {
          const text = "Let's check the remaining files.";
          onToken(text);
          return {
            text,
            provider: "gemini",
            model: "gemini-test",
            finishReason: "stop",
          };
        }
        expect(request.messages.at(-1)?.content).toMatch(/call.*tool|take the action/i);
        return {
          text: "Found all remaining files.",
          provider: "gemini",
          model: "gemini-test",
          finishReason: "stop",
        };
      },
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    const answer = await runAgentLoop("find all files in this directory", {
      provider: "gemini",
      model: "gemini-test",
      maxSteps: 5,
    });

    expect(streamMock).toHaveBeenCalledTimes(3);
    expect(answer).toBe("Found all remaining files.");
  });

  it("does not append internal outcome diagnostics to a continue response", async () => {
    streamMock.mockImplementation(
      async (): Promise<CompletionResult> => ({
        text: "Here are the remaining results.",
        provider: "gemini",
        model: "gemini-test",
        finishReason: "stop",
      }),
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    const answer = await runAgentLoop("continue", {
      provider: "gemini",
      model: "gemini-test",
      maxSteps: 2,
      history: [
        { role: "user", content: "find the remaining posts" },
        { role: "assistant", content: "I found the blog index." },
      ],
    });

    expect(answer).toBe("Here are the remaining results.");
    expect(answer).not.toMatch(/Status:|Required outcome criteria|Remaining:/);
  });

  it("passes exact image bytes, MIME, and mode to the provider", async () => {
    const image: ChatImage = {
      dataBase64: Buffer.from([0, 1, 2, 253, 254, 255]).toString("base64"),
      mediaType: "image/png",
      path: join(cwd, "screen.png"),
    };
    streamMock.mockImplementation(
      async (request: CompletionRequest): Promise<CompletionResult> => {
        const user = request.messages.find((message) => message.role === "user");
        expect(user?.images).toEqual([image]);
        expect(Buffer.from(user!.images![0]!.dataBase64, "base64")).toEqual(
          Buffer.from([0, 1, 2, 253, 254, 255]),
        );
        expect(request.messages[0]?.content).toContain("CURRENT MODE: ASK");
        return {
          text: "inspected",
          provider: "openai",
          model: "gpt-test",
          finishReason: "stop",
        };
      },
    );
    const { runAgentLoop } = await import("../../src/agent/runner.js");
    await expect(
      runAgentLoop("inspect this image", {
        provider: "openai",
        model: "gpt-4o-mini",
        mode: "ask",
        images: [image],
      }),
    ).resolves.toBe("inspected");
  });
});
