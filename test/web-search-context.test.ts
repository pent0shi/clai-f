import { describe, expect, it } from "vitest";
import { formatToolContext } from "../src/agent/tool-output-formatting.js";
import { webSearch } from "../src/tools/web/search.js";
import type {
  RawProviderResponse,
  SearchProvider,
} from "../src/tools/web/providers/provider.js";

function makeProvider(hits: RawProviderResponse["hits"]): SearchProvider {
  return {
    id: "duckduckgo",
    displayName: "DuckDuckGo",
    needsApiKey: false,
    async search(): Promise<RawProviderResponse> {
      return { status: 200, hits };
    },
  };
}

describe("web.search model-facing context", () => {
  it("returns complete compact listing and does not look interrupted", async () => {
    const hits = Array.from({ length: 5 }, (_, i) => ({
      title: `Result ${i + 1}: modern guide ${i}`,
      url: `https://example.com/post/${i + 1}`,
      snippet: `Snippet about topic ${i + 1} with enough detail to be useful.`,
    }));
    const result = await webSearch(
      { query: "modern react blog 2026", maxResults: 5 },
      {
        provider: "duckduckgo",
        providerOverride: makeProvider(hits),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/web\.search complete/i);
    expect(result.output).toMatch(/Status: complete/i);
    expect(result.output).toMatch(/not truncated or interrupted/i);
    // All five titles present in the human listing (not only head/tail).
    for (const hit of hits) {
      expect(result.output).toContain(hit.title);
      expect(result.output).toContain(hit.url);
    }
    // Machine appendix still present.
    expect(result.output.trim().endsWith("}")).toBe(true);
    expect(result.output).toContain('"results"');
  });

  it("formatToolContext keeps all hits and never runs generic reduce omit text", async () => {
    const hits = Array.from({ length: 8 }, (_, i) => ({
      title: `Hit ${i + 1} about Next.js and Tailwind`,
      url: `https://docs.example.com/${i + 1}`,
      snippet: `Body line ${i + 1} `.repeat(12),
    }));
    const result = await webSearch(
      { query: "tailwind v4 vite", maxResults: 8 },
      {
        provider: "duckduckgo",
        providerOverride: makeProvider(hits),
      },
    );
    const ctx = formatToolContext(
      { name: "web.search", args: { query: "tailwind v4 vite" } },
      result,
    );
    expect(ctx).not.toMatch(/Reduced output/i);
    expect(ctx).not.toMatch(/lines omitted/i);
    expect(ctx).not.toMatch(/output lines truncated/i);
    expect(ctx).toMatch(/web\.search complete|Status: complete/i);
    for (const hit of hits) {
      expect(ctx).toContain(hit.url);
    }
  });

  it("keeps zero-result literal for Requirement 1.7", async () => {
    const result = await webSearch(
      { query: "zzzz empty" },
      {
        provider: "duckduckgo",
        providerOverride: makeProvider([]),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toBe("No results found.");
  });
});
