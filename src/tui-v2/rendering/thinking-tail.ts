// Live reasoning can run to tens of thousands of chars. While it streams, only
// a bounded tail is painted so per-frame wrap work stays constant; the finalized
// block still shows the full content.

export const LIVE_THINKING_TAIL_CHARS = 2_000;

export function liveThinkingTail(
  content: string,
  limit = LIVE_THINKING_TAIL_CHARS,
): string {
  if (content.length <= limit) return content;
  const slice = content.slice(content.length - limit);
  const newline = slice.indexOf("\n");
  const aligned = newline >= 0 && newline < 200 ? slice.slice(newline + 1) : slice;
  return `…\n${aligned}`;
}
