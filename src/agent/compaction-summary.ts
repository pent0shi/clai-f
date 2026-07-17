/**
 * Prompts and helpers for LLM-based context compaction.
 * The model produces structured continuation memory — not a raw transcript dump.
 */

export const COMPACTION_SYSTEM_PROMPT = `You are a session-memory compressor for an autonomous coding and security agent.

Write a dense, accurate CONTINUATION MEMORY for another assistant that will resume this work with no other history.

Rules:
- Fidelity over style. Never invent tool results, file contents, findings, URLs, ports, or completions.
- Prefer concrete artifacts: absolute paths, commands (short form), exit outcomes, HTTP status, plan task ids/states, job ids, open ports, confirmed vs unconfirmed findings.
- LENGTH: aim for ~800–1500 tokens of dense bullets — complete short memory beats a long dump that cuts mid-sentence. No full tool transcripts or HTML bodies.
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
      "Open with one framing line: this context is from plan mode — the research run that produced the comprehensive detailed plan and tasks the implementer is seeing (ACTIVE PLAN is re-injected separately).",
      "The material below was gathered under plan mode to design that plan/tasks. The next phase is agent implement — not gather-only.",
      "The live ACTIVE PLAN (goal/detail/tasks) will be re-injected separately — your job is ACTIONABLE research memory so implement does not re-discover or miss coverage.",
      "",
      "Organize under these exact section headings (include a section even if short — write \"none\" only when truly empty):",
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
      "- Research evidence: concrete facts only — hosts/IPs, ports, stack fingerprint, auth surfaces, headers, endpoints, versions. Complete every bullet (never end mid-token like \"DEN\" for DENY).",
      "- Coverage ledger: what recon/enum is already done enough (e.g. DNS done, top-ports done, OpenAPI harvested) so implement can deepen rather than restart from zero.",
      "- Confirmed findings: each as severity + one-line evidence + impact/repro if known (F1, F2, … or short titles). If none yet, say so.",
      "- Negative / tested-OK: things checked and not issues (SSRF guard, CORS locked, etc.) so implement does not re-burn steps.",
      "- Untested / open classes: authz/IDOR, RBAC, payment, injection, etc. still open — especially anything blocked on credentials.",
      "- Artifacts & paths: absolute paths to reports, downloads, .map extracts, scan outputs under temp/scratch/.clai/outputs.",
      "- Durable engagement rules ONLY if they still bind implement (remote target/scope, authorized testing, non-destructive default, do not treat clai workspace as the target, no local dev server for remote assessments).",
      "- Plan-mode-only notes: gather-only / await-accept / no-exploit-yet gates that applied BEFORE accept — label historical; implementer is past that phase.",
      "- Commands/tools: high-signal tools used + outcomes (not every progress line). Prefer name + target + result in one line.",
      "- Remaining work: map to task ids/titles when ACTIVE PLAN is in DURABLE STATE (t1…); note blocked-on-creds clearly.",
      "- Do NOT invent findings. Do NOT omit confirmed issues that appear in the material. Prefer denser bullets over long prose.",
      "- Prefer COMPLETE short memory over a long memory that cuts off mid-sentence.",
    );
  } else {
    sections.push(
      "Create a complete but compact continuation memory of the session below.",
      "Treat resumed history and newer turns as one continuous conversation.",
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
