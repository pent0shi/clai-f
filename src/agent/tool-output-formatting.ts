import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fixOwner, handlePermissionError } from "../os/permissions.js";
import { reduceToolOutput } from "../tools/policies/output-policy.js";
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
  const dir = join(homedir(), ".clai", "outputs");
  try {
    await mkdir(dir, { recursive: true });
    await fixOwner(dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `${stamp}-${safeArtifactName(call.name)}.txt`);
    await writeFile(path, `${output}\n`, "utf8");
    await fixOwner(path);
    return path;
  } catch (err: any) {
    handlePermissionError(err);
  }
}

const ERROR_LINE_RE =
  /\b(?:error|exception|failed|failure|fatal|traceback|panic|ECONNREFUSED|ENOENT|TypeError|SyntaxError|ReferenceError|Cannot find|not found|exit code)\b/i;

/**
 * Truncate long tool output for the model. When `preferErrors` is set (failed
 * commands), keep error-bearing lines and a heavy tail so stack traces survive.
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

/** One-line failure cue prepended when a tool returns ok=false. */
export function failureSummaryLine(result: {
  ok: boolean;
  exitCode?: number | undefined;
  output?: string | undefined;
}): string | undefined {
  if (result.ok) return undefined;
  const exit =
    typeof result.exitCode === "number" ? `exit=${result.exitCode}` : "failed";
  const head = (result.output ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  const snippet = head.replace(/\s+/g, " ").trim().slice(0, 120);
  return snippet
    ? `FAILURE SUMMARY: ${exit}; ${snippet}`
    : `FAILURE SUMMARY: ${exit}`;
}

// Tools whose output is the actual content the model needs verbatim (file
// bodies, listings, search hits). Running these through the security-signal
// `genericReducer` was wrong: it ranks lines by pentest keywords and drops
// the rest, so source code came back as a fragmentary head+tail — the model
// saw a "truncated" file and kept re-reading it in wasted retries. For these
// we pass the raw content through (up to a generous cap) and point the model
// at the saved artifact when it exceeds the cap.
const PASSTHROUGH_TOOLS = new Set<string>([
  "fs.read",
  "fs.list",
  "fs.search",
  "fs.edit",
  "fs.append",
  "pdf.read",
]);
/** Legacy hard ceiling; effective cap comes from reliability policy (E2). */
export const PASSTHROUGH_CAP_CHARS_LEGACY = 400_000;

/** Effective fs passthrough cap (E2 tiered policy, config/env overridable). */
export function fsPassthroughCapChars(): number {
  return getReliabilityPolicy().fsPassthroughCapChars;
}
// web.fetch/http.fetch pull in arbitrary third-party pages/API responses that
// can be hundreds of KB (e.g. a large OpenAPI spec). Unlike local files the
// model asked to read, this content is never bounded by the user's own
// project, so it must be capped like every other tool's context output —
// otherwise a single fetch can single-handedly blow the context budget and
// starve the model of room to actually respond (observed as empty/garbled
// completions on smaller-context-window models after a big fetch).
// http.fetch is evidence-dense and often batched in recon — tighter cap.
// web.fetch is for reading pages — slightly larger.
const HTTP_FETCH_CAP_CHARS = 8_000;
const WEB_FETCH_CAP_CHARS = 14_000;

export function formatToolContext(call: ToolCall, result: ToolResult): string {
  const output = result.output.trim();
  if (!output) {
    const fail = failureSummaryLine(result);
    return fail ?? "";
  }
  const preferErrors = !result.ok;
  const failLine = failureSummaryLine(result);

  if (call.name === "web.fetch" || call.name === "http.fetch") {
    const cap =
      call.name === "http.fetch" ? HTTP_FETCH_CAP_CHARS : WEB_FETCH_CAP_CHARS;
    const { text, truncated } = summarizeOutput(output, cap, {
      preferErrors,
    });
    const body = truncated
      ? `${text}${
          result.outputPath
            ? `\n\n[Response exceeds ${cap.toLocaleString()} chars; head/tail shown. Full: ${result.outputPath}]`
            : `\n\n[Response exceeds ${cap.toLocaleString()} chars; only head and tail shown.]`
        }`
      : text;
    return [failLine, body].filter(Boolean).join("\n").trim();
  }

  if (PASSTHROUGH_TOOLS.has(call.name)) {
    // E2: tiered cap (default 64k). Full content remains on disk when truncated;
    // model is instructed to continue with offset/limit or open the artifact.
    const cap = fsPassthroughCapChars();
    const { text, truncated } = summarizeOutput(output, cap, {
      preferErrors,
    });
    const body = truncated
      ? `${text}${
          result.outputPath
            ? `\n\n[File content exceeds ${cap.toLocaleString()} chars; head/tail shown. Full artifact: ${result.outputPath}. Continue with fs.read offset/limit or pattern — do not re-issue path-only hoping for more.]`
            : `\n\n[File content exceeds ${cap.toLocaleString()} chars; only head and tail shown. Re-read with offset/limit or pattern for the rest.]`
        }`
      : text;
    return [failLine, body].filter(Boolean).join("\n").trim();
  }

  let reduced: string | undefined;
  try {
    const command =
      call.name === "shell.exec" ? String(call.args.command ?? "") : call.name;
    const policy = reduceToolOutput(output, {
      toolName: call.name,
      command,
    });
    reduced = policy.summary.trim();
  } catch {
    reduced = undefined;
  }
  const base = reduced && reduced.length > 0 ? reduced : output;
  const summary = summarizeOutput(base, 8_000, { preferErrors });
  const saved = result.outputPath
    ? `\nFull output saved to: ${result.outputPath}`
    : "";
  return [failLine, `${summary.text}${saved}`].filter(Boolean).join("\n").trim();
}
