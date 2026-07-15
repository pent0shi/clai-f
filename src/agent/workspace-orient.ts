/**
 * Stack-agnostic workspace orientation for build turns.
 *
 * Weak models often skip fs.list/fs.read and plan against an imaginary empty
 * destination — then re-scaffold into a non-empty folder ("Operation cancelled")
 * or write into the agent package. This module snapshots the real cwd /
 * destination / candidate project paths so the model always sees ground truth
 * before plan.create or implement.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { safeCwd } from "../os/cwd.js";

/** Filenames that strongly suggest "this directory is already a software project". */
export const PROJECT_MARKERS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "composer.json",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "CMakeLists.txt",
  "Makefile",
  "mix.exs",
  "pubspec.yaml",
  "Package.swift",
  "deno.json",
  "deno.jsonc",
  "tsconfig.json",
  "index.html",
  "setup.py",
  "manage.py",
  "Cargo.lock",
  ".git",
] as const;

/** Parent folders that are destinations, not project roots (never pin sticky root here). */
const BARE_PARENT_DIR_RE =
  /(?:^|[/\\])(?:Desktop|Documents|Downloads|Projects|dev|code|work|repos?|tmp|temp)$/i;

export function isBareParentDirectory(path: string): boolean {
  const p = resolve(path.trim()).replace(/[/\\]+$/, "");
  if (/^\/(?:Users|home)\/[^/\\]+$/i.test(p)) return true; // ~ only
  if (p === homedir() || p === resolve(homedir())) return true;
  return BARE_PARENT_DIR_RE.test(p);
}

export function detectProjectMarkers(dir: string): string[] {
  if (!dir || !existsSync(dir)) return [];
  const found: string[] = [];
  for (const name of PROJECT_MARKERS) {
    try {
      if (existsSync(join(dir, name))) found.push(name);
    } catch {
      /* ignore */
    }
  }
  return found;
}

export function isExistingProjectDir(dir: string): boolean {
  if (!dir || !existsSync(dir)) return false;
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return detectProjectMarkers(dir).length > 0;
}

export interface DirSnapshot {
  path: string;
  exists: boolean;
  isDir: boolean;
  entryCount: number;
  /** Up to maxNames entry basenames. */
  entries: string[];
  markers: string[];
  isProject: boolean;
  emptyOrMissing: boolean;
}

export function snapshotDir(path: string, maxNames = 36): DirSnapshot {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    return {
      path: resolved,
      exists: false,
      isDir: false,
      entryCount: 0,
      entries: [],
      markers: [],
      isProject: false,
      emptyOrMissing: true,
    };
  }
  let isDir = false;
  try {
    isDir = statSync(resolved).isDirectory();
  } catch {
    return {
      path: resolved,
      exists: true,
      isDir: false,
      entryCount: 0,
      entries: [],
      markers: [],
      isProject: false,
      emptyOrMissing: false,
    };
  }
  if (!isDir) {
    return {
      path: resolved,
      exists: true,
      isDir: false,
      entryCount: 0,
      entries: [],
      markers: [],
      isProject: false,
      emptyOrMissing: false,
    };
  }
  let names: string[] = [];
  try {
    names = readdirSync(resolved);
  } catch {
    names = [];
  }
  // Ignore pure noise when judging emptiness for scaffolders
  const meaningful = names.filter((n) => n !== ".DS_Store" && n !== "Thumbs.db");
  const markers = detectProjectMarkers(resolved);
  return {
    path: resolved,
    exists: true,
    isDir: true,
    entryCount: names.length,
    entries: names.slice(0, maxNames),
    markers,
    isProject: markers.length > 0,
    emptyOrMissing: meaningful.length === 0,
  };
}

function formatSnapshot(label: string, snap: DirSnapshot): string {
  if (!snap.exists) {
    return `- ${label}: ${snap.path}\n  status: DOES NOT EXIST (safe to create as new project path)`;
  }
  if (!snap.isDir) {
    return `- ${label}: ${snap.path}\n  status: exists but is a FILE, not a directory`;
  }
  const markerLine =
    snap.markers.length > 0
      ? `project markers: ${snap.markers.join(", ")}`
      : "project markers: (none detected)";
  const entries =
    snap.entries.length > 0
      ? snap.entries.join(", ") +
        (snap.entryCount > snap.entries.length
          ? `, … (+${snap.entryCount - snap.entries.length} more)`
          : "")
      : "(empty)";
  const kind = snap.isProject
    ? "EXISTING PROJECT — do NOT re-scaffold into this directory; continue / implement inside it"
    : snap.emptyOrMissing
      ? "empty or only junk files — OK for a new scaffold into a subfolder here"
      : "non-empty directory (not a clear project root) — list carefully; scaffolders often refuse non-empty targets";
  return (
    `- ${label}: ${snap.path}\n` +
    `  status: ${kind}\n` +
    `  entries (${snap.entryCount}): ${entries}\n` +
    `  ${markerLine}`
  );
}

export interface WorkspaceOrientationInput {
  cwd?: string;
  /** User-named parent destination (e.g. Desktop). */
  destinationHint?: string;
  /** Candidate project path from plan/prompt (may not exist yet). */
  candidateProject?: string;
  /** Extra absolute paths to snapshot (e.g. Desktop/todo-app guessed from prompt). */
  extraPaths?: string[];
}

/**
 * Guess a likely project subfolder name from free text (todo-app, my-api, …).
 * Stack-agnostic: any reasonable folder token after create/scaffold/in/on.
 */
export function guessProjectFolderName(text: string): string | undefined {
  const blob = text.trim();
  if (!blob) return undefined;

  // …/Desktop/todo-app or Desktop/todo-app
  const pathish = blob.match(
    /(?:Desktop|Documents|Projects|dev|code|work)[/\\]([A-Za-z0-9._-]+)/i,
  );
  if (pathish?.[1] && !/^(directory|folder|dir)$/i.test(pathish[1])) {
    return pathish[1];
  }

  // create a <name> app / project called <name>
  const named = blob.match(
    /\b(?:project|app|service|cli|package|crate|module)\s+(?:called|named)\s+["']?([A-Za-z][A-Za-z0-9._-]{1,40})/i,
  );
  if (named?.[1]) return named[1];

  // create <name> in/on desktop — prefer hyphenated or *app* tokens
  const createName = blob.match(
    /\b(?:create|scaffold|init|bootstrap)\s+(?:a\s+|an\s+)?(?:new\s+)?([A-Za-z][A-Za-z0-9._-]{1,40})(?:\s+(?:app|project|service))?\s+(?:in|on|under|into)\b/i,
  );
  if (
    createName?.[1] &&
    !/^(a|an|the|new|simple|react|vue|next|python|rust|go|node|web|todo)$/i.test(
      createName[1],
    )
  ) {
    return createName[1];
  }

  // "todo app" / "blog app" → todo-app style
  const kindApp = blob.match(
    /\b([a-z][a-z0-9]{1,20})[\s-]+(?:app|application|project|service|cli)\b/i,
  );
  if (
    kindApp?.[1] &&
    !/^(react|vue|next|simple|new|web|full|small|demo|sample|node|python|rust)$/i.test(
      kindApp[1],
    )
  ) {
    return `${kindApp[1].toLowerCase()}-app`;
  }

  return undefined;
}

/**
 * Human + model-facing block injected into the system prompt for build turns.
 */
export function buildWorkspaceOrientation(
  input: WorkspaceOrientationInput,
): string {
  const cwd = resolve(input.cwd?.trim() || safeCwd());
  const paths = new Map<string, string>(); // path → label

  paths.set(cwd, "agent process cwd (NOT necessarily the user project)");

  if (input.destinationHint?.trim()) {
    const d = resolve(input.destinationHint.trim());
    if (!paths.has(d)) paths.set(d, "user destination (from prompt)");
  }

  if (input.candidateProject?.trim()) {
    const c = resolve(input.candidateProject.trim());
    if (!paths.has(c)) paths.set(c, "candidate project path (from plan/prompt)");
  }

  for (const extra of input.extraPaths ?? []) {
    if (!extra?.trim()) continue;
    const p = resolve(extra.trim());
    if (!paths.has(p)) paths.set(p, "related path");
  }

  // If destination is a bare parent, also check guessed subfolder names under it
  const dest = input.destinationHint?.trim()
    ? resolve(input.destinationHint.trim())
    : undefined;
  if (dest && isBareParentDirectory(dest)) {
    // Common default names models invent without checking
    for (const guess of ["todo-app", "app", "my-app", "project"]) {
      const p = join(dest, guess);
      if (!paths.has(p) && existsSync(p)) {
        paths.set(p, `existing subfolder under destination ("${guess}")`);
      }
    }
  }

  const lines = [
    "WORKSPACE STATUS (runtime pre-check — treat as EXPLORE step 1; still fs.list deeper as needed):",
    "Rules derived from this snapshot:",
    "1. Process cwd may be the agent package tree — never write user app source there unless the user asked to modify this agent.",
    "2. If a target project path ALREADY EXISTS with project markers, CONTINUE that project (edit feature files). Do NOT re-run a scaffolder into it (scaffolders cancel on non-empty dirs).",
    "3. If creating new, scaffold into a NEW empty subfolder under the destination (not into a non-empty dir).",
    "4. Prefer absolute paths under the real project root for all fs/shell work.",
    "5. plan.create detail MUST mention what exists vs what you will create, based on this status.",
    "",
  ];

  for (const [path, label] of paths) {
    lines.push(formatSnapshot(label, snapshotDir(path)));
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/**
 * Extract the directory name a scaffolder would create (stack-agnostic).
 * Returns undefined when the command is not a one-shot create into a named path.
 */
export function extractScaffoldTargetName(command: string): string | undefined {
  const cmd = command.trim();
  if (!cmd) return undefined;

  // Absolute / home path as target
  const abs = cmd.match(
    /(?:^|\s)((?:\/(?:Users|home)\/\S+|~\/\S+))(?:\s|$)/,
  );
  if (abs?.[1] && !abs[1].includes("node_modules")) {
    const base = abs[1].replace(/\/+$/, "").split(/[/\\]/).pop();
    if (base && !base.startsWith("-")) return base;
  }

  // Generic: create-* / npm create X / yarn create / cargo new / rails new / etc.
  const patterns: RegExp[] = [
    /(?:npm\s+create\s+\S+|npx\s+(?:--yes\s+)?create-[\w@./-]+|yarn\s+create\s+\S+|pnpm\s+create\s+\S+|bun\s+create\s+\S+)\s+([A-Za-z0-9._@/-]+)/i,
    /(?:npm\s+init\s+\S+)\s+([A-Za-z0-9._-]+)/i,
    /\bcargo\s+new\s+([A-Za-z0-9._-]+)/i,
    /\bgo\s+mod\s+init\s+(\S+)/i,
    /\bpoetry\s+new\s+([A-Za-z0-9._-]+)/i,
    /\bdjango-admin\s+startproject\s+([A-Za-z0-9._-]+)/i,
    /\brails\s+new\s+([A-Za-z0-9._-]+)/i,
    /\bcomposer\s+create-project\s+\S+\s+([A-Za-z0-9._-]+)/i,
    /\bmix\s+new\s+([A-Za-z0-9._-]+)/i,
    /\bflutter\s+create\s+([A-Za-z0-9._-]+)/i,
    /\bcargo\s+init\b/i, // init in place — no name
    /\bdotnet\s+new\s+\S+\s+-n\s+([A-Za-z0-9._-]+)/i,
    /\bdotnet\s+new\s+\S+\s+--name\s+([A-Za-z0-9._-]+)/i,
  ];

  for (const re of patterns) {
    const m = cmd.match(re);
    if (m?.[1] && m[1] !== "." && m[1] !== ".." && !m[1].startsWith("-")) {
      // Strip version tags from package names mistaken as target
      if (/^@/.test(m[1]) && !m[1].includes("/")) continue;
      const name = m[1].replace(/\/+$/, "").split(/[/\\]/).pop()!;
      if (name && name !== "." && !name.startsWith("-")) return name;
    }
  }

  // Trailing bare name before flags: `create-vite@latest todo-app -- --template react`
  const beforeFlags = cmd
    .replace(/\s+--\s+.*$/, "")
    .replace(/\s+--\S+=\S+/g, "")
    .replace(/\s+--\S+/g, "")
    .trim();
  const tokens = beforeFlags.split(/\s+/);
  const last = tokens[tokens.length - 1];
  if (
    last &&
    /^[A-Za-z0-9._-]+$/.test(last) &&
    !/^(latest|react|vue|svelte|vanilla|typescript|ts|js|app|yes)$/i.test(last) &&
    tokens.some((t) => /create|new|init|startproject/i.test(t))
  ) {
    return last;
  }

  return undefined;
}

/**
 * Resolve absolute path a scaffolder would write into.
 */
export function resolveScaffoldTargetPath(
  command: string,
  shellCwd?: string,
): string | undefined {
  const cmd = command.trim();
  if (!cmd) return undefined;

  // Honour leading `cd /path && …` / `mkdir -p /path && cd /path && …`
  // so preflight sees the real target when models chain shell in one call.
  let base = resolve(shellCwd?.trim() || safeCwd());
  const cdMatch = cmd.match(
    /(?:^|[;&|]\s*)cd\s+([^\s;&|]+)\s*(?:&&|;)/i,
  );
  if (cdMatch?.[1]) {
    const cdTarget = cdMatch[1].replace(/^~(?=\/)/, homedir());
    base = isAbsolute(cdTarget) ? resolve(cdTarget) : resolve(base, cdTarget);
  }
  // `mkdir -p /abs/path && … create .` without explicit cd
  const mkdirMatch = cmd.match(
    /mkdir\s+(?:-p\s+)?([^\s;&|]+)\s*(?:&&|;)/i,
  );
  if (mkdirMatch?.[1] && !cdMatch) {
    const m = mkdirMatch[1].replace(/^~(?=\/)/, homedir());
    if (isAbsolute(m) || m.startsWith("~/")) {
      base = resolve(m.replace(/^~(?=\/)/, homedir()));
    }
  }

  // In-place initializers (no new subfolder)
  if (
    /\bgo\s+mod\s+init\b/i.test(cmd) ||
    /\bcargo\s+init\b/i.test(cmd) ||
    /\bnpm\s+init\s+-y\b/i.test(cmd) ||
    /\bnpm\s+init\s+--yes\b/i.test(cmd)
  ) {
    return base;
  }

  const createAbs = cmd.match(
    /(?:create-[\w@./-]+|vite@\S+|cargo\s+new|rails\s+new|poetry\s+new)\s+(\/(?:Users|home)\/[^\s]+|~\/[^\s]+)/i,
  );
  if (createAbs?.[1]) {
    return resolve(createAbs[1].replace(/^~(?=\/)/, homedir()));
  }

  // `create-vite .` / `npm init vite@latest .` → current (post-cd) base
  if (
    /(?:create-\S+|vite@\S+|init\s+\S+)\s+\.(?:\s|$)/i.test(cmd) ||
    /\s\.(?:\s+--|\s*$)/.test(cmd)
  ) {
    return base;
  }

  const name = extractScaffoldTargetName(cmd);
  if (!name) return undefined;
  // go.mod style module paths are not directory names
  if (name.includes("/") || name.includes("@")) {
    return base;
  }
  if (isAbsolute(name) || name.startsWith("~/")) {
    return resolve(name.replace(/^~(?=\/)/, homedir()));
  }
  if (base.endsWith(name) || base.endsWith("/" + name) || base.endsWith("\\" + name)) {
    return base;
  }
  return resolve(base, name);
}

/** Scaffold cancelled / refused without creating a usable tree. */
export function isScaffoldCancelledOutput(output: string): boolean {
  const o = output.toLowerCase();
  return (
    /\boperation cancelled\b/.test(o) ||
    /\bcanceled\b/.test(o) ||
    /\buser aborted\b/.test(o) ||
    /\balready exists\b/.test(o) ||
    /\bdirectory is not empty\b/.test(o) ||
    /\bnon-empty\b/.test(o) ||
    /\brefusing to\b/.test(o) ||
    /\bcould not create\b/.test(o)
  );
}

/**
 * True when the target path looks like a materialized project after scaffold.
 */
export function scaffoldLooksMaterialized(targetPath: string | undefined): boolean {
  if (!targetPath || !existsSync(targetPath)) return false;
  const snap = snapshotDir(targetPath);
  if (!snap.isDir) return false;
  // At least one marker OR several source-ish entries
  if (snap.isProject) return true;
  if (snap.entryCount >= 3 && !snap.emptyOrMissing) return true;
  return false;
}

/**
 * Soft preflight: block scaffold into an existing non-empty project path.
 * Returns an error message for the model, or undefined if OK to proceed.
 */
export function scaffoldTargetConflictMessage(
  command: string,
  shellCwd?: string,
): string | undefined {
  const target = resolveScaffoldTargetPath(command, shellCwd);
  if (!target) return undefined;
  const snap = snapshotDir(target);
  if (!snap.exists || snap.emptyOrMissing) return undefined;
  // Existing non-empty (or project) — refuse re-scaffold
  if (snap.isProject || snap.entryCount > 0) {
    return (
      `Scaffold blocked: target already exists at ${target} ` +
      `(${snap.entryCount} entries` +
      (snap.markers.length ? `; markers: ${snap.markers.join(", ")}` : "") +
      `). Scaffolders refuse non-empty directories and print "Operation cancelled". ` +
      `Choose one: (A) CONTINUE the existing project — set work there with absolute paths, implement the requested feature, do NOT re-scaffold; ` +
      `(B) use a NEW empty subfolder name; or (C) only if the user asked to recreate from scratch, remove the directory first then scaffold. ` +
      `fs.list the target before deciding.`
    );
  }
  return undefined;
}
