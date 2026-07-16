import { isAbsolute, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { SessionPlan } from "../store/plan.js";
import { safeCwd } from "../os/cwd.js";
import {
  isBareParentDirectory,
  isExistingProjectDir,
  resolveScaffoldTargetPath,
} from "./workspace-orient.js";

/**
 * Sticky project root for the active plan/session turn.
 * Relative fs paths and bare shell cwd resolve here so the agent never
 * rewrites the agent package while working in a user project elsewhere.
 */
let activeProjectRoot: string | undefined;

export function setActiveProjectRoot(root: string | undefined): void {
  if (!root?.trim()) {
    activeProjectRoot = undefined;
    return;
  }
  const resolved = resolve(root.trim());
  // Never pin sticky root to a bare parent (Desktop/home) — that makes
  // relative "src/…" land on Desktop/src instead of the real project.
  if (isBareParentDirectory(resolved)) {
    return;
  }
  activeProjectRoot = resolved;
}

/**
 * Pin root only when the path exists (or force=true after a successful scaffold).
 * Prevents inventing Desktop/todo-app before the folder is real.
 */
export function setActiveProjectRootIfValid(
  root: string | undefined,
  opts?: { force?: boolean },
): boolean {
  if (!root?.trim()) return false;
  const resolved = resolve(root.trim());
  if (isBareParentDirectory(resolved)) return false;
  if (!opts?.force && !existsSync(resolved)) return false;
  activeProjectRoot = resolved;
  return true;
}

export function getActiveProjectRoot(): string | undefined {
  return activeProjectRoot;
}

export function clearActiveProjectRoot(): void {
  activeProjectRoot = undefined;
}

/** Absolute POSIX/mac paths under the user tree that look like project dirs. */
const ABS_PROJECT_RE =
  /(?:^|[\s"'`=])(\/(?:Users|home)\/[^\s"'`:]+?(?:\/(?:Desktop|Documents|Projects|dev|code|src|work|repos?)\/[^\s"'`:]+|\/[^\s"'`:]*todo[^\s"'`/]*))(?=[\s"'`]|$)/gi;

/**
 * Pull the best project directory from plan text / user prompt.
 * Prefers existing paths; never returns bare Desktop alone when a deeper path exists.
 */
export function extractProjectRootFromText(
  ...parts: string[]
): string | undefined {
  const blob = parts.filter(Boolean).join("\n");
  if (!blob.trim()) return undefined;

  const candidates: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(ABS_PROJECT_RE.source, ABS_PROJECT_RE.flags);
  while ((m = re.exec(blob)) !== null) {
    const p = m[1]!.replace(/\/+$/, "");
    candidates.push(p);
  }

  // Relative "…/Desktop/todo-app" without leading path — join home
  const relDesk = blob.match(
    /(?:^|[\s"'`])(?:~\/Desktop|Desktop)\/([A-Za-z0-9._-]+)/,
  );
  if (relDesk?.[1]) {
    candidates.push(join(homedir(), "Desktop", relDesk[1]));
  }

  if (candidates.length === 0) return undefined;

  // Prefer deepest path (project folder over Desktop alone)
  candidates.sort((a, b) => b.length - a.length);

  // Prefer candidates that already exist on disk
  const existing = candidates.filter((c) => existsSync(resolve(c)));
  const pool = existing.length > 0 ? existing : candidates;

  for (const c of pool) {
    const resolved = resolve(c);
    if (isBareParentDirectory(resolved) && pool.some((x) => x.length > c.length)) {
      continue;
    }
    if (isBareParentDirectory(resolved)) continue;
    return resolved;
  }
  return undefined;
}

export function extractProjectRootFromPlan(
  plan: SessionPlan | undefined,
): string | undefined {
  if (!plan) return undefined;
  if (plan.meta?.projectRoot?.trim()) {
    return resolve(plan.meta.projectRoot.trim());
  }
  return extractProjectRootFromText(
    plan.goal,
    plan.detail,
    ...plan.tasks.map((t) => t.title),
  );
}

/**
 * After a successful one-shot scaffolder, derive the project directory.
 * Stack-agnostic: npm create, cargo new, rails new, poetry new, etc.
 */
export function extractProjectRootFromScaffold(
  command: string,
  shellCwd?: string,
): string | undefined {
  return resolveScaffoldTargetPath(command, shellCwd);
}

/**
 * Resolve a tool path: absolute stays absolute; relative uses active project
 * root when set, else process cwd.
 */
export function resolveToolPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return resolve(safeCwd(), ".");

  let expanded = trimmed;
  if (expanded === "~") expanded = homedir();
  else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = join(homedir(), expanded.slice(2));
  }

  if (isAbsolute(expanded)) {
    return resolve(expanded);
  }

  const root = getActiveProjectRoot();
  if (root) {
    return resolve(root, expanded);
  }
  return resolve(safeCwd(), expanded);
}

/**
 * If the model wrote into the agent package while a project root is set
 * elsewhere, remap onto the project (keeps relative subpath).
 * Generic: any relative path or common source roots (src, lib, app, …).
 */
export function remapAgentCwdWrite(
  resolved: string,
  original: string,
): string {
  const root = getActiveProjectRoot();
  if (!root) return resolved;
  const agent = safeCwd();
  if (root === agent) return resolved;
  // Already under project
  if (
    resolved === root ||
    resolved.startsWith(root + "/") ||
    resolved.startsWith(root + "\\")
  ) {
    return resolved;
  }
  // Relative original wrongly resolved into agent cwd
  if (
    !isAbsolute(original.trim()) &&
    (resolved.startsWith(agent + "/") || resolved.startsWith(agent + "\\"))
  ) {
    const rel = resolved.slice(agent.length).replace(/^[/\\]/, "");
    return resolve(root, rel);
  }
  // Absolute path under agent that looks like app source
  if (
    (resolved.startsWith(agent + "/") || resolved.startsWith(agent + "\\")) &&
    existsSync(root) &&
    isExistingProjectDir(root)
  ) {
    const rel = resolved.slice(agent.length).replace(/^[/\\]+/, "");
    // Common project-relative source trees (language-agnostic)
    if (
      /^(src|lib|app|apps|packages|cmd|internal|pkg|tests?|spec|public|static|assets|components|pages|routes|handlers|models|views)[/\\]/i.test(
        rel,
      ) ||
      /\.(jsx?|tsx?|vue|svelte|py|go|rs|java|kt|rb|php|swift|cs)$/i.test(rel)
    ) {
      return resolve(root, rel);
    }
  }
  return resolved;
}
