/**
 * OpenTUI requires Bun's native FFI. Node/tsx cannot initialize the renderer.
 * Prefer re-exec under Bun when available; otherwise fall back with a clear hint.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/** Resolve `bun` on PATH (cross-platform). */
export function findBunExecutable(): string | undefined {
  const fromEnv = process.env.BUN_INSTALL
    ? join(
        process.env.BUN_INSTALL,
        "bin",
        process.platform === "win32" ? "bun.exe" : "bun",
      )
    : undefined;
  const candidates = [
    fromEnv,
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((dir) =>
        join(dir, process.platform === "win32" ? "bun.exe" : "bun"),
      ),
  ].filter((p): p is string => Boolean(p));

  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // try next
    }
  }
  return undefined;
}

export function openTuiRuntimeHint(): string {
  return [
    "OpenTUI needs the Bun runtime (Node/tsx cannot load the native renderer).",
    "  • Dev:     npm run dev:bun   or   bun run src/index.ts",
    "  • Install: https://bun.sh",
    "  • Or:      clai --classic   (line REPL without OpenTUI)",
  ].join("\n");
}

/**
 * If we are not already under Bun, re-launch this process with Bun using the
 * given entry module (usually `import.meta.url` of index.ts) + original CLI
 * args, then exit with the child status. Returns false when re-exec is not
 * possible (caller should fall back / print the hint).
 *
 * Pass `entryPath` explicitly — under `tsx`/`npx`, `process.argv[1]` is the
 * loader, not clai's entry.
 */
export function reexecWithBunIfNeeded(entryPath: string): boolean {
  if (isBunRuntime()) return false;
  if (process.env.CLAI_NO_BUN_REEXEC === "1") return false;
  if (process.env.CLAI_FORCE_NODE === "1") return false;

  const bun = findBunExecutable();
  if (!bun) return false;
  if (!entryPath) return false;

  // Keep user flags (after the entry). Drop node/tsx/bun loader path noise.
  // process.argv: [node, loader?, entry?, ...flags] — simplest reliable form
  // is to re-run only the entry + flags that look like CLI options/args.
  const userArgs = process.argv.slice(2).filter((a) => {
    // Drop accidental duplicate of the entry path if present.
    if (a === entryPath) return false;
    if (a.endsWith("src/index.ts") || a.endsWith("dist/index.js")) return false;
    return true;
  });

  const result = spawnSync(bun, [entryPath, ...userArgs], {
    stdio: "inherit",
    env: {
      ...process.env,
      CLAI_NO_BUN_REEXEC: "1",
      CLAI_BUN_REEXEC: "1",
    },
    windowsHide: true,
  });

  if (result.error) return false;
  process.exit(result.status ?? 1);
  return true;
}

export function isOpenTuiFfiError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /OpenTUI native FFI|native FFI is not available|Bun-only|@opentui\/core|Failed to initialize OpenTUI/i.test(
    msg,
  );
}
