import { describe, expect, it } from "vitest";
import { resolveNmapTimeoutPolicy } from "../src/tools/nmap-runner.js";

describe("Nmap timeout policy", () => {
  it("uses a bounded standard profile for narrow scans", () => {
    expect(resolveNmapTimeoutPolicy(["--top-ports", "100", "example.com"], {})).toEqual({
      depth: "standard",
      timeoutMs: 5 * 60_000,
      source: "profile",
    });
  });

  it("allows full-port scans to outlive the old five-minute foreground cap", () => {
    expect(resolveNmapTimeoutPolicy(["-p-", "example.com"], {})).toEqual({
      depth: "full",
      timeoutMs: 45 * 60_000,
      source: "profile",
    });
  });

  it("assigns deeper enumeration an intermediate resource envelope", () => {
    expect(resolveNmapTimeoutPolicy(["-sV", "example.com"], {})).toMatchObject({
      depth: "deep",
      timeoutMs: 15 * 60_000,
    });
  });

  it("honors a safe operator timeout override and ignores unsafe values", () => {
    expect(
      resolveNmapTimeoutPolicy(["-p-", "example.com"], {
        CLAI_NMAP_TIMEOUT_MS: "3600000",
      }),
    ).toEqual({ depth: "full", timeoutMs: 3_600_000, source: "environment" });

    expect(
      resolveNmapTimeoutPolicy(["example.com"], { CLAI_NMAP_TIMEOUT_MS: "1000" }),
    ).toMatchObject({ timeoutMs: 5 * 60_000, source: "profile" });
  });
});
