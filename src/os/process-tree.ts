import { execFile, spawn } from "node:child_process";

export type TreeSignalOutcome = "sent" | "gone" | "failed";

/** POSIX detaches into its own group; Windows needs an explicit tree kill. */
export function supportsProcessGroups(): boolean {
  return process.platform !== "win32";
}

export function processAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves the process exists but is not signalable by this user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function windowsTaskkill(pid: number, force: boolean): TreeSignalOutcome {
  try {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    const child = spawn("taskkill", args, {
      stdio: "ignore",
      windowsHide: true,
      detached: false,
    });
    child.on("error", () => undefined);
    child.unref();
    return "sent";
  } catch {
    return processAlive(pid) ? "failed" : "gone";
  }
}

/**
 * Terminate a process and its descendants. POSIX signals the process group when
 * one is known; Windows uses `taskkill /T` because signalling the shell pid
 * leaves the real workload (servers, scanners) holding ports and CPU.
 */
export function terminateProcessTree(
  pid: number,
  options: { signal: NodeJS.Signals; processGroupId?: number | undefined },
): TreeSignalOutcome {
  if (!processAlive(pid) && !options.processGroupId) return "gone";
  if (process.platform === "win32") {
    return windowsTaskkill(pid, options.signal === "SIGKILL");
  }
  try {
    if (options.processGroupId) process.kill(-options.processGroupId, options.signal);
    else process.kill(pid, options.signal);
    return "sent";
  } catch {
    return processAlive(pid) ? "failed" : "gone";
  }
}

/** Best-effort synchronous-looking descendant check used by tests/diagnostics. */
export async function hasLiveDescendants(pid: number): Promise<boolean> {
  if (process.platform === "win32") {
    return await new Promise((resolve) => {
      execFile(
        "wmic",
        ["process", "where", `ParentProcessId=${pid}`, "get", "ProcessId"],
        { windowsHide: true, timeout: 4_000 },
        (error, stdout) => {
          if (error) return resolve(false);
          resolve(/\d/.test(stdout.replace(/ProcessId/g, "")));
        },
      );
    });
  }
  return await new Promise((resolve) => {
    execFile(
      "ps",
      ["-o", "pid=", "--ppid", String(pid)],
      { timeout: 4_000 },
      (error, stdout) => {
        if (error) return resolve(false);
        resolve(stdout.trim().length > 0);
      },
    );
  });
}
