import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  fsRead,
  isOutsideWorkingDirectory,
  resolveFsToolPath,
} from "../src/tools/fs.js";

describe("fs.read on directories", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const t of temps) {
      try {
        rmSync(t, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    temps.length = 0;
  });

  it("lists directory contents instead of Not a regular file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-fs-dir-"));
    temps.push(dir);
    writeFileSync(join(dir, "a.ts"), "export {}");
    mkdirSync(join(dir, "nested"));

    const result = await fsRead(dir, { confirmed: true });
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/Path is a directory/i);
    expect(result.output).toMatch(/a\.ts/);
    expect(result.output).toMatch(/nested/);
    expect(result.output).not.toMatch(/Not a regular file/);
  });
});

describe("isOutsideWorkingDirectory", () => {
  it("detects paths outside cwd", () => {
    const outside = resolveFsToolPath("/tmp/clai-outside-test-xyz");
    expect(isOutsideWorkingDirectory(outside)).toBe(true);
  });

  it("treats paths under cwd as inside", () => {
    const inside = resolveFsToolPath(join(process.cwd(), "package.json"));
    expect(isOutsideWorkingDirectory(inside)).toBe(false);
  });
});
