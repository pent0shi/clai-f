import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
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
  it("detects paths outside cwd (and outside tmpdir)", () => {
    // `/tmp/...` is NOT a valid "outside" sample on Linux CI: tmpdir() is often
    // `/tmp`, and isOutsideWorkingDirectory intentionally treats system temp as
    // inside (agent scratch must not spam confirms). Use a synthetic root path
    // that is under neither cwd nor tmpdir.
    const candidates =
      process.platform === "win32"
        ? ["C:\\Windows\\clai-outside-test-xyz", "D:\\clai-outside-test-xyz"]
        : [
            "/var/clai-outside-test-xyz",
            "/usr/local/clai-outside-test-xyz",
            "/clai-outside-test-xyz",
          ];
    const cwd = resolve(process.cwd());
    const tmp = resolve(tmpdir());
    const outsideRaw = candidates.find((p) => {
      const r = resolve(p);
      return !r.startsWith(cwd + "/") && !r.startsWith(tmp + "/") && r !== cwd && r !== tmp;
    });
    expect(outsideRaw, "need a path outside cwd and tmpdir").toBeTruthy();
    const outside = resolveFsToolPath(outsideRaw!);
    expect(isOutsideWorkingDirectory(outside)).toBe(true);
  });

  it("treats paths under cwd as inside", () => {
    const inside = resolveFsToolPath(join(process.cwd(), "package.json"));
    expect(isOutsideWorkingDirectory(inside)).toBe(false);
  });

  it("treats system temp as inside (scratch / no confirm spam)", () => {
    const underTmp = resolveFsToolPath(join(tmpdir(), "clai-scratch-probe-xyz"));
    expect(isOutsideWorkingDirectory(underTmp)).toBe(false);
  });
});
