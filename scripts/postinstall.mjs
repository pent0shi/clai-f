#!/usr/bin/env node
/**
 * Postinstall script for @pentoshi/clai.
 * Automatically checks for Bun (required by OpenTUI) and installs it into
 * ~/.clai/bin/bun across Linux, macOS, and Windows if missing.
 */
import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

function findBun() {
  const binName = process.platform === "win32" ? "bun.exe" : "bun";
  const fromEnv = process.env.BUN_INSTALL
    ? join(process.env.BUN_INSTALL, "bin", binName)
    : undefined;
  const targetDir = join(homedir(), ".clai");
  const candidates = [
    fromEnv,
    join(targetDir, "bin", binName),
    join(homedir(), ".bun", "bin", binName),
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, binName)),
  ].filter(Boolean);

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

if (!findBun() && process.env.CLAI_NO_BUN_AUTO_INSTALL !== "1") {
  const targetDir = join(homedir(), ".clai");
  const binName = process.platform === "win32" ? "bun.exe" : "bun";
  const targetBin = join(targetDir, "bin", binName);

  mkdirSync(join(targetDir, "bin"), { recursive: true });

  const env = {
    ...process.env,
    BUN_INSTALL: targetDir,
  };

  console.log("Setting up Bun runtime for OpenTUI (~/.clai/bin)...");
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

    if (existsSync(targetBin) && process.platform !== "win32") {
      try {
        chmodSync(targetBin, 0o755);
      } catch {
        // ignore
      }
    }
  } catch (err) {
    console.warn("Notice: Automatic Bun setup skipped or failed:", err?.message || err);
  }
}
