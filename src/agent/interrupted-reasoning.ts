export const INTERRUPTED_REASONING_LIMIT = 4_000;

export const INTERRUPTED_REASONING_MIN = 160;

export const MIN_RESUMPTION_YIELD = 240;

export function isMeaningfulResumptionYield(producedChars: number): boolean {
  return producedChars >= MIN_RESUMPTION_YIELD;
}

function normalize(reasoning: string): string {
  return reasoning.replace(/\r/g, "").replace(/[ \t]+$/gm, "").trim();
}

function clampReasoning(reasoning: string): string {
  if (reasoning.length <= INTERRUPTED_REASONING_LIMIT) return reasoning;
  const tail = reasoning.slice(reasoning.length - INTERRUPTED_REASONING_LIMIT);
  const breakAt = tail.indexOf("\n");
  return breakAt > 0 && breakAt < 400 ? tail.slice(breakAt + 1) : tail;
}

export function appendInterruptedReasoning(
  previous: string,
  next: string,
): string {
  const addition = normalize(next);
  if (!addition) return previous;
  const earlier = normalize(previous);
  if (!earlier) return clampReasoning(addition);
  if (earlier.includes(addition)) return clampReasoning(earlier);
  if (addition.includes(earlier)) return clampReasoning(addition);
  return clampReasoning(`${earlier}\n\n${addition}`);
}

export function interruptedReasoningBrief(
  reasoning: string,
): string | undefined {
  const body = normalize(reasoning);
  if (body.length < INTERRUPTED_REASONING_MIN) return undefined;
  return (
    "Your own reasoning from the interrupted attempt is preserved below. " +
    "Build on these conclusions instead of re-deriving them, and go straight to the next concrete action.\n\n" +
    `<preserved_reasoning>\n${body}\n</preserved_reasoning>`
  );
}
