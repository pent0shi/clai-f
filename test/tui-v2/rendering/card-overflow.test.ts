import { describe, expect, it } from "vitest";
import {
  clampArgsDisplay,
  presentTool,
} from "../../../src/tui-v2/rendering/tool-presenter.js";
import { scrollbarSegments } from "../../../src/tui-v2/components/transcript/transcript-scrollbar.js";
import type { ToolItem } from "../../../src/tui-v2/state/transcript-types.js";

/**
 * A heredoc (`cat > main.py << 'EOF' … EOF`) puts a whole source file into the
 * command string. Rendered verbatim it made one tool card hundreds of rows
 * tall, which overflowed the card border and squeezed the card's single-row
 * chrome (OUTPUT / SAVED / footer hint) into overlapping rows — the reported
 * "everything overflowing from their boxes" corruption.
 */
describe("oversized tool args never blow the card layout", () => {
  const heredoc = [
    "cat > /Users/x/main.py << 'EOF'",
    ...Array.from({ length: 240 }, (_, i) => `line_${i} = ${i}`),
    "EOF",
  ].join("\n");

  it("clamps a multi-hundred-line command to a bounded preview", () => {
    const clamped = clampArgsDisplay(heredoc);
    const lines = clamped!.split("\n");
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines[0]).toContain("cat >");
    expect(lines.at(-1)).toMatch(/\+\d+ more lines · click for full/);
  });

  it("clips an extremely long single line", () => {
    const clamped = clampArgsDisplay("x".repeat(5_000))!;
    expect(clamped.split("\n")).toHaveLength(1);
    expect(clamped.length).toBeLessThanOrEqual(200);
    expect(clamped.endsWith("…")).toBe(true);
  });

  it("leaves a normal command untouched", () => {
    expect(clampArgsDisplay("npm run build")).toBe("npm run build");
    expect(clampArgsDisplay(undefined)).toBeUndefined();
  });

  it("presents shell.exec heredoc commands already bounded", () => {
    const item = {
      kind: "tool",
      id: "t1",
      name: "shell.exec",
      argsDisplay: heredoc,
      status: "done",
      outputBytes: 0,
    } as unknown as ToolItem;

    const presented = presentTool(item);
    expect(presented.argsDisplay!.split("\n").length).toBeLessThanOrEqual(4);
  });
});

/**
 * The thumb used to be baked into the track string AND drawn again by an
 * absolutely positioned overlay, so two elements wrote the same cells and the
 * thumb rendered striped (alternating track/thumb grey).
 */
describe("scrollbar segments do not overlap", () => {
  it("splits the track into above/thumb/below covering the height exactly once", () => {
    const segments = scrollbarSegments({ top: 3, size: 4 }, 10);
    const rows = (s: string) => (s ? s.split("\n").length : 0);
    expect(rows(segments.above)).toBe(3);
    expect(rows(segments.thumb)).toBe(4);
    expect(rows(segments.below)).toBe(3);
    expect(segments.above).not.toContain("█");
    expect(segments.below).not.toContain("█");
    expect(segments.thumb.replace(/\n/g, "")).toBe("████");
  });

  it("never exceeds the track height", () => {
    const segments = scrollbarSegments({ top: 8, size: 9 }, 10);
    const total =
      (segments.above ? segments.above.split("\n").length : 0) +
      (segments.thumb ? segments.thumb.split("\n").length : 0) +
      (segments.below ? segments.below.split("\n").length : 0);
    expect(total).toBe(10);
  });
});
