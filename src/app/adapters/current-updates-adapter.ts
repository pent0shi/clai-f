import {
  fetchLatestVersion,
  getCurrentVersion,
  updateCheckDisabledReason,
} from "../../commands/update.js";
import type { UpdatesPort, UpdateStatus } from "../ports/updates-port.js";

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => Number(n) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}


export function createCurrentUpdatesPort(
  fetchLatest: () => Promise<string | undefined> = fetchLatestVersion,
  disabledReason: () => string | undefined = updateCheckDisabledReason,
): UpdatesPort {
  return {
    async check(): Promise<UpdateStatus> {
      const currentVersion = getCurrentVersion();
      const blocked = disabledReason();
      if (blocked) {
        return {
          state: "unknown",
          currentVersion,
          updateAvailable: false,
          detail: blocked,
        };
      }
      let latestVersion: string | undefined;
      try {
        latestVersion = await fetchLatest();
      } catch (error) {
        return {
          state: "error",
          currentVersion,
          updateAvailable: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      if (!latestVersion) {
        return {
          state: "unknown",
          currentVersion,
          updateAvailable: false,
          detail: "the release feed did not return a version",
        };
      }
      const updateAvailable = compareSemver(currentVersion, latestVersion) < 0;
      return {
        state: updateAvailable ? "update-available" : "current",
        currentVersion,
        latestVersion,
        updateAvailable,
      };
    },
  };
}
