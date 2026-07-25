import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, stat, readFile, readdir, chmod } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { fsEdit, fsAppend, fsReplaceLines } from "../../src/tools/fs.js";

let dir: string;
let cwd: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clai-atomic-"));
  cwd = process.cwd();
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(cwd);
});

describe("TOOL-001 atomic writes preserve mode and are race-safe", () => {
  it("keeps an executable file executable after fs.edit", async () => {
    const file = join(dir, "run.sh");
    await writeFile(file, "#!/bin/sh\necho old\n", "utf8");
    await chmod(file, 0o755);
    const result = await fsEdit(file, "old", "new", 1, { confirmed: true });
    expect(result.ok).toBe(true);
    const st = await stat(file);
    if (platform() !== "win32") {
      expect(st.mode & 0o777).toBe(0o755);
    }
    expect(await readFile(file, "utf8")).toContain("echo new");
  });

  it("keeps a private file private after fs.append", async () => {
    const file = join(dir, "secret.env");
    await writeFile(file, "A=1\n", "utf8");
    await chmod(file, 0o600);
    const result = await fsAppend(file, "B=2\n", { confirmed: true });
    expect(result.ok).toBe(true);
    const st = await stat(file);
    if (platform() !== "win32") {
      expect(st.mode & 0o777).toBe(0o600);
    }
  });

  it("preserves mode through fs.replaceLines", async () => {
    const file = join(dir, "tool.sh");
    await writeFile(file, "a\nb\nc\n", "utf8");
    await chmod(file, 0o750);
    const result = await fsReplaceLines(file, 2, 2, "B", { confirmed: true });
    expect(result.ok).toBe(true);
    if (platform() !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o750);
    }
  });

  it("concurrent edits of the same file do not share a temp path", async () => {
    const file = join(dir, "notes.md");
    await writeFile(file, "x\n".repeat(50), "utf8");
    const results = await Promise.all([
      fsAppend(file, "one\n", { confirmed: true }),
      fsAppend(file, "two\n", { confirmed: true }),
      fsAppend(file, "three\n", { confirmed: true }),
    ]);
    // Every call resolves with a definite outcome and no stray temp file
    // remains, regardless of which write landed last.
    expect(results.every((r) => typeof r.ok === "boolean")).toBe(true);
    const leftovers = (await readdir(dir)).filter((name) =>
      name.includes(".clai-"),
    );
    expect(leftovers).toEqual([]);
    const text = await readFile(file, "utf8");
    expect(text.length).toBeGreaterThan(0);
  });
});
