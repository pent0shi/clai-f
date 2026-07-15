import { describe, expect, it } from "vitest";
import {
  accumulateOpenAiToolCallDelta,
  finalizeOpenAiToolCalls,
} from "../../src/llm/tool-protocol.js";
import { createHash } from "node:crypto";

describe("native fs.write large arg reassembly", () => {
  it("round-trips a 50KB TypeScript body through tool_call deltas", () => {
    const content = [
      "// generated fixture\n",
      ...Array.from(
        { length: 1200 },
        (_, i) => `export const LINE_${i}_VALUE = ${i}; // pad\n`,
      ),
    ].join("");
    expect(content.length).toBeGreaterThan(20_000);

    const argsJson = JSON.stringify({ path: "big.ts", content });
    const chunkSize = 137;
    const state = new Map();
    accumulateOpenAiToolCallDelta(state, {
      index: 0,
      id: "call_big",
      function: { name: "fs_write", arguments: "" },
    });
    for (let i = 0; i < argsJson.length; i += chunkSize) {
      accumulateOpenAiToolCallDelta(state, {
        index: 0,
        function: { arguments: argsJson.slice(i, i + chunkSize) },
      });
    }
    const calls = finalizeOpenAiToolCalls(state);
    expect(calls[0]!.name).toBe("fs.write");
    expect(calls[0]!.args.path).toBe("big.ts");
    expect(calls[0]!.args.content).toBe(content);
    const hash = createHash("sha256")
      .update(String(calls[0]!.args.content))
      .digest("hex")
      .slice(0, 12);
    expect(hash).toHaveLength(12);
  });
});
