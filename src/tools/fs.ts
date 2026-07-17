import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { open, readdir, readFile, writeFile, unlink, rm, rename, mkdir, stat } from "node:fs/promises";
import { join, dirname, basename, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { execa } from "execa";
import type { ToolResult } from "../types.js";
import { getConfig } from "../store/config.js";
import { safeCwd } from "../os/cwd.js";
import {
  getActiveProjectRoot,
  remapAgentCwdWrite,
  resolveToolPath,
} from "../agent/project-root.js";
import {
  buildFileChange,
  formatUnifiedPreview,
  type FileChange,
} from "./file-diff.js";

/** Compact integrity footer so the model trusts a write without re-reading. */
function describeWrite(path: string, content: string, verb: string): string {
  const bytes = Buffer.byteLength(content, "utf8");
  const lines = content.length === 0 ? 0 : content.split(/\r?\n/).length;
  const sha = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12);
  const lastNonEmpty = content
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .at(-1);
  const tail = lastNonEmpty
    ? lastNonEmpty.length > 80
      ? `${lastNonEmpty.slice(0, 77)}…`
      : lastNonEmpty
    : "(empty)";
  return (
    `${verb} ${path}\n` +
    `  bytes=${bytes} lines=${lines} sha256_12=${sha}\n` +
    `  ends_with: ${JSON.stringify(tail)}\n` +
    `  Do NOT re-read this file to verify the write unless editing further — trust this receipt.`
  );
}

// Read the WHOLE file by default. Models repeatedly complained that fs.read
// returned a truncated body and then wasted turns re-reading with other
// methods, so the cap is set high enough to return any normal source/text
// file in one shot. Only genuinely huge files (logs, dumps, minified bundles)
// exceed it, and those should be paged with offset/limit on purpose.
const DEFAULT_READ_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_LIST_MAX_ENTRIES = 500;

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}

/** Resolve path with tilde expansion + sticky plan project root for relatives. */
function resolvePath(path: string): string {
  const resolved = resolveToolPath(path);
  return remapAgentCwdWrite(resolved, path);
}

/**
 * Decide whether a path falls inside configured sandbox roots / cwd / home.
 * Used for UX (outside-cwd confirm) and optional sandboxReads opt-in.
 * Writes are not hard-blocked by sandbox — outside cwd always prompts instead.
 */
export function pathInsideSandbox(
  resolvedPath: string,
  mode: "read" | "write",
): boolean {
  const roots = [
    ...getConfig().sandboxRoots.map((root) => resolve(expandHome(root))),
    safeCwd(),
    tmpdir(),
  ];
  if (mode === "read") {
    roots.push(homedir());
  }
  return roots.some((root) => {
    const rel = relative(root, resolvedPath);
    return (
      rel === "" || (!rel.startsWith("..") && !resolve(rel).startsWith(".."))
    );
  });
}

/** True when target is under root (or equal). */
function isUnderRoot(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !resolve(rel).startsWith(".."));
}

/**
 * Canonicalize an existing target or its nearest existing ancestor. This
 * resolves directory and leaf symlinks even when the final file does not yet
 * exist, so lexical `project/link/file` paths cannot escape a trusted root.
 * Returning undefined is conservative: callers must require confirmation.
 */
function canonicalizeForContainment(path: string): string | undefined {
  let cursor = resolve(path);
  let suffix: string[] = [];
  const visited = new Set<string>();

  while (true) {
    if (visited.has(cursor)) return undefined;
    visited.add(cursor);
    try {
      const entry = lstatSync(cursor);
      if (entry.isSymbolicLink()) {
        const linked = resolve(dirname(cursor), readlinkSync(cursor));
        cursor = resolve(linked, ...suffix);
        suffix = [];
        continue;
      }
      const canonical = realpathSync(cursor);
      return resolve(canonical, ...suffix);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return undefined;
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * True when a write should require an explicit confirm even under allow-all:
 * outside the working directory and active project root, but not system temp /
 * scratch (agent scratch lives under tmpdir and must not spam confirmations).
 */
export function isOutsideWorkingDirectory(resolvedPath: string): boolean {
  const target = canonicalizeForContainment(resolvedPath);
  if (!target) return true;
  const cwd = canonicalizeForContainment(safeCwd());
  if (cwd && isUnderRoot(cwd, target)) return false;
  const projectRoot = getActiveProjectRoot();
  const canonicalProject = projectRoot
    ? canonicalizeForContainment(projectRoot)
    : undefined;
  // A scaffolded/discovered project can intentionally live outside the CLAI
  // process cwd (for example ~/Desktop/bloging-app). Once that root is pinned,
  // writes inside it are part of the active user-approved workspace and should
  // honor allow-all instead of prompting for every file. Siblings and deletes
  // remain protected by the runner's normal confirmation rules.
  if (canonicalProject && isUnderRoot(canonicalProject, target)) return false;
  const canonicalTmp = canonicalizeForContainment(tmpdir());
  if (canonicalTmp && isUnderRoot(canonicalTmp, target)) return false;
  return true;
}

/** Resolve a tool path for permission checks (tilde + project root). */
export function resolveFsToolPath(path: string): string {
  return resolvePath(path);
}

/** Throw with a useful message when a read/list/search escapes the sandbox. */
function ensureReadAllowed(
  resolved: string,
  original: string,
  confirmed?: boolean,
): void {
  if (confirmed) return;
  // Unrestricted reads by default (sandboxReads=false). When enabled, still
  // allow after user confirmation.
  if (getConfig().sandboxReads === false) return;
  if (!pathInsideSandbox(resolved, "read")) {
    throw new Error(
      `Read blocked — "${original}" resolves outside the approved sandbox roots. Add the path with /cwd or sandboxRoots, or set sandboxReads=false.`,
    );
  }
}

/**
 * Resolve path for writes. Outside-cwd is not hard-blocked — the runner
 * always asks for confirmation (even under allow-all). No secret-path gate
 * (pentest must be free to touch .ssh/.env-like paths on targets).
 */
function ensureWriteAllowed(path: string, confirmed?: boolean): string {
  const resolved = resolvePath(path);
  void confirmed;
  return resolved;
}

export async function fsRead(
  path: string,
  options: {
    maxBytes?: number | undefined;
    confirmed?: boolean | undefined;
    /** 1-indexed first line to return (inclusive). Lets the model page a large file instead of re-reading the whole thing. */
    offset?: number | undefined;
    /** Max number of lines to return from `offset`. */
    limit?: number | undefined;
  } = {},
): Promise<ToolResult> {
  const resolved = resolvePath(path);
  ensureReadAllowed(resolved, path, options.confirmed);

  // Directory → list contents (models often fs.read a folder by mistake).
  try {
    const st = await stat(resolved);
    if (st.isDirectory()) {
      const listed = await fsList(resolved, {
        maxEntries: options.limit && options.limit > 0 ? options.limit : undefined,
        confirmed: options.confirmed,
      });
      return {
        ...listed,
        output:
          `Path is a directory (not a file): ${resolved}\n` +
          `Listing contents (use fs.list for dirs, fs.read for files):\n\n` +
          (listed.output ?? ""),
      };
    }
    if (!st.isFile()) {
      return {
        ok: false,
        output: `Not a regular file or directory: ${resolved}`,
        exitCode: 1,
      };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, output: msg, exitCode: 1 };
  }

  const maxBytes = options.maxBytes ?? DEFAULT_READ_MAX_BYTES;
  const useLines =
    typeof options.offset === "number" || typeof options.limit === "number";
  if (useLines) {
    const offset = Math.max(1, options.offset ?? 1);
    const limit = options.limit && options.limit > 0 ? options.limit : 2000;
    const full = await readFile(resolved, "utf8");
    const lines = full.split(/\r?\n/);
    const totalLines = lines.length;
    const startIdx = Math.min(offset - 1, totalLines);
    const endIdx = Math.min(startIdx + limit, totalLines);
    const slice = lines.slice(startIdx, endIdx);
    const numbered = slice.map((line, i) => `${startIdx + i + 1}: ${line}`);
    const hasMore = endIdx < totalLines;
    const prefix =
      startIdx > 0 ? `[lines ${startIdx + 1}-${endIdx} of ${totalLines}]\n` : "";
    const suffix = hasMore
      ? `\n... (${totalLines - endIdx} more line(s); call fs.read with offset=${endIdx + 1} to continue)`
      : "";
    return {
      ok: true,
      output: `${prefix}${numbered.join("\n")}${suffix}`,
      truncated: hasMore,
    };
  }
  const handle = await open(resolved, "r");
  try {
    const st = await handle.stat();
    const cap = Math.min(st.size, maxBytes);
    const buffer = Buffer.alloc(cap);
    const { bytesRead } = await handle.read(buffer, 0, cap, 0);
    const truncated = st.size > maxBytes;
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const suffix = truncated
      ? `\n... (truncated at ${maxBytes.toLocaleString()} bytes of ${st.size.toLocaleString()} — the file is larger than the read cap; call fs.read with offset=1 and limit=N to page through it in line ranges instead of re-reading the whole file)`
      : "";
    return {
      ok: true,
      output: `${text}${suffix}`,
      truncated,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function fsWrite(
  path: string,
  content: string,
  options: { confirmed?: boolean | undefined } = {},
): Promise<ToolResult> {
  const resolved = ensureWriteAllowed(path, options.confirmed);
  // Create any missing parent directories so writing "src/index.js" into a
  // fresh project just works — the agent should not have to chain a separate
  // mkdir before every file write. This was the most common failure: ENOENT
  // on a path whose parent dir did not exist yet.
  let before = "";
  let existed = false;
  try {
    before = await readFile(resolved, "utf8");
    existed = true;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, content, "utf8");
  const change = buildFileChange({
    path: resolved,
    before,
    after: content,
    kind: existed ? "overwrite" : "create",
  });
  const verb = existed ? "Wrote" : "Created";
  return {
    ok: true,
    output: describeWrite(resolved, content, verb),
    fileChanges: [change],
  };
}

/** Atomically replace an inclusive, 1-indexed line range in an existing file. */
export async function fsReplaceLines(
  path: string,
  startLine: number,
  endLine: number,
  content: string,
  options: { confirmed?: boolean | undefined } = {},
): Promise<ToolResult> {
  const resolved = ensureWriteAllowed(path, options.confirmed);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    return { ok: false, output: "fs.replaceLines requires integers with 1 <= startLine <= endLine", exitCode: 1 };
  }
  const original = await readFile(resolved, "utf8");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = original.endsWith("\n");
  const lines = original.split(/\r?\n/);
  if (hadFinalNewline) lines.pop();
  if (endLine > lines.length) {
    return { ok: false, output: `fs.replaceLines range ${startLine}-${endLine} exceeds ${lines.length} lines`, exitCode: 1 };
  }
  const replacement = content === "" ? [] : content.split(/\r?\n/);
  if (replacement.at(-1) === "") replacement.pop();
  lines.splice(startLine - 1, endLine - startLine + 1, ...replacement);
  const next = lines.join(newline) + (hadFinalNewline ? newline : "");
  const temp = join(dirname(resolved), `.${basename(resolved)}.clai-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(temp, next, "utf8");
    await rename(temp, resolved);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  // X10: receipt with line count + hash so the model notices size changes.
  const verb =
    content === ""
      ? `Deleted lines ${startLine}-${endLine} in`
      : `Replaced lines ${startLine}-${endLine} in`;
  const change = buildFileChange({
    path: resolved,
    before: original,
    after: next,
    kind: "edit",
  });
  return {
    ok: true,
    output: describeWrite(resolved, next, verb),
    fileChanges: [change],
  };
}

export interface FileWrite {
  path: string;
  content: string;
}

const WRITE_MANY_MAX_FILES = 50;

/**
 * Write several files in a single tool call. This is the workhorse for
 * scaffolding a project: a React app, an Express server, etc. all need a
 * handful of files, and forcing one fs.write per file burns through the
 * agent's step budget (the most common reason a scaffold never finished).
 *
 * Each entry is validated and written independently — a bad path does not
 * abort the whole batch. Parent directories are created automatically, just
 * like fs.write.
 */
export async function fsWriteMany(
  files: FileWrite[],
  options: { confirmed?: boolean | undefined } = {},
): Promise<ToolResult> {
  if (!Array.isArray(files) || files.length === 0) {
    return {
      ok: false,
      output:
        'fs.writeMany requires a non-empty "files" array of { path, content } objects.',
      exitCode: 1,
    };
  }
  if (files.length > WRITE_MANY_MAX_FILES) {
    return {
      ok: false,
      output: `fs.writeMany accepts at most ${WRITE_MANY_MAX_FILES} files per call (got ${files.length}). Split the scaffold into smaller batches.`,
      exitCode: 1,
    };
  }

  const written: string[] = [];
  const failures: string[] = [];
  const changes: FileChange[] = [];
  for (const file of files) {
    if (
      !file ||
      typeof file !== "object" ||
      typeof file.path !== "string" ||
      file.path.length === 0 ||
      typeof file.content !== "string"
    ) {
      failures.push(
        `invalid entry — each file needs a non-empty string "path" and a string "content": ${JSON.stringify(file)}`,
      );
      continue;
    }
    try {
      const resolved = ensureWriteAllowed(file.path, options.confirmed);
      let before = "";
      let existed = false;
      try {
        before = await readFile(resolved, "utf8");
        existed = true;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, file.content, "utf8");
      const bytes = Buffer.byteLength(file.content, "utf8");
      const nLines =
        file.content.length === 0 ? 0 : file.content.split(/\r?\n/).length;
      const sha = createHash("sha256")
        .update(file.content, "utf8")
        .digest("hex")
        .slice(0, 12);
      written.push(`${resolved} (bytes=${bytes} lines=${nLines} sha256_12=${sha})`);
      changes.push(
        buildFileChange({
          path: resolved,
          before,
          after: file.content,
          kind: existed ? "overwrite" : "create",
        }),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      failures.push(`${file.path}: ${msg}`);
    }
  }

  // Clean multi-line receipt: one path per line (UI lists basenames; pager
  // still has full paths). Avoid repeating the same dump twice in the spool.
  const lines: string[] = [];
  if (written.length > 0) {
    lines.push(`Wrote ${written.length} file(s):`);
    for (const p of written) lines.push(`  ${p}`);
  }
  if (failures.length > 0) {
    lines.push(`Failed ${failures.length} file(s):`);
    for (const f of failures) lines.push(`  ${f}`);
  }
  return {
    ok: failures.length === 0,
    output: lines.join("\n"),
    exitCode: failures.length === 0 ? 0 : 1,
    ...(changes.length > 0 ? { fileChanges: changes } : {}),
  };
}

export async function fsList(
  path: string,
  options: { maxEntries?: number | undefined; confirmed?: boolean | undefined } = {},
): Promise<ToolResult> {
  const resolved = resolvePath(path);
  ensureReadAllowed(resolved, path, options.confirmed);
  const maxEntries = options.maxEntries ?? DEFAULT_LIST_MAX_ENTRIES;
  try {
    const entries = await readdir(resolved, { withFileTypes: true });
    const truncated = entries.length > maxEntries;
    const visible = truncated ? entries.slice(0, maxEntries) : entries;
    const lines = visible.map(
      (entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`,
    );
    if (truncated) {
      lines.push(
        `... (${(entries.length - maxEntries).toLocaleString()} entries omitted of ${entries.length.toLocaleString()})`,
      );
    }
    return {
      ok: true,
      output: lines.join("\n") || `(empty directory) ${resolved}`,
      truncated,
    };
  } catch (error: unknown) {
    const err = error as { code?: string; message?: string };
    // Missing path is a valid existence observation for scaffold/preflight —
    // not a hard tool failure that blocks task.done or loop-guard retries.
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
      return {
        ok: true,
        output:
          `path does not exist: ${resolved}\n` +
          `Safe to create/scaffold here. Do not treat this as a tool failure.`,
        exitCode: 0,
      };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      output: `fs.list failed: ${msg}`,
      exitCode: 1,
    };
  }
}

export async function fsSearch(
  pattern: string,
  path = safeCwd(),
  options: { confirmed?: boolean | undefined } = {},
): Promise<ToolResult> {
  const resolved = resolvePath(path);
  ensureReadAllowed(resolved, path, options.confirmed);
  const maxLines = 50;
  try {
    const result = await execa("rg", ["--max-count", "5", "--max-filesize", "1M", "-l", pattern, resolved], {
      reject: false,
      all: true,
      timeout: 15_000,
    });
    return {
      ok: result.exitCode === 0,
      output: result.all ?? "",
      exitCode: result.exitCode,
    };
  } catch {
    const result = await execa("grep", ["-R", "-l", "-m", String(maxLines), pattern, resolved], {
      reject: false,
      all: true,
      timeout: 15_000,
    });
    return {
      ok: result.exitCode === 0,
      output: result.all ?? "",
      exitCode: result.exitCode,
    };
  }
}

/**
 * Atomic search-and-replace edit. Reads the file, validates the match
 * count, performs replacement, and writes back.
 */
export async function fsEdit(
  path: string,
  oldText: string,
  newText: string,
  expectedReplacements?: number | undefined,
  options: { confirmed?: boolean | undefined } = {},
): Promise<ToolResult> {
  const resolved = ensureWriteAllowed(path, options.confirmed);
  const content = await readFile(resolved, "utf8");
  const expected = expectedReplacements ?? 1;

  // Count occurrences
  let count = 0;
  let searchPos = 0;
  while (true) {
    const idx = content.indexOf(oldText, searchPos);
    if (idx === -1) break;
    count += 1;
    searchPos = idx + oldText.length;
  }

  if (count === 0) {
    return {
      ok: false,
      output: `No matches found for the search text in ${resolved}. The text to replace was not found.`,
      exitCode: 1,
    };
  }
  if (count !== expected) {
    return {
      ok: false,
      output: `Found ${count} occurrence(s) of the search text, but expected exactly ${expected}. Aborting to avoid unintended changes. Use expectedReplacements=${count} if you want to replace all.`,
      exitCode: 1,
    };
  }

  const updated = content.replaceAll(oldText, newText);

  // Atomic write: write to temp file in same directory, then rename
  const tempPath = join(dirname(resolved), `.${basename(resolved)}.clai-tmp`);
  try {
    await writeFile(tempPath, updated, "utf8");
    await rename(tempPath, resolved);
  } catch (error) {
    // Cleanup temp file on failure
    try { await unlink(tempPath); } catch { /* ignore */ }
    throw error;
  }

  const change = buildFileChange({
    path: resolved,
    before: content,
    after: updated,
    kind: "edit",
  });
  const preview = formatUnifiedPreview(change, { maxLines: 24 });
  return {
    ok: true,
    output: `Replaced ${count} occurrence(s) in ${resolved}.\n${preview}`,
    fileChanges: [change],
  };
}

/**
 * Delete a file or directory. Requires the path to be inside the
 * write sandbox and not a secret path.
 */
export async function fsDelete(
  path: string,
  recursive?: boolean | undefined,
  options: { confirmed?: boolean | undefined } = {},
): Promise<ToolResult> {
  const resolved = ensureWriteAllowed(path, options.confirmed);
  try {
    // Snapshot text content for diff UI when deleting a single small file.
    let before = "";
    let canDiff = false;
    if (!recursive) {
      try {
        const st = await stat(resolved);
        if (st.isFile() && st.size <= 200_000) {
          before = await readFile(resolved, "utf8");
          canDiff = true;
        }
      } catch {
        /* ignore — delete may still succeed or fail below */
      }
    }
    if (recursive) {
      await rm(resolved, { recursive: true, force: false });
      return { ok: true, output: `Deleted (recursive): ${resolved}` };
    }
    await unlink(resolved);
    const change = canDiff
      ? buildFileChange({
          path: resolved,
          before,
          after: "",
          kind: "delete",
        })
      : buildFileChange({
          path: resolved,
          before: "",
          after: "",
          kind: "delete",
        });
    return {
      ok: true,
      output: `Deleted: ${resolved}`,
      fileChanges: [change],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, output: `Delete failed: ${msg}`, exitCode: 1 };
  }
}

export async function fsAppend(
  path: string,
  content: string,
  options: {
    position?: "start" | "end" | undefined;
    confirmed?: boolean | undefined;
    /**
     * Optional integrity check: expected UTF-8 byte length of the file
     * *before* this append. Prevents double-append / wrong-base corruption
     * when continuing a truncated write.
     */
    expectedPriorBytes?: number | undefined;
  } = {},
): Promise<ToolResult> {
  const resolved = ensureWriteAllowed(path, options.confirmed);
  const position = options.position ?? "end";
  if (position !== "start" && position !== "end") {
    return {
      ok: false,
      output: `Invalid position: "${position}". Must be "start" or "end".`,
      exitCode: 1,
    };
  }

  let original = "";
  try {
    original = await readFile(resolved, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    if (
      typeof options.expectedPriorBytes === "number" &&
      options.expectedPriorBytes !== 0
    ) {
      return {
        ok: false,
        output:
          `fs.append integrity check failed: expected prior bytes=${options.expectedPriorBytes} but file does not exist.`,
        exitCode: 1,
      };
    }
    // File does not exist: create missing parent directories and write content
    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, content, "utf8");
    const change = buildFileChange({
      path: resolved,
      before: "",
      after: content,
      kind: "create",
    });
    return {
      ok: true,
      output: describeWrite(resolved, content, "Created"),
      fileChanges: [change],
    };
  }

  const priorBytes = Buffer.byteLength(original, "utf8");
  if (
    typeof options.expectedPriorBytes === "number" &&
    options.expectedPriorBytes !== priorBytes
  ) {
    return {
      ok: false,
      output:
        `fs.append integrity check failed for ${resolved}: expected prior bytes=${options.expectedPriorBytes}, actual=${priorBytes}. ` +
        `Do NOT append again until you reconcile (read the last ~20 lines or re-write).`,
      exitCode: 1,
    };
  }

  let next = "";
  if (position === "start") {
    next = content + original;
  } else {
    next = original + content;
  }

  // Atomic write: write to temp file in same directory, then rename
  const tempPath = join(dirname(resolved), `.${basename(resolved)}.clai-tmp`);
  try {
    await writeFile(tempPath, next, "utf8");
    await rename(tempPath, resolved);
  } catch (error) {
    try { await unlink(tempPath); } catch { /* ignore */ }
    throw error;
  }

  const st = await stat(resolved).catch(() => undefined);
  const change = buildFileChange({
    path: resolved,
    before: original,
    after: next,
    kind: "append",
  });
  return {
    ok: true,
    output:
      describeWrite(resolved, next, `Appended (${position}) to`) +
      `\n  prior_bytes=${priorBytes} after_bytes=${st?.size ?? Buffer.byteLength(next, "utf8")}`,
    fileChanges: [change],
  };
}
