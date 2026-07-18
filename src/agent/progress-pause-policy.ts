/**
 * When the progress governor recommends `paused_budget`, decide how the runner
 * should react.
 *
 * - coding/build sessions: never hard-stop mid-turn (no "type continue" UX).
 * - pentest / general: pause only after an interactive continue/stop confirm.
 * - autoConfirm (-y): keep going without a prompt.
 */

export type ProgressPauseMode = "never" | "confirm";

export function progressPauseMode(input: {
  /** Build / feature / coding work (including coding plans). */
  codingSession: boolean;
  /** CLI -y / non-interactive. */
  autoConfirm: boolean;
}): ProgressPauseMode {
  if (input.codingSession) return "never";
  if (input.autoConfirm) return "never";
  return "confirm";
}

/** True when tool output is a protocol-repair placeholder, not live work. */
export function isProtocolPlaceholderOutput(output: string | undefined): boolean {
  if (!output) return false;
  return (
    output.includes("[protocol] closed incomplete") ||
    output.includes("[internal-pairing]") ||
    output.includes("history-repair") ||
    /^\[protocol\]/i.test(output.trim()) ||
    /^\[internal-pairing\]/i.test(output.trim())
  );
}

export function codingSessionFromContext(input: {
  buildLike: boolean;
  planKind?: string | undefined;
}): boolean {
  const kind = (input.planKind ?? "").toLowerCase();
  return input.buildLike || kind === "coding";
}
