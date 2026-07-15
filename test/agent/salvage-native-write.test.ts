import { describe, expect, it } from "vitest";
import {
  salvageTruncatedWrite,
  salvageTruncatedWriteFromNative,
} from "../../src/agent/tool-call-parser.js";

describe("salvageTruncatedWriteFromNative", () => {
  it("salvages partial fs.write args JSON (no name wrapper)", () => {
    const lines = Array.from({ length: 80 }, (_, i) => `line ${i} content here`).join(
      "\n",
    );
    // Truncated mid-content (no closing quote).
    const raw = `{"path":"out.ts","content":${JSON.stringify(lines + "\n// more")}`;
    // Drop the final chars so it looks truncated mid-string.
    const truncated = raw.slice(0, -8);
    const salvaged = salvageTruncatedWriteFromNative("fs.write", truncated);
    expect(salvaged).toBeDefined();
    expect(salvaged!.path).toBe("out.ts");
    expect(salvaged!.content.length).toBeGreaterThan(50);
    expect(salvaged!.content).toContain("line 0 content here");
  });

  it("matches text-path salvage for wrapped name/args shape", () => {
    const body = "export const x = 1;\n".repeat(40);
    const text = `{"name":"fs.write","args":{"path":"a.ts","content":"${body.replace(/\n/g, "\\n")}`;
    const fromText = salvageTruncatedWrite(text);
    const fromNative = salvageTruncatedWriteFromNative(
      "fs.write",
      `{"path":"a.ts","content":"${body.replace(/\n/g, "\\n")}`,
    );
    expect(fromText?.path).toBe("a.ts");
    expect(fromNative?.path).toBe("a.ts");
    expect(fromNative?.content.trim().length).toBeGreaterThan(50);
  });

  it("returns undefined for non-write tools", () => {
    expect(
      salvageTruncatedWriteFromNative("fs.read", '{"path":"x"}'),
    ).toBeUndefined();
  });
});
