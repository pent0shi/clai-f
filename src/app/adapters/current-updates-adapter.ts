import { getCurrentVersion } from "../../commands/update.js";
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
  fetchLatest?: () => Promise<string | undefined>,
): UpdatesPort {
  return {
    async check(): Promise<UpdateStatus> {
      const currentVersion = getCurrentVersion();
      const latestVersion = fetchLatest ? await fetchLatest() : undefined;
      return {
        currentVersion,
        latestVersion,
        updateAvailable:
          latestVersion !== undefined &&
          compareSemver(currentVersion, latestVersion) < 0,
      };
    },
  };
}
