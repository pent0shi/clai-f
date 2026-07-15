import { describe, expect, it } from "vitest";
import {
  geminiToolBodyFields,
  parseGeminiFunctionCalls,
  toGeminiToolContents,
} from "../../../src/llm/adapters/gemini-tools.js";
import { getToolDefinitions } from "../../../src/tools/definitions.js";

describe("gemini tools adapter", () => {
  it("builds functionDeclarations payload", () => {
    const body = geminiToolBodyFields({
      tools: getToolDefinitions({ names: ["web.search"] }),
      toolChoice: "auto",
    });
    expect(body.tools).toBeDefined();
    const tools = body.tools as Array<{
      functionDeclarations: Array<{ name: string }>;
    }>;
    expect(tools[0]!.functionDeclarations[0]!.name).toBe("web_search");
  });

  it("parses functionCall parts and filters thoughts", () => {
    const parsed = parseGeminiFunctionCalls([
      { thought: true, text: "thinking..." },
      { text: "ok" },
      {
        functionCall: {
          name: "fs_write",
          args: { path: "a.ts", content: "x" },
        },
      },
    ]);
    expect(parsed.text).toBe("ok");
    expect(parsed.toolCalls[0]!.name).toBe("fs.write");
  });

  it("keeps functionCall when part is also tagged as thought", () => {
    const parsed = parseGeminiFunctionCalls([
      {
        thought: true,
        text: "reasoning",
        functionCall: {
          name: "web_search",
          args: { query: "uk pm" },
        },
      },
    ]);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]!.name).toBe("web.search");
    expect(parsed.text).toBe("");
  });

  it("history: functionResponse order for parallel calls", () => {
    const contents = toGeminiToolContents([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "1", name: "fs.read", args: { path: "a" } },
          { id: "2", name: "fs.list", args: {} },
        ],
      },
      { role: "tool", toolCallId: "1", name: "fs.read", content: "A" },
      { role: "tool", toolCallId: "2", name: "fs.list", content: "B" },
    ]);
    expect(contents[0]!.role).toBe("model");
    expect(contents[1]!.role).toBe("user");
    expect(contents[1]!.parts).toHaveLength(2);
  });
});
