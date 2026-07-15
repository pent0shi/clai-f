import { describe, expect, it } from "vitest";
import { parseBatchLiveProgress } from "../../../src/tui-v2/rendering/batch-sections.js";

describe("parseBatchLiveProgress", () => {
  it("collapses ticks into one status line per call", () => {
    const raw = [
      "[batch] starting 3 call(s), concurrency=3",
      "[batch] #1 whois.lookup starting",
      "[batch] #2 dns.lookup starting",
      "[batch] #1 whois.lookup fail exit=130",
      "[batch] #2 dns.lookup ok exit=0",
      "[batch] still running — 2/3 finished",
    ].join("\n");
    const { lines, summary } = parseBatchLiveProgress(raw);
    expect(summary).toMatch(/2 settled/);
    expect(lines.some((l) => l.text.includes("whois.lookup") && l.tone === "fail")).toBe(
      true,
    );
    expect(lines.some((l) => l.text.includes("dns.lookup") && l.tone === "ok")).toBe(true);
  });
});
