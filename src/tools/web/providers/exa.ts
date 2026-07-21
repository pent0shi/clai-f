/**
 * Exa search-provider adapter for `web.search`.
 *
 * Implements the {@link SearchProvider} contract from `./provider.ts` and
 * registers itself in the {@link searchProviders} registry on import. Like
 * the Brave and Tavily adapters it issues exactly one outbound HTTPS request
 * per invocation (Requirement 6.7), forwards the caller-provided
 * {@link AbortSignal} so the `web.search` timeout is honored (Requirement
 * 1.8), and returns a {@link RawProviderResponse} carrying the raw HTTP
 * status plus the parsed hit list for uniform error classification in the
 * handler (Requirements 6.1, 6.2, 6.5, 6.6).
 *
 * Endpoint and request shape follow Exa's `/search` reference
 * (https://docs.exa.ai/reference/search-api-guide-for-coding-agents):
 *
 *   - POST `https://api.exa.ai/search`
 *   - Header: `x-api-key: <key>`
 *   - Body: `{ query, type, numResults, contents: { highlights: true } }`
 *     where `type` is the user-configured {@link ExaSearchType} and
 *     `contents` is omitted for the `instant` tier so it keeps its
 *     sub-second latency profile.
 *   - Response: `{ results: [{ title, url, highlights?, text?, summary? }] }`
 *     mapped into `SearchResult { title, url, snippet }`.
 *
 * Only raw `results` + `highlights` are requested; `outputSchema` synthesis
 * is intentionally not used because the handler maps discrete hits rather
 * than a single grounded answer, and skipping it keeps latency and response
 * shape stable across every search type.
 */

import { Buffer } from "node:buffer";
import https from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";

import {
  searchProviders,
  type RawProviderResponse,
  type SearchProvider,
} from "./provider.js";
import {
  DEFAULT_EXA_SEARCH_TYPE,
  type ExaSearchType,
} from "../types.js";
import { getExaSearchType } from "../../../store/config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Exa search endpoint (host + path). */
const EXA_HOST = "api.exa.ai";
const EXA_PATH = "/search";

/**
 * `numResults` accepted by Exa. The `web.search` handler already clamps the
 * caller's `maxResults` to `[1, 20]`; we re-clamp defensively so the adapter
 * is self-consistent when invoked directly (e.g. from a unit test).
 */
const EXA_MIN_RESULTS = 1;
const EXA_MAX_RESULTS = 20;

/** User-Agent sent on outbound Exa requests. */
const DEFAULT_USER_AGENT = "clai-web-search/1.0";

/**
 * Hard cap on the number of body bytes read before surfacing a `parse`
 * error. Deep-search responses with highlights are comfortably under this
 * cap; it exists purely as a memory guard against a misbehaving upstream.
 */
const MAX_RESPONSE_BYTES = 4_194_304; // 4 MiB

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type HttpsRequestFn = typeof https.request;

let httpsRequestFn: HttpsRequestFn = https.request;

/**
 * Test-only seam: swap the HTTPS transport used by the adapter. Production
 * callers never invoke this; tests use it to inject a stubbed `request`
 * implementation that emits scripted responses.
 */
export function __setExaHttpsRequestForTesting(
  fn: HttpsRequestFn | undefined,
): void {
  httpsRequestFn = fn ?? https.request;
}

/**
 * Resolver for the configured search type. Reads `ClaiConfig.exaSearchType`
 * lazily so a config-store failure degrades to {@link DEFAULT_EXA_SEARCH_TYPE}
 * rather than throwing inside the search path. Tests may override it.
 */
let searchTypeResolver: () => ExaSearchType = defaultSearchTypeResolver;

function defaultSearchTypeResolver(): ExaSearchType {
  try {
    return getExaSearchType();
  } catch {
    return DEFAULT_EXA_SEARCH_TYPE;
  }
}

/**
 * Test-only seam: override how the adapter resolves the configured search
 * type. Passing `undefined` restores the config-backed resolver.
 */
export function __setExaSearchTypeResolverForTesting(
  resolver: (() => ExaSearchType) | undefined,
): void {
  searchTypeResolver = resolver ?? defaultSearchTypeResolver;
}

/** Clamp `numResults` to the Exa-supported range. */
function clampResults(count: number): number {
  if (!Number.isFinite(count)) return EXA_MIN_RESULTS;
  const rounded = Math.trunc(count);
  if (rounded < EXA_MIN_RESULTS) return EXA_MIN_RESULTS;
  if (rounded > EXA_MAX_RESULTS) return EXA_MAX_RESULTS;
  return rounded;
}

/**
 * Drain `res` into a UTF-8 string, capped at {@link MAX_RESPONSE_BYTES}. The
 * body cap defends against a misbehaving upstream; the {@link AbortSignal}
 * short-circuits the read on the `web.search` timeout (Requirement 1.8).
 */
function readBody(res: IncomingMessage, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;

    const onAbort = (): void => {
      if (aborted) return;
      aborted = true;
      res.destroy(new Error("aborted"));
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("aborted"),
      );
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    res.on("data", (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) {
        aborted = true;
        signal.removeEventListener("abort", onAbort);
        res.destroy();
        reject(new Error("response body exceeded 4 MiB cap"));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => {
      if (aborted) return;
      signal.removeEventListener("abort", onAbort);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    res.on("error", (err) => {
      if (aborted) return;
      aborted = true;
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

/**
 * Build the JSON request body. `contents.highlights` is requested for every
 * tier except `instant`, matching Exa's guidance that the instant tier stays
 * content-free to preserve its ~250 ms latency.
 */
function buildPayload(
  query: string,
  numResults: number,
  type: ExaSearchType,
): string {
  const body: Record<string, unknown> = { query, type, numResults };
  if (type !== "instant") {
    body.contents = { highlights: true };
  }
  return JSON.stringify(body);
}

/**
 * Issue the Exa HTTPS POST and resolve `{status, body}` once the response is
 * fully read. Network failures propagate as a thrown error so the adapter
 * can map them to a `status: 0` placeholder for the handler's `network`
 * classification (Requirement 6.3).
 */
function dispatchRequest(
  query: string,
  numResults: number,
  type: ExaSearchType,
  apiKey: string,
  signal: AbortSignal,
): Promise<{ status: number; body: string }> {
  const payload = buildPayload(query, numResults, type);
  const bodyBytes = Buffer.from(payload, "utf8");

  return new Promise((resolve, reject) => {
    let req: ClientRequest;
    try {
      req = httpsRequestFn(
        {
          method: "POST",
          host: EXA_HOST,
          path: EXA_PATH,
          signal,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "content-length": String(bodyBytes.length),
            "user-agent": DEFAULT_USER_AGENT,
            "x-api-key": apiKey,
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          readBody(res, signal).then(
            (body) => resolve({ status, body }),
            (err) => reject(err),
          );
        },
      );
    } catch (err) {
      reject(err);
      return;
    }

    req.on("error", (err) => {
      reject(err);
    });

    req.write(bodyBytes);
    req.end();
  });
}

/**
 * Collapse an Exa result's `highlights` (query-relevant excerpts) into a
 * single snippet, falling back to `text` then `summary`. Returns an empty
 * string when none is present so the handler's normaliser can decide.
 */
function extractSnippet(entry: {
  highlights?: unknown;
  text?: unknown;
  summary?: unknown;
}): string {
  if (Array.isArray(entry.highlights)) {
    const joined = entry.highlights
      .filter((h): h is string => typeof h === "string" && h.trim().length > 0)
      .join(" … ");
    if (joined) return joined;
  }
  if (typeof entry.text === "string" && entry.text.trim()) return entry.text;
  if (typeof entry.summary === "string" && entry.summary.trim()) {
    return entry.summary;
  }
  return "";
}

/**
 * Extract the Exa `results[]` array from a parsed JSON body and map it to
 * the {@link RawProviderResponse.hits} shape. Returns `null` when the body
 * did not carry a `{ results: [...] }` array so the adapter can surface a
 * `parseError` (Requirement 6.5).
 */
function extractHits(parsed: unknown): RawProviderResponse["hits"] | null {
  if (!parsed || typeof parsed !== "object") return null;
  const results = (parsed as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;

  const hits: RawProviderResponse["hits"] = [];
  for (const entry of results) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as {
      title?: unknown;
      url?: unknown;
      highlights?: unknown;
      text?: unknown;
      summary?: unknown;
    };
    const hit: RawProviderResponse["hits"][number] = {};
    if (typeof e.title === "string") hit.title = e.title;
    if (typeof e.url === "string") hit.url = e.url;
    const snippet = extractSnippet(e);
    if (snippet) hit.snippet = snippet;
    hits.push(hit);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Provider definition
// ---------------------------------------------------------------------------

/**
 * Exa adapter. Registered in {@link searchProviders} as a side-effect of
 * importing this module — `web.search` resolves the active provider via the
 * registry.
 */
export const exaProvider: SearchProvider = {
  id: "exa",
  displayName: "Exa",
  needsApiKey: true,
  envVar: "EXA_API_KEY",

  async search(
    query: string,
    maxResults: number,
    auth: { apiKey?: string },
    signal: AbortSignal,
  ): Promise<RawProviderResponse> {
    // Defensive: the handler resolves the key before calling us. If somehow
    // invoked without one, surface a 0-status response so the handler maps
    // it to `missing-key` / `network` rather than dispatching unauthenticated.
    if (!auth.apiKey) {
      return { status: 0, hits: [], parseError: "missing api key" };
    }

    const numResults = clampResults(maxResults);
    const type = searchTypeResolver();
    const { status, body } = await dispatchRequest(
      query,
      numResults,
      type,
      auth.apiKey,
      signal,
    );

    // Non-2xx: forward the status with an empty hit list; the handler maps
    // the status to the appropriate error kind.
    if (status < 200 || status >= 300) {
      return { status, hits: [] };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      return {
        status,
        hits: [],
        parseError:
          err instanceof Error
            ? `non-JSON response: ${err.message}`
            : "non-JSON response",
      };
    }

    const hits = extractHits(parsed);
    if (hits === null) {
      return {
        status,
        hits: [],
        parseError: "missing results array in Exa response",
      };
    }

    return { status, hits };
  },
};

// Register on import so `searchProviders.exa` is populated by the time the
// `web.search` handler dispatches.
searchProviders.exa = exaProvider;
