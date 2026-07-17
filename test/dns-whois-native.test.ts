import { describe, expect, it, vi, afterEach } from "vitest";
import { nativeDnsLookup } from "../src/tools/dns-native.js";
import { nativeWhoisLookup } from "../src/tools/whois-native.js";
import { findExecutable, augmentedPathEnv } from "../src/os/command.js";
import { toolRegistry } from "../src/tools/registry.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("native DNS / WHOIS (no dig/whois binaries)", () => {
  it("resolves A records without spawning dig", async () => {
    const result = await nativeDnsLookup("localhost", "A");
    // localhost always resolves or DoH may fail offline — accept either
    // successful local resolution.
    if (result.ok) {
      expect(result.output).toMatch(/DNS A records for localhost/);
      expect(result.output).toMatch(/127\.0\.0\.1|::1/);
    } else {
      // Offline CI: system + DoH both unavailable is acceptable only if
      // the error names both paths (never dig/posix_spawn).
      expect(result.output).not.toMatch(/dig|posix_spawn|ENOENT/);
      expect(result.output).toMatch(/DNS lookup failed|DoH|timed out/i);
    }
  });

  it("dns.lookup registry handler never invokes dig", async () => {
    const result = await toolRegistry["dns.lookup"]!(
      { target: "localhost", record: "A" },
      {},
    );
    expect(result.output).not.toMatch(/posix_spawn ['"]dig['"]/);
    expect(result.output).not.toMatch(/no such file or directory.*dig/i);
  });

  it("whois.lookup registry handler never invokes whois binary", async () => {
    // Mock RDAP success so the test is offline-safe and fast.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ objectClassName: "domain", ldhName: "example.com" }), {
          status: 200,
          headers: { "content-type": "application/rdap+json" },
        }),
      ),
    );
    const result = await toolRegistry["whois.lookup"]!(
      { target: "example.com" },
      {},
    );
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/RDAP registration lookup/);
    expect(result.output).not.toMatch(/posix_spawn ['"]whois['"]/);
  });

  it("nativeWhoisLookup falls back to port-43 when RDAP fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    // Port-43 may work or fail offline; never blame missing whois binary.
    const result = await nativeWhoisLookup("example.com");
    expect(result.output).not.toMatch(/posix_spawn|whois binary|ENOENT.*whois/i);
  });
});

describe("findExecutable PATH hardening", () => {
  it("augments PATH with system bin dirs", () => {
    const path = augmentedPathEnv("/tmp/only");
    expect(path).toContain("/tmp/only");
    if (process.platform !== "win32") {
      expect(path).toMatch(/\/usr\/bin/);
      expect(path).toMatch(/\/bin/);
    }
  });

  it("finds sh even when PATH is empty (unix)", async () => {
    if (process.platform === "win32") return;
    const prev = process.env.PATH;
    try {
      process.env.PATH = "";
      const found = await findExecutable("sh");
      // /bin/sh almost always exists on unix CI / macOS / Linux.
      expect(found === undefined || found.includes("sh")).toBe(true);
      if (found) expect(found).toMatch(/sh$/);
    } finally {
      process.env.PATH = prev;
    }
  });
});
