// Feature: web-search-and-fetch, Property 15: Search-provider key resolution precedence
//
// Validates: search providers follow the same explicit-configuration policy as
// LLM providers: stored keys override ambient environment variables; an env
// value is only used when no stored key exists. DuckDuckGo is keyless.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@napi-rs/keyring/keytar.js", () => ({
  default: {
    getPassword: async () => {
      throw new Error("keychain unavailable in tests");
    },
    setPassword: async () => {
      throw new Error("keychain unavailable in tests");
    },
    deletePassword: async () => {
      throw new Error("keychain unavailable in tests");
    },
  },
}));

const ENV_VARS = {
  brave: "BRAVE_SEARCH_API_KEY",
  tavily: "TAVILY_API_KEY",
  duckduckgo: undefined,
} as const;

const PROVIDERS = ["brave", "tavily", "duckduckgo"] as const;
type ProviderId = (typeof PROVIDERS)[number];

let tempDir: string;
let originalHome: string | undefined;
let originalBrave: string | undefined;
let originalTavily: string | undefined;

beforeAll(() => {
  originalHome = process.env.HOME;
  originalBrave = process.env.BRAVE_SEARCH_API_KEY;
  originalTavily = process.env.TAVILY_API_KEY;

  tempDir = mkdtempSync(join(tmpdir(), "clai-pbt-key-precedence-"));
  process.env.HOME = tempDir;
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.TAVILY_API_KEY;
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalBrave === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = originalBrave;

  if (originalTavily === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = originalTavily;

  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const optionalStringArb = fc.oneof(
  fc.constant<undefined>(undefined),
  fc.constant(""),
  fc.constant(" "),
  fc.constant("   "),
  fc.constant("\t\n"),
  fc
    .string({ minLength: 1, maxLength: 64 })
    .filter((value) => !value.includes("\0")),
);

const providerArb = fc.constantFrom<ProviderId>(...PROVIDERS);

describe("Property 15: Search-provider key resolution precedence", () => {
  it("returns stored → env → missing for keyed providers, and missing for the keyless provider", async () => {
    const { getSearchProviderKey, setSecret, unsetSecret } = await import(
      "../../src/store/keys.js"
    );

    await fc.assert(
      fc.asyncProperty(
        optionalStringArb,
        optionalStringArb,
        providerArb,
        async (envValue, storedValue, providerId) => {
          const envVar = ENV_VARS[providerId];
          if (envVar) {
            if (envValue === undefined) delete process.env[envVar];
            else process.env[envVar] = envValue;
          }

          await unsetSecret("search", providerId);
          if (storedValue !== undefined && storedValue.length > 0) {
            await setSecret("search", providerId, storedValue);
          }

          const result = await getSearchProviderKey(providerId);
          const isKeyless = providerId === "duckduckgo";
          const storedWins =
            !isKeyless &&
            storedValue !== undefined &&
            storedValue.trim().length > 0;
          const envWins =
            !isKeyless &&
            !storedWins &&
            envVar !== undefined &&
            envValue !== undefined &&
            envValue.length > 0;

          if (storedWins) {
            expect(result.value).toBe(storedValue.trim());
            expect(result.source).toBe("fallback");
          } else if (envWins) {
            expect(result.value).toBe(envValue);
            expect(result.source).toBe("env");
          } else {
            expect(result.value).toBeUndefined();
            expect(result.source).toBe("missing");
          }

          if (envVar) delete process.env[envVar];
          await unsetSecret("search", providerId);
        },
      ),
      { numRuns: 100 },
    );
  });
});
