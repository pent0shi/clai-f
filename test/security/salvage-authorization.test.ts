import { describe, expect, it } from "vitest";
import {
  salvageTruncatedWrite,
  salvageTruncatedWriteFromNative,
} from "../../src/agent/tool-call-parser.js";

const BIG = Array.from({ length: 12 }, (_, i) => `line ${i} of content`).join(
  "\\n",
);

describe("SEC-002 salvage reports provenance and refuses ambiguity", () => {
  it("preserves append as append, not a full overwrite", () => {
    const text = `{"name":"fs.append","args":{"path":"notes.md","expectedPriorBytes":4096,"content":"${BIG}`;
    const salvaged = salvageTruncatedWrite(text);
    expect(salvaged?.operation).toBe("append");
    expect(salvaged?.path).toBe("notes.md");
    expect(salvaged?.expectedPriorBytes).toBe(4096);
  });

  it("reports write provenance for a truncated fs.write", () => {
    const text = `{"name":"fs.write","args":{"path":"src/a.ts","content":"${BIG}`;
    const salvaged = salvageTruncatedWrite(text);
    expect(salvaged?.operation).toBe("write");
    expect(salvaged?.expectedPriorBytes).toBeUndefined();
  });

  it("refuses to salvage an ambiguous fs.writeMany payload", () => {
    const text = `{"name":"fs.writeMany","args":{"files":[{"path":"a.ts","content":"${BIG}`;
    expect(salvageTruncatedWrite(text)).toBeUndefined();
    expect(
      salvageTruncatedWriteFromNative(
        "fs.writeMany",
        `{"files":[{"path":"a.ts","content":"${BIG}`,
      ),
    ).toBeUndefined();
  });

  it("keeps native append salvage in append mode", () => {
    const salvaged = salvageTruncatedWriteFromNative(
      "fs.append",
      `{"path":"log.txt","expectedPriorBytes":10,"content":"${BIG}`,
    );
    expect(salvaged?.operation).toBe("append");
    expect(salvaged?.expectedPriorBytes).toBe(10);
  });
});
