import { describe, expect, it } from "vitest";
import {
  parseOllamaToolCalls,
  toOllamaToolMessages,
  toOllamaTools,
} from "../../../src/llm/adapters/ollama-tools.js";
import { getToolDefinitions } from "../../../src/tools/definitions.js";

describe("ollama tools adapter", () => {
  it("reuses OpenAI-style tools array", () => {
    const tools = toOllamaTools(getToolDefinitions({ names: ["fs.write"] }));
    expect(tools[0]!.function.name).toBe("fs_write");
  });

  it("serializes assistant tool arguments as JSON string (P2-5)", () => {
    const msgs = toOllamaToolMessages([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "fs.write", args: { path: "a.ts", content: "x" } },
        ],
      },
    ]);
    const tc = (msgs[0]!.tool_calls as Array<{ function: { arguments: unknown } }>)[0]!;
    expect(typeof tc.function.arguments).toBe("string");
    expect(JSON.parse(tc.function.arguments as string)).toEqual({
      path: "a.ts",
      content: "x",
    });
  });

  it("parses object arguments", () => {
    const calls = parseOllamaToolCalls([
      {
        function: {
          name: "fs_write",
          arguments: { path: "a", content: "b" },
        },
      },
    ]);
    expect(calls[0]!.args).toEqual({ path: "a", content: "b" });
    expect(calls[0]!.name).toBe("fs.write");
  });

  it("parses string arguments and synthesizes id", () => {
    const calls = parseOllamaToolCalls([
      {
        function: {
          name: "fs_read",
          arguments: '{"path":"x"}',
        },
      },
    ]);
    expect(calls[0]!.id).toMatch(/^call_/);
    expect(calls[0]!.args).toEqual({ path: "x" });
  });
});
