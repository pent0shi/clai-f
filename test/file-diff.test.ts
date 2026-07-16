import { describe, expect, it } from "vitest";
import {
  buildFileChange,
  buildModalLines,
  capPreviewHunks,
  computeLineOps,
  fileToolTitle,
  formatUnifiedPreview,
  groupHunks,
  PREVIEW_CONTEXT,
  splitLines,
} from "../src/tools/file-diff.js";
import {
  formatModalPlainText,
  presentFileChangePreview,
} from "../src/tui-v2/rendering/file-diff-view.js";
import { formatToolArgs } from "../src/agent/tool-call-parser.js";

describe("splitLines", () => {
  it("handles empty, LF, and CRLF", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"]);
  });
});

describe("computeLineOps + groupHunks context=1", () => {
  it("shows one context line above and below a mid-file edit", () => {
    const before = ["keep0", "keep1", "old", "keep3", "keep4"].join("\n");
    const after = ["keep0", "keep1", "new", "keep3", "keep4"].join("\n");
    const ops = computeLineOps(splitLines(before), splitLines(after));
    const hunks = groupHunks(ops, PREVIEW_CONTEXT);
    expect(hunks).toHaveLength(1);
    const texts = hunks[0]!.lines.map((l) => `${l.op}:${l.text}`);
    expect(texts).toEqual([
      "context:keep1",
      "del:old",
      "add:new",
      "context:keep3",
    ]);
  });

  it("creates all-add hunk for new file", () => {
    const change = buildFileChange({
      path: "/tmp/App.css",
      before: "",
      after: "a\nb\n",
      kind: "create",
    });
    expect(change.kind).toBe("create");
    expect(change.stats.added).toBe(2);
    expect(change.stats.removed).toBe(0);
    expect(change.previewHunks[0]!.lines.every((l) => l.op === "add")).toBe(true);
  });

  it("creates all-del hunk for delete", () => {
    const change = buildFileChange({
      path: "/tmp/x.ts",
      before: "one\ntwo\n",
      after: "",
      kind: "delete",
    });
    expect(change.stats.removed).toBe(2);
    expect(change.previewHunks[0]!.lines.every((l) => l.op === "del")).toBe(true);
  });

  it("handles multi-hunk edits", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const after = ["a", "B", "c", "d", "e", "F", "g"].join("\n");
    const ops = computeLineOps(splitLines(before), splitLines(after));
    const hunks = groupHunks(ops, 1);
    expect(hunks.length).toBeGreaterThanOrEqual(2);
  });

  it("caps preview lines", () => {
    const oldL = Array.from({ length: 100 }, (_, i) => `line-${i}`);
    const newL = oldL.map((l, i) => (i % 3 === 0 ? `NEW-${i}` : l));
    const ops = computeLineOps(oldL, newL);
    const hunks = groupHunks(ops, 1);
    const capped = capPreviewHunks(hunks, 10);
    expect(capped.truncated).toBe(true);
    const total = capped.hunks.reduce((n, h) => n + h.lines.length, 0);
    expect(total).toBeLessThanOrEqual(10);
  });
});

describe("buildFileChange + presenters", () => {
  it("builds edit change with basename and modal lines", () => {
    const change = buildFileChange({
      path: "/Users/me/Desktop/blogging-app/src/App.css",
      before: "/* header */\n.a { color: red; }\n",
      after: "/* header */\n.a { color: blue; }\n/* footer */\n",
      kind: "edit",
    });
    expect(change.basename).toBe("App.css");
    expect(change.stats.added).toBeGreaterThan(0);
    const preview = presentFileChangePreview(change);
    expect(preview.some((r) => r.tone === "add")).toBe(true);
    expect(preview.some((r) => r.tone === "del")).toBe(true);
    expect(preview.some((r) => r.gutter.trim() !== "")).toBe(true);

    const modal = buildModalLines(change);
    expect(modal.length).toBeGreaterThan(0);
    const plain = formatModalPlainText(change);
    expect(plain).toContain("App.css");
    expect(plain).toMatch(/│/);
  });

  it("formats unified preview with +/- prefixes", () => {
    const change = buildFileChange({
      path: "/tmp/a.ts",
      before: "x\n",
      after: "y\n",
      kind: "edit",
    });
    const u = formatUnifiedPreview(change);
    expect(u).toMatch(/^-x/m);
    expect(u).toMatch(/^\+y/m);
  });
});

describe("fileToolTitle + formatToolArgs", () => {
  it("titles edit running/ok/failed with basename", () => {
    expect(
      fileToolTitle("fs.edit", "running", "/tmp/src/App.css").title,
    ).toBe("Editing App.css");
    expect(
      fileToolTitle("fs.edit", "ok", "/tmp/src/App.css", "edit").title,
    ).toBe("Edited App.css");
    expect(
      fileToolTitle("fs.edit", "failed", "/tmp/src/App.css").title,
    ).toBe("Edit failed · App.css");
  });

  it("does not JSON-dump fs.edit args", () => {
    const display = formatToolArgs({
      name: "fs.edit",
      args: {
        path: "/tmp/App.css",
        oldText: "lots of old text ".repeat(20),
        newText: "lots of new text ".repeat(20),
      },
    });
    expect(display).toBe("/tmp/App.css");
    expect(display).not.toContain("oldText");
  });

  it("path-only for replaceLines and delete", () => {
    expect(
      formatToolArgs({
        name: "fs.replaceLines",
        args: { path: "/a.ts", startLine: 1, endLine: 2, content: "x" },
      }),
    ).toBe("/a.ts");
    expect(
      formatToolArgs({ name: "fs.delete", args: { path: "/a.ts" } }),
    ).toBe("/a.ts");
  });
});
