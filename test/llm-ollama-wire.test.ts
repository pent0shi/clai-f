import { afterEach, describe, expect, it, vi } from "vitest";
import { ollamaOptions, ollamaProvider } from "../src/llm/ollama.js";

/** LLM-008/LLM-009: native /api/chat body carries context and output budgets. */

function stubFetch(): { bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ message: { content: "ok" }, prompt_eval_count: 1, eval_count: 2 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  return { bodies };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ollamaOptions", () => {
  it("sends a bounded, model-aware num_ctx and the requested output budget", () => {
    const options = ollamaOptions("llama3.1:70b", { maxTokens: 12_000 });
    expect(options.num_predict).toBe(12_000);
    expect(options.num_ctx).toBeGreaterThanOrEqual(8_192);
    expect(options.num_ctx).toBeLessThanOrEqual(32_768);
  });

  it("falls back to a usable output default", () => {
    expect(ollamaOptions("llama3.2", {}).num_predict).toBe(4_096);
  });
});

describe("native /api/chat body", () => {
  it("includes options and keep_alive", async () => {
    const { bodies } = stubFetch();
    await ollamaProvider.complete(
      { messages: [{ role: "user", content: "hi" }], model: "llama3.2", maxTokens: 2_048 },
      { baseUrl: "http://localhost:11434" },
    );
    const body = bodies[0]!;
    expect(body.keep_alive).toBe("5m");
    const options = body.options as Record<string, unknown>;
    expect(options.num_predict).toBe(2_048);
    expect(typeof options.num_ctx).toBe("number");
  });

  it("replays assistant tool arguments as an object", async () => {
    const { bodies } = stubFetch();
    await ollamaProvider.complete(
      {
        model: "llama3.2",
        messages: [
          { role: "user", content: "write it" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "c1", name: "fs.write", args: { path: "a.txt" } }],
          },
          { role: "tool", content: "ok=true", toolCallId: "c1", name: "fs.write" },
        ],
      },
      { baseUrl: "http://localhost:11434" },
    );
    const messages = bodies[0]!.messages as Array<Record<string, any>>;
    const assistant = messages.find((m) => m.tool_calls)!;
    expect(assistant.tool_calls[0].function.arguments).toEqual({ path: "a.txt" });
    const toolMessage = messages.find((m) => m.role === "tool")!;
    expect(toolMessage.tool_name).toBe("fs_write");
  });
});
