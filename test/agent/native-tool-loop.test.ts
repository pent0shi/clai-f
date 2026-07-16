import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
