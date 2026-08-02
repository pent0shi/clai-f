/**
 * OpenTUI requires Bun's native FFI. Node/tsx cannot initialize the renderer.
 * Prefer re-exec under Bun when available; otherwise fall back with a clear hint.
 */

import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import { homedir } from "node:os";

export function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/** Resolve `bun` on PATH or local clai/bun bin dirs (cross-platform). */
export function findBunExecutable(): string | undefined {
  const binName = process.platform === "win32" ? "bun.exe" : "bun";
  const fromEnv = process.env.BUN_INSTALL
    ? join(process.env.BUN_INSTALL, "bin", binName)
    : undefined;
  const claiBin = join(homedir(), ".clai", "bin", binName);
  const bunHomeBin = join(homedir(), ".bun", "bin", binName);

  const candidates = [
    fromEnv,
    claiBin,
    bunHomeBin,
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, binName)),
  ].filter((p): p is string => Boolean(p));

  const checkMode = process.platform === "win32" ? constants.F_OK : constants.X_OK;

  for (const path of candidates) {
    try {
      accessSync(path, checkMode);
      return path;
    } catch {
      // try next
    }
  }
  return undefined;
}

/** Automatically install Bun into ~/.clai/bin if missing (cross-platform). */
export function autoInstallBun(): string | undefined {
  if (process.env.CLAI_NO_BUN_AUTO_INSTALL === "1") return undefined;
  const targetDir = join(homedir(), ".clai");
  const binName = process.platform === "win32" ? "bun.exe" : "bun";
  const targetBin = join(targetDir, "bin", binName);

  const env = {
    ...process.env,
    BUN_INSTALL: targetDir,
  };

  console.log("  [clai] Setting up Bun runtime for OpenTUI (~/.clai/bin)...");
  try {
    if (process.platform === "win32") {
      spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm https://bun.sh/install.ps1 | iex",
        ],
        { env, stdio: "inherit", windowsHide: true },
      );
    } else {
      const res = spawnSync(
        "sh",
        ["-c", "curl -fsSL https://bun.sh/install | bash"],
        { env, stdio: "inherit" },
      );

      if (res.status !== 0) {
        spawnSync(
          "sh",
          ["-c", "wget -qO- https://bun.sh/install | bash"],
          { env, stdio: "inherit" },
        );
      }
    }

    if (existsSync(targetBin)) {
      if (process.platform !== "win32") {
        try {
          chmodSync(targetBin, 0o755);
        } catch {
          // ignore
        }
      }
      return targetBin;
    }
  } catch {
    // try fallback check below
  }

  return findBunExecutable();
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

  let bun = findBunExecutable();
  if (!bun && process.stdout.isTTY) {
    bun = autoInstallBun();
  }
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
