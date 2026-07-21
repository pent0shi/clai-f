/**
 * Prompts and helpers for LLM-based context compaction.
 * The model produces structured continuation memory — not a raw transcript dump.
 */

export const COMPACTION_SYSTEM_PROMPT = `You are a session-memory compressor for an autonomous coding and security agent.

Write a dense, accurate CONTINUATION MEMORY for another assistant that will resume this work with no other history.

You are SUMMARIZING a past session, NOT continuing it. Do not answer the user, do not perform the next task, and do not role-play the agent. Never emit tool calls or invent tool results, file-write receipts (bytes/lines/sha256), exit codes, or "TOOL:" / "[tools: …]" transcript lines — describe what already happened in your own words.

Rules:
- Fidelity over style. Never invent tool results, file contents, findings, URLs, ports, or completions.
- Prefer concrete artifacts: absolute paths, commands (short form), exit outcomes, HTTP status, plan task ids/states, job ids, open ports, confirmed vs unconfirmed findings.
- LENGTH: aim for ~800–1500 tokens of dense bullets — complete short memory beats a long dump that cuts mid-sentence. No full tool transcripts or HTML bodies.
- NO DUPLICATION: state each fact exactly once, in its best section. This memory is prepended to a live context that ALSO re-injects fresh ACTIVE PLAN, SESSION STATE, and ENGAGEMENT SCOPE — do not restate the full plan or every task, and do not reproduce long user prompts verbatim; capture goals/deltas concisely.
- Omit secrets, API keys, passwords, tokens, and full credential material. Say "[redacted]" if present.
- Omit progress bars, repeated failures, and decorative chatter.
- Do not wrap the whole answer in markdown code fences.
- If something is unknown, omit it rather than guessing.
- PHASE AWARENESS: Temporary UI/mode gates (plan-mode gather-only, "await accept", "do not implement yet") are HISTORICAL context — never rewrite them as permanent forever-rules for the resuming agent. Durable user/engagement policy (scope, non-destructive default, stay on remote target when that is the engagement) may still apply.`;

export interface CompactionPromptParts {
  visualTranscript?: string | undefined;
  messageTranscript: string;
  /** Optional live plan / session state to prioritize. */
  durableState?: string | undefined;
  /**
   * When "plan-implement", bias the summarizer toward recon evidence and
   * remaining work so agent mode can execute the accepted plan.
   */
  purpose?: "default" | "plan-implement" | undefined;
}

/** User message fed to the summarizer model. */
export function buildCompactionUserPrompt(parts: CompactionPromptParts): string {
  const visual = parts.visualTranscript?.trim() ?? "";
  const fromMessages = parts.messageTranscript.trim();
  const durable = parts.durableState?.trim() ?? "";
  const planImplement = parts.purpose === "plan-implement";

  let transcript = "";
  if (visual && fromMessages) {
    transcript = `${visual}\n\n---\n\nOLDER MODEL TURNS:\n\n${fromMessages}`;
  } else {
    transcript = visual || fromMessages;
  }

  const sections: string[] = [];

  if (planImplement) {
    sections.push(
      "Create a complete but compact HANDOFF MEMORY from PLAN-MODE RESEARCH for an agent that will EXECUTE the accepted plan next.",
      "Do not add another framing paragraph; the memory wrapper already labels this as PLAN MODE HANDOFF and ACTIVE PLAN is re-injected separately.",
      "The material below was gathered under plan mode to design that plan/tasks. The next phase is agent implement — not gather-only.",
      "The live ACTIVE PLAN (goal/detail/tasks) will be re-injected separately — your job is ACTIONABLE research memory so implement does not re-discover or miss coverage.",
      "",
      "Use these section headings as applicable. For coding/general work, omit empty security-only sections instead of writing repeated `none` bullets; for pentest handoffs retain the coverage/finding sections:",
      "## User goals",
      "## Research evidence (facts from plan-mode tools)",
      "## Coverage ledger (do not blindly re-do)",
      "## Confirmed findings",
      "## Negative / tested-OK results",
      "## Untested / open classes",
      "## Artifacts & paths",
      "## Durable engagement rules (still apply in agent mode)",
      "## Plan-mode-only notes (historical — not current agent gates)",
      "## Commands/tools and key results",
      "## Current state",
      "## Remaining work (post-accept tasks)",
      "## Open risks / failures",
      "",
      "How to fill sections (agent-performance critical):",
      "- DEDUPLICATE: state each fact once in the best section. Do not repeat destination/tool versions/config contents under evidence, findings, commands, and current state.",
      "- For coding handoffs, target ~600–1000 tokens. Security handoffs may use the full 800–1500 only when needed to preserve findings/coverage.",
      "- Research evidence: concrete verified facts only — project state/stack/config for coding; hosts/IPs, ports, stack fingerprint, auth surfaces, headers, endpoints, versions for security. Complete every bullet.",
      "- Coverage ledger: expensive/stable research already done so execution deepens rather than restarts. This does NOT forbid one concise revalidation of mutable workspace/manifest/tool state after handoff.",
      "- Confirmed findings: each as severity + one-line evidence + impact/repro if known (F1, F2, … or short titles). If none yet, say so.",
      "- Negative / tested-OK: things checked and not issues (SSRF guard, CORS locked, etc.) so implement does not re-burn steps.",
      "- Untested / open classes: authz/IDOR, RBAC, payment, injection, etc. still open — especially anything blocked on credentials.",
      "- Artifacts & paths: include only reusable artifacts the implementer may need (reports, downloads, extracted specs, scan outputs). Omit routine fs.list/fs.read/tool.check receipt paths and transient temp logs whose result is already summarized.",
      "- Durable engagement rules ONLY if they still bind implement (remote target/scope, authorized testing, non-destructive default, do not treat clai workspace as the target, no local dev server for remote assessments).",
      "- Plan-mode-only notes: gather-only / await-accept / no-exploit-yet gates that applied BEFORE accept — label historical; implementer is past that phase.",
      "- Commands/tools: only non-obvious or reusable commands and their outcomes. Do not repeat routine list/read/tool-version facts already captured above.",
      "- Current state: describe the last tool-observed state at compaction time. Do not claim plan acceptance/approval unless DURABLE STATE confirms it; distinguish transition assumptions from evidence.",
      "- Remaining work: ACTIVE PLAN is injected separately, so do not restate every task. Record only the next task, dependency/order caveats, blockers, or plan details not present in durable state.",
      "- Resolve contradictions explicitly (for example, a non-empty destination is not simultaneously guaranteed safe for an in-place scaffolder). If evidence conflicts, preserve the uncertainty and safest next check.",
      "- Do NOT invent findings. Do NOT omit confirmed issues that appear in the material. Prefer denser bullets over long prose.",
      "- Prefer COMPLETE short memory over a long memory that cuts off mid-sentence.",
    );
  } else {
    sections.push(
      "Create a complete but compact continuation memory of the session below.",
      "Treat resumed history and newer turns as one continuous conversation.",
      "Open with a single ORIENTATION line — current objective plus status (done / in progress / blocked) — so the resuming agent reorients in one read. Keep it to one line; the details belong in the sections below, not restated here.",
      "",
      "Organize under these exact section headings (skip a section only if empty):",
      "## User goals",
      "## Decisions and constraints",
      "## Work completed",
      "## Commands/tools and results",
      "## Current state",
      "## Remaining work",
      "## Open risks / failures",
      "",
      "Preserve: user intentions, decisions, constraints, paths, stack/package manager,",
      "commands and key results, plan task states, errors and failed approaches,",
      "servers/jobs still running, and exactly what remains.",
      "",
      "AVOID BLOAT — this memory is prepended to a context that re-injects fresh ACTIVE PLAN, SESSION STATE, and ENGAGEMENT SCOPE after compaction:",
      "- DEDUPLICATE: state each fact once in its best section. Never repeat the same path, command, decision, or finding across multiple sections.",
      "- Do NOT restate the full plan or list every task under Remaining work — the live ACTIVE PLAN is re-injected separately. Record only deltas: the next task, blockers, dependency/order caveats, and states not obvious from the plan.",
      "- Do NOT reproduce long user prompts verbatim. Capture the goal and hard constraints concisely under User goals.",
      "- Omit routine fs.list / fs.read / tool.check receipts and transient logs whose result is already captured. Prefer dense bullets over prose.",
      "",
      "PHASE AWARENESS under Decisions and constraints:",
      "- If earlier turns were plan-mode research, do not elevate gather-only / await-accept / no-implement rules as permanent forever-constraints for agent execution.",
      "- Durable engagement policy (scope, remote target, non-destructive default) may still be listed as current.",
      "- Prefer labeling historical plan-mode gates as \"(plan-mode only; superseded after accept)\" when they appear in the material.",
    );
  }

  sections.push(
    "Be concise but specific. Target ~800–1500 tokens of memory. Dense bullets over prose. No secrets. No fabricated successes. No full tool dumps.",
  );

  if (durable) {
    sections.push("", "DURABLE STATE (trust this over older chatter):", durable);
  }

  sections.push("", "SESSION MATERIAL:", "", transcript);
  return sections.join("\n");
}

/** Soft cap for transcript fed to the summarizer (chars). */
export const COMPACTION_TRANSCRIPT_CHAR_BUDGET = 48_000;

/** Prefer head goals + tail recency when the transcript is huge. */
export function trimTranscriptForCompaction(
  transcript: string,
  budget = COMPACTION_TRANSCRIPT_CHAR_BUDGET,
): string {
  if (transcript.length <= budget) return transcript;
  const head = Math.floor(budget * 0.35);
  const tail = budget - head - 80;
  return (
    transcript.slice(0, head) +
    "\n\n[... middle of session omitted for length ...]\n\n" +
    transcript.slice(-tail)
  );
}


/**
 * Detects a "summary" that is really the model continuing the task or replaying
 * the raw transcript instead of compressing it. Weak models sometimes echo tool
 * receipts (bytes/lines/sha256), "TOOL:" lines, or "[tools: …]" markers, or
 * narrate the next step with fabricated tool calls. A faithful memory never
 * contains these artifacts, so their presence means the summary is unusable and
 * compaction should fail loudly rather than persist garbage.
 */
export function looksLikeTranscriptReplay(summary: string): boolean {
  const hardMarkers = [
    /sha256_12\s*=/i,
    /Do NOT re-read this file/i,
    /\(\s*exit\s*=\s*-?\d+\s*,\s*ok\s*=\s*(?:true|false)\s*\)/i,
    /<tool_call>|<arg_key>|<arg_value>|<\/tool_call>/i,
    /\bbytes\s*=\s*\d+\s+lines\s*=\s*\d+/i,
  ];
  if (hardMarkers.some((re) => re.test(summary))) return true;

  const softMarkers = [
    /^\s*TOOL:\s*Tool\b/im,
    /\[tools:\s/i,
    /\bLet me continue\b/i,
    /\bTask t\d+:/,
  ];
  return softMarkers.filter((re) => re.test(summary)).length >= 2;
}
