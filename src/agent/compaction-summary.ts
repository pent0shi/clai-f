/**
 * Prompts and helpers for LLM-based context compaction.
 * The model produces structured continuation memory — not a raw transcript dump.
 */

export const COMPACTION_SYSTEM_PROMPT = `You are a session-memory compressor for an autonomous coding and security agent.

Write a dense, accurate CONTINUATION MEMORY for another assistant that will resume this work with no other history.

Rules:
- Fidelity over style. Never invent tool results, file contents, findings, URLs, ports, or completions.
- Prefer concrete artifacts: absolute paths, commands (short form), exit outcomes, HTTP status, plan task ids/states, job ids, open ports, confirmed vs unconfirmed findings.
- Omit secrets, API keys, passwords, tokens, and full credential material. Say "[redacted]" if present.
- Omit progress bars, repeated failures, and decorative chatter.
- Do not wrap the whole answer in markdown code fences.
- If something is unknown, omit it rather than guessing.`;

export interface CompactionPromptParts {
  visualTranscript?: string | undefined;
  messageTranscript: string;
  /** Optional live plan / session state to prioritize. */
  durableState?: string | undefined;
}

/** User message fed to the summarizer model. */
export function buildCompactionUserPrompt(parts: CompactionPromptParts): string {
  const visual = parts.visualTranscript?.trim() ?? "";
  const fromMessages = parts.messageTranscript.trim();
  const durable = parts.durableState?.trim() ?? "";

  let transcript = "";
  if (visual && fromMessages) {
    transcript = `${visual}\n\n---\n\nOLDER MODEL TURNS:\n\n${fromMessages}`;
  } else {
    transcript = visual || fromMessages;
  }

  const sections = [
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
    "Be concise but specific. No secrets. No fabricated successes.",
  ];

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
