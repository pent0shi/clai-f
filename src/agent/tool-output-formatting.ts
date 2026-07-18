/**
 * Format tool results for the model context (not the UI spool).
 *
 * Philosophy:
 * - Full bodies stay on disk (artifact / job logs). Never invent "empty".
 * - Default: honest head+tail size cap — no keyword-rank "generic reduce".
 * - Optional structured polish only for known scanners (nmap/ffuf/…) that
 *   extract findings; noise should already be filtered at the command.
 * - Long work → background job + live file; point at path, use shell.tail.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixOwner } from "../os/permissions.js";
import { getArtifactDir } from "../store/paths.js";
import {
  hasStructuredReducer,
  reduceToolOutput,
} from "../tools/policies/output-policy.js";
import type { ToolCall, ToolResult } from "../types.js";
import { getReliabilityPolicy } from "./reliability-policy.js";

function safeArtifactName(name: string): string {
  return (
    name.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") ||
    "tool-output"
  );
}

export async function saveToolOutput(
  call: ToolCall,
  output: string,
): Promise<string | undefined> {
  if (!output.trim()) return undefined;
  const dir = getArtifactDir();
  try {
    await mkdir(dir, { recursive: true });
    await fixOwner(dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `${stamp}-${safeArtifactName(call.name)}.txt`);
    await writeFile(path, `${output}\n`, "utf8");
    await fixOwner(path);
    return path;
  } catch {
    return undefined;
  }
}

const ERROR_LINE_RE =
  /\b(?:error|exception|failed|failure|fatal|traceback|panic|ECONNREFUSED|ENOENT|TypeError|SyntaxError|ReferenceError|Cannot find|not found|exit code)\b/i;

/**
 * Truncate long tool output for the model. When `preferErrors` is set (failed
 * commands), keep error-bearing lines and a heavy tail so stack traces survive.
 * Never ranks by CVE/port keywords (that was genericReducer — removed).
 */
export function summarizeOutput(
  output: string,
  maxChars = 8_000,
  opts?: { preferErrors?: boolean },
): { text: string; truncated: boolean } {
  if (output.length <= maxChars) return { text: output, truncated: false };

  const lines = output.split(/\r?\n/);

  if (opts?.preferErrors) {
    const errorLines = lines.filter((l) => ERROR_LINE_RE.test(l));
    const tailBudget = Math.floor(maxChars * 0.55);
    const errBudget = maxChars - tailBudget - 80;
    const errBlock: string[] = [];
    let used = 0;
    for (const line of errorLines.slice(-80)) {
      const cost = line.length + 1;
      if (used + cost > errBudget) break;
      errBlock.push(line);
      used += cost;
    }
    const tail: string[] = [];
    used = 0;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!;
      const cost = line.length + 1;
      if (used + cost > tailBudget) break;
      tail.unshift(line);
      used += cost;
    }
    const body = [
      ...(errBlock.length
        ? ["[error-relevant lines]", ...errBlock, ""]
        : []),
      `... (${lines.length.toLocaleString()} lines truncated; tail kept) ...`,
      ...tail,
    ].join("\n");
    return { text: body.slice(0, maxChars + 200), truncated: true };
  }

  const head: string[] = [];
  const tail: string[] = [];
  let used = 0;
  const half = Math.floor(maxChars / 2);

  for (const line of lines) {
    const cost = line.length + 1;
    if (used + cost > half) break;
    head.push(line);
    used += cost;
  }

  used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const cost = line.length + 1;
    if (used + cost > half) break;
    tail.unshift(line);
    used += cost;
  }

  return {
    text: [
      ...head,
      `... (${lines.length.toLocaleString()} output lines truncated) ...`,
      ...tail,
    ].join("\n"),
    truncated: true,
  };
}

/** Prefer real error lines over banner/echo headers when summarizing failures. */
function failureSnippetFromOutput(output: string | undefined): string {
  const lines = (output ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (lines.length === 0) return "";

  const errorLike =
    /command not found|not found|No such file|permission denied|EACCES|ENOENT|error:|fatal:|Traceback|Exception|FAILED|exit code|cannot|can't |couldn't |denied|refused|timed out|timeout|killed|segmentation fault|usage:/i;
  // Scan from the end — probe chains (`a && b && c`) print success noise first
  // and the actual failure last (e.g. `yarn: command not found`).
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (errorLike.test(line)) return line.slice(0, 120);
  }
  // No explicit error pattern: last non-empty line is usually the failing step.
  return lines[lines.length - 1]!.slice(0, 120);
}

/** One-line failure cue prepended when a tool returns ok=false. */
export function failureSummaryLine(result: {
  ok: boolean;
  exitCode?: number | undefined;
  output?: string | undefined;
}): string | undefined {
  if (result.ok) return undefined;
  const exit =
    typeof result.exitCode === "number" ? `exit=${result.exitCode}` : "failed";
  // Exit 127 is almost always "command not found" in POSIX shells.
  const hint =
    result.exitCode === 127
      ? "command not found"
      : result.exitCode === 126
        ? "not executable"
        : undefined;
  const snippet = failureSnippetFromOutput(result.output);
  const parts = [exit, hint, snippet && snippet !== hint ? snippet : undefined].filter(
    Boolean,
  );
  return `FAILURE SUMMARY: ${parts.join("; ")}`;
}

/** Legacy hard ceiling; effective cap comes from reliability policy (E2). */
export const PASSTHROUGH_CAP_CHARS_LEGACY = 400_000;

/** Effective default model-context cap for tool bodies (E2). */
export function fsPassthroughCapChars(): number {
  return getReliabilityPolicy().fsPassthroughCapChars;
}

const HTTP_FETCH_CAP_CHARS = 8_000;
const WEB_FETCH_CAP_CHARS = 14_000;
const WEB_SEARCH_CAP_CHARS = 24_000;
/** Default for shell and other tools after optional structured polish. */
const DEFAULT_CONTEXT_CAP_CHARS = 12_000;

function artifactFooter(
  path: string | undefined,
  truncated: boolean,
  cap: number,
  kind: string,
): string {
  if (!truncated) {
    return path ? `\nFull output saved to: ${path}` : "";
  }
  if (path) {
    return (
      `\n\n[${kind} exceeds ${cap.toLocaleString()} chars; head/tail shown. ` +
      `Full artifact: ${path}. ` +
      `Use shell.tail / fs.read on the path if you need more — do not re-run the same tool solely because this view is capped.]`
    );
  }
  return `\n\n[${kind} exceeds ${cap.toLocaleString()} chars; head/tail shown. Full body was not persisted.]`;
}

export function formatToolContext(call: ToolCall, result: ToolResult): string {
  const output = result.output.trim();
  if (!output) {
    const fail = failureSummaryLine(result);
    return (
      fail ??
      (result.ok
        ? "(no output — command succeeded with an empty body)"
        : "(no output — command failed with an empty body)")
    );
  }
  const preferErrors = !result.ok;
  const failLine = failureSummaryLine(result);

  if (call.name === "web.search") {
    const { text, truncated } = summarizeOutput(output, WEB_SEARCH_CAP_CHARS, {
      preferErrors,
    });
    const body =
      text +
      artifactFooter(
        result.outputPath,
        truncated,
        WEB_SEARCH_CAP_CHARS,
        "Listing",
      );
    return [failLine, body].filter(Boolean).join("\n").trim();
  }

  if (call.name === "web.fetch" || call.name === "http.fetch") {
    const cap =
      call.name === "http.fetch" ? HTTP_FETCH_CAP_CHARS : WEB_FETCH_CAP_CHARS;
    const { text, truncated } = summarizeOutput(output, cap, { preferErrors });
    const body =
      text + artifactFooter(result.outputPath, truncated, cap, "Response");
    return [failLine, body].filter(Boolean).join("\n").trim();
  }

  // Large file / listing tools: generous passthrough cap.
  if (
    call.name === "fs.read" ||
    call.name === "fs.list" ||
    call.name === "fs.search" ||
    call.name === "fs.edit" ||
    call.name === "fs.append" ||
    call.name === "pdf.read"
  ) {
    const cap = fsPassthroughCapChars();
    const { text, truncated } = summarizeOutput(output, cap, { preferErrors });
    const body =
      text +
      (truncated
        ? result.outputPath
          ? `\n\n[File content exceeds ${cap.toLocaleString()} chars; head/tail shown. Full artifact: ${result.outputPath}. Continue with fs.read offset/limit or pattern — do not re-issue path-only hoping for more.]`
          : `\n\n[File content exceeds ${cap.toLocaleString()} chars; only head and tail shown. Re-read with offset/limit or pattern for the rest.]`
        : "");
    return [failLine, body].filter(Boolean).join("\n").trim();
  }

  // Optional structured polish (nmap/ffuf/…) — never keyword-rank arbitrary shell.
  const command =
    call.name === "shell.exec" || call.name === "shell.start"
      ? String(call.args.command ?? "")
      : call.name;
  let bodySource = output;
  if (
    hasStructuredReducer({
      toolName: call.name,
      command,
    })
  ) {
    try {
      const polished = reduceToolOutput(output, {
        toolName: call.name,
        command,
      }).summary.trim();
      if (polished.length > 0) bodySource = polished;
    } catch {
      // keep raw
    }
  }

  const { text, truncated } = summarizeOutput(
    bodySource,
    DEFAULT_CONTEXT_CAP_CHARS,
    { preferErrors },
  );
  const body =
    text +
    artifactFooter(
      result.outputPath,
      truncated || bodySource !== output,
      DEFAULT_CONTEXT_CAP_CHARS,
      "Output",
    );
  // If we polished scanners, still remind that full log may be longer.
  const polishNote =
    bodySource !== output && result.outputPath
      ? `\n(Structured hit summary above; complete log: ${result.outputPath})`
      : bodySource !== output
        ? "\n(Structured hit summary above; filter more at the command next time to shrink the raw log.)"
        : "";
  return [failLine, body + polishNote].filter(Boolean).join("\n").trim();
}
