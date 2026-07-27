import { describe, expect, it } from "vitest";
import {
  LIVE_THINKING_TAIL_CHARS,
  liveCompactionHeadTail,
  liveThinkingTail,
} from "../../../src/tui-v2/rendering/thinking-tail.js";

describe("live thinking tail (TUI-004)", () => {
  it("passes short reasoning through untouched", () => {
    expect(liveThinkingTail("short reasoning")).toBe("short reasoning");
  });

  it("bounds the painted tail for long reasoning", () => {
    const content = `${"reasoning step\n".repeat(4_000)}final line`;
    const tail = liveThinkingTail(content);
    expect(tail.length).toBeLessThanOrEqual(LIVE_THINKING_TAIL_CHARS + 2);
    expect(tail.startsWith("…\n")).toBe(true);
    expect(tail.endsWith("final line")).toBe(true);
  });

  it("keeps the tail size constant as reasoning grows", () => {
    const shorter = liveThinkingTail("word ".repeat(2_000));
    const longer = liveThinkingTail("word ".repeat(40_000));
    expect(longer.length).toBe(shorter.length);
  });

  it("keeps both the stable head and live tail of a streaming compaction", () => {
    const content = `# Goals\n${"middle line\n".repeat(2_000)}## Remaining\n- verify`;
    const bounded = liveCompactionHeadTail(content, 120, 160);
    expect(bounded).toContain("# Goals");
    expect(bounded).toContain("streaming middle omitted");
    expect(bounded).toContain("## Remaining");
    expect(bounded).toContain("- verify");
    expect(bounded.length).toBeLessThan(400);
  });
});
