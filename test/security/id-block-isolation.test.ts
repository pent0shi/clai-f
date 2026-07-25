import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseAllToolCalls as parseToolCalls } from "../../src/agent/tool-call-parser.js";

function block(id: string, name: string, args?: string): string {
  return `<tool_call:${id}>${name}\n${args ?? ""}\n</tool_call:${id}>`;
}

describe("SEC-006 id-tagged blocks never borrow another block's args", () => {
  it("does not pair a mutating tool with the next block's path", () => {
    const text = [
      block("aaa", "fs.delete"),
      block("bbb", "fs.read", '{"path":"src/index.ts"}'),
    ].join("\n");
    const calls = parseToolCalls(text);
    for (const call of calls) {
      if (call.name === "fs.delete") {
        expect(call.args.path).toBeUndefined();
      }
    }
    const read = calls.find((c) => c.name === "fs.read");
    expect(read?.args.path).toBe("src/index.ts");
  });

  it("keeps args with their own block across three blocks", () => {
    const text = [
      block("a1", "fs.read", '{"path":"one.ts"}'),
      block("a2", "fs.read", '{"path":"two.ts"}'),
      block("a3", "fs.read", '{"path":"three.ts"}'),
    ].join("\n");
    const paths = parseToolCalls(text)
      .filter((c) => c.name === "fs.read")
      .map((c) => c.args.path);
    expect(paths).toEqual(["one.ts", "two.ts", "three.ts"]);
  });

  it("drops a truncated block instead of adopting later args", () => {
    const text = `<tool_call:x1>fs.delete\n{"path":"impor\n${block(
      "x2",
      "fs.read",
      '{"path":"safe.ts"}',
    )}`;
    const calls = parseToolCalls(text);
    const del = calls.find((c) => c.name === "fs.delete");
    expect(del).toBeUndefined();
  });

  it("still parses a genuinely argument-free block", () => {
    const calls = parseToolCalls(block("z", "sysinfo"));
    expect(calls[0]?.name).toBe("sysinfo");
    expect(calls[0]?.args).toEqual({});
  });

  it("property: no parsed call takes a path from a different block", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.stringMatching(/^[a-z0-9]{3,6}$/),
            path: fc.stringMatching(/^[a-z]{3,8}\.ts$/),
            withArgs: fc.boolean(),
          }),
          { minLength: 2, maxLength: 4 },
        ),
        (specs) => {
          const uniqueSpecs = specs.filter(
            (s, i) => specs.findIndex((o) => o.path === s.path) === i,
          );
          const text = uniqueSpecs
            .map((s, i) =>
              block(
                `${s.id}${i}`,
                "fs.read",
                s.withArgs ? JSON.stringify({ path: s.path }) : undefined,
              ),
            )
            .join("\n");
          const parsed = parseToolCalls(text).filter(
            (c) => c.name === "fs.read",
          );
          const allowed = new Set(
            uniqueSpecs.filter((s) => s.withArgs).map((s) => s.path),
          );
          for (const call of parsed) {
            if (call.args.path === undefined) continue;
            expect(allowed.has(String(call.args.path))).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
