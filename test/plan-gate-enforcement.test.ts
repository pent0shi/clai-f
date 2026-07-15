import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/modes/agent.js";
import { deletePlan } from "../src/store/plan.js";

const stream = vi.fn();
const runTool = vi.fn();

vi.mock("../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/llm/router.js")>();
  return {
    ...actual,
    streamWithProvider: (req: unknown, onToken: (t: string) => void) =>
      stream(req, onToken),
  };
});

vi.mock("../src/tools/registry.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/tools/registry.js")>();
  return {
    ...actual,
    runToolCall: (call: unknown, opts: unknown) => runTool(call, opts),
  };
});

vi.mock("../src/commands/providers.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/commands/providers.js")>();
  return { ...actual, ensureProviderConfigured: async () => {} };
});

function streamReply(text: string) {
  return (_req: unknown, onToken: (t: string) => void) => {
    onToken(text);
    return Promise.resolve({ text, provider: "nvidia", model: "test-model" });
  };
}

describe("agent plan gate enforcement", () => {
  beforeEach(async () => {
    stream.mockReset();
    runTool.mockReset();
    await deletePlan("session-123").catch(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks freestyle scaffold on coding builds until plan.create exists", async () => {
    stream
      .mockImplementationOnce(
        streamReply('```tool\n{"name":"shell.exec","args":{"command":"npm create vite@latest todo-app"}}\n```')
      )
      .mockImplementationOnce(
        streamReply(
          '```tool\n{"name":"plan.create","args":{"goal":"todo app","detail":"vite react todo on Desktop","tasks":["scaffold project","implement todo feature","install deps","Start dev server with shell.start, probe localhost, leave running, report URL"],"kind":"coding"}}\n```',
        ),
      )
      .mockImplementationOnce(streamReply("Plan ready — waiting for /implement."));

    // scaffold must NOT reach runTool; plan.create is handled in-runner
    runTool.mockResolvedValue({ ok: true, output: "ok" });

    await runAgent("create a todo app on desktop", {
      session: { sessionId: "session-123", planApproved: { value: false }, allow: new Set(), pentestAuthorized: { value: false } } as any,
      maxSteps: 4,
      autoConfirm: true,
    });

    const shellCalls = runTool.mock.calls.filter(
      (c) => (c[0] as { name?: string })?.name === "shell.exec",
    );
    expect(shellCalls.length).toBe(0);
  });

  it("allows safe read-only tool calls when no active plan exists", async () => {
    stream
      .mockImplementationOnce(
        streamReply('```tool\n{"name":"fs.list","args":{"path":"/test"}}\n```')
      )
      .mockImplementationOnce(
        streamReply('I see the files. Now I will stop.')
      );

    runTool.mockResolvedValueOnce({ ok: true, output: "file1, file2" });

    await runAgent("inspect files", {
      session: { sessionId: "session-123", planApproved: { value: false }, allow: new Set(), pentestAuthorized: { value: false } } as any,
      maxSteps: 2,
    });

    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0]![0]).toMatchObject({ name: "fs.list" });
  });
});
