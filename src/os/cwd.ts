import { homedir } from "node:os";
import { existsSync } from "node:fs";


export function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return recoverCwd();
  }
}

/**
 * True when the real working directory is currently unreadable (deleted or
 * permission-revoked). Callers can surface a one-time warning to the user.
 */
export function cwdIsBroken(): boolean {
  try {
    process.cwd();
    return false;
  } catch {
    return true;
  }
}

let recovered = false;


export function recoverCwd(): string {
  const candidates = [
    process.env.HOME,
    process.env.USERPROFILE,
    homedir(),
    process.env.TMPDIR,
    "/tmp",
    "/",
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const dir of candidates) {
    try {
      if (!existsSync(dir)) continue;
      process.chdir(dir);
      recovered = true;
      return dir;
    } catch {
      // try the next candidate
    }
  }
  
  return homedir() || "/";
}

/** Whether recoverCwd() has relocated the process during this run. */
export function didRecoverCwd(): boolean {
  return recovered;
}
