/**
 * Optional *structured* polish for known scanner outputs (nmap open ports,
 * ffuf hits, …). There is **no** generic keyword-ranker — arbitrary shell/fs
 * output is never "reduced" by guessing what looks interesting.
 *
 * Philosophy (clai):
 * - Eliminate noise at the **command** (flags, matchers, quiet modes).
 * - Long runs → durable background jobs with live artifact files; model uses
 *   shell.tail / head+tail / full file when needed.
 * - Model context gets honest head+tail + artifact path, not invented omissions.
 */

import { ffufReducer } from "../reducers/ffuf.js";
import { gobusterReducer } from "../reducers/gobuster.js";
import { httpxReducer } from "../reducers/httpx.js";
import { nmapReducer } from "../reducers/nmap.js";
import { nucleiReducer } from "../reducers/nuclei.js";
import { sqlmapReducer } from "../reducers/sqlmap.js";
import { subdomainsReducer } from "../reducers/subdomains.js";
import type { Reducer, ReducerOutput } from "../reducers/types.js";

interface PolicyContext {
  toolName: string;
  command?: string | undefined;
  argv?: string[] | undefined;
}

function commandHead(command: string): string {
  return command.trim().split(/\s+/)[0]?.replace(/^.*\//, "") ?? "";
}

/**
 * Structured reducers only for tools that emit parseable *findings*.
 * Returns null when the caller should use raw head+tail (default for all
 * other tools — including shell.exec whoami, npm, ls, …).
 */
export function pickReducer(context: PolicyContext): Reducer | null {
  if (context.toolName === "net.scan" || context.toolName === "pentest.recon") {
    return nmapReducer;
  }
  const head = context.command ? commandHead(context.command) : "";
  switch (head) {
    case "nmap":
      return nmapReducer;
    case "ffuf":
      return ffufReducer;
    case "gobuster":
    case "feroxbuster":
    case "dirb":
    case "dirsearch":
      return gobusterReducer;
    case "subfinder":
    case "amass":
    case "sublist3r":
    case "assetfinder":
      return subdomainsReducer;
    case "httpx":
    case "httprobe":
      return httpxReducer;
    case "nuclei":
      return nucleiReducer;
    case "sqlmap":
      return sqlmapReducer;
    default:
      return null;
  }
}

export function reduceToolOutput(
  raw: string,
  context: PolicyContext,
): ReducerOutput {
  const reducer = pickReducer(context);
  if (!reducer) {
    // No post-hoc keyword filtering — caller formats with head/tail.
    return { summary: raw };
  }
  return reducer(raw, {
    command: context.command ?? context.toolName,
    argv: context.argv,
  });
}

/** True when a specialized (non-identity) reducer will run. */
export function hasStructuredReducer(context: PolicyContext): boolean {
  return pickReducer(context) !== null;
}
