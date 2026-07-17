import net from "node:net";
import { lookup } from "node:dns/promises";
import type { ToolResult } from "../types.js";
import { isBlockedAddress } from "./web/ssrf-guard.js";
import { toReadableText } from "./web/readable.js";

/** Capture budget for body bytes (artifact + evidence build). Model context is capped later. */
const DEFAULT_MAX_BYTES = 128 * 1024;
/**
 * Default retries for remote evidence: 0 so intentional 5xx/probe responses are
 * not silently rewritten. Callers may pass retries; owned loopback still soft-
 * retries connection refused.
 */
const DEFAULT_RETRIES = 0;
const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const ALLOWED_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
/** Browser-like default UA — less fingerprint noise than clai-http-fetch/*. */
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; clai/1.0; +https://github.com/pentoshi007/clai) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 3_000;
const MAX_TIMEOUT_MS = 60_000;

interface RedirectHop {
  status: number;
  url: string;
  location: string;
  setCookies: string[];
}

/**
 * Block (or require explicit ownership confirmation for) requests that
 * target loopback, private, link-local, or cloud-metadata addresses.
 *
 * The classification logic now lives in {@link "./web/ssrf-guard"} so that
 * `http.fetch` and the new `web.fetch` tool share a single source of truth
 * for SSRF rules. This file re-exports `isBlockedAddress` for callers that
 * still import it from `../tools/http`, but the implementation is the
 * structured classifier in `web/ssrf-guard.ts`.
 */
export { isBlockedAddress };

/**
 * Upper bound for policy DNS only — must cover slow / corporate resolvers
 * without hanging forever. Literal IPs skip lookup entirely. The outer
 * request abort (15s) still bounds the whole hop.
 */
const DNS_LOOKUP_TIMEOUT_MS = 10_000;

async function resolveHosts(host: string): Promise<string[]> {
  if (net.isIP(host)) return [host];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("DNS lookup timed out")),
          DNS_LOOKUP_TIMEOUT_MS,
        );
      }),
    ]);
    return Array.from(new Set(results.map((result) => result.address)));
  } catch {
    // NXDOMAIN, timeout, or resolver failure — treat as unresolved (not blocked
    // by IP class alone; authorizeHop still sees the empty list).
    return [];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** True for loopback hostnames / IPs (local dev servers). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    h === "localhost" ||
    h === "localhost.localdomain" ||
    h === "ip6-localhost" ||
    h === "ip6-loopback" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "0:0:0:0:0:0:0:1"
  ) {
    return true;
  }
  // 127.0.0.0/8
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

/**
 * Vite/macOS often listens on only one of IPv4/IPv6. Browser "localhost"
 * works dual-stack; a single-address probe can false-fail. Return ordered
 * candidates: original host first, then the other loopback form(s).
 */
export function loopbackUrlCandidates(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [url];
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!isLoopbackHost(host)) return [url];

  const out: string[] = [];
  const push = (hostname: string): void => {
    try {
      const u = new URL(parsed.toString());
      // WHATWG URL: assign bare IPv6 without brackets.
      u.hostname = hostname === "[::1]" ? "::1" : hostname;
      const s = u.toString();
      if (!out.includes(s)) out.push(s);
    } catch {
      /* skip invalid candidate */
    }
  };

  // Prefer the caller's host first (browser-compatible localhost).
  push(host === "[::1]" ? "::1" : host);
  if (host === "localhost" || host === "localhost.localdomain") {
    push("127.0.0.1");
    push("::1");
  } else if (host === "127.0.0.1" || /^127\./.test(host)) {
    push("localhost");
    push("::1");
  } else if (host === "::1" || host === "0:0:0:0:0:0:0:1") {
    push("127.0.0.1");
    push("localhost");
  }
  return out.length > 0 ? out : [url];
}

function isConnectionRefusedError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    /\bECONNREFUSED\b/i.test(msg) ||
    /\bconnect\s+ECONNREFUSED\b/i.test(msg) ||
    /\bfetch failed\b/i.test(msg) ||
    /\bother side closed\b/i.test(msg) ||
    /\bsocket hang up\b/i.test(msg)
  );
}

interface FetchOptions {
  method?: string | undefined;
  body?: string | undefined;
  headers?: Record<string, string> | undefined;
  maxBytes?: number | undefined;
  iOwnThis?: boolean | undefined;
  retries?: number | undefined;
  /** Request timeout in ms (clamped 3s–60s). Default 15s. */
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  authorizeHop?: ((url: string, resolvedAddresses: string[]) => Promise<{ allowed: boolean; reason: string }> | { allowed: boolean; reason: string }) | undefined;
}

function clampTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.floor(value)));
}

export async function httpFetch(
  url: string,
  options: FetchOptions = {},
): Promise<ToolResult> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { ok: false, output: `Invalid URL: ${url}`, exitCode: 1 };
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return {
      ok: false,
      output: `Refusing non-http(s) scheme: ${target.protocol}`,
      exitCode: 1,
    };
  }

  const method = (options.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return {
      ok: false,
      output: `Unsupported HTTP method: ${method}`,
      exitCode: 1,
    };
  }

  const startHost = target.hostname.replace(/^\[|\]$/g, "");
  const ownedLoopback = Boolean(options.iOwnThis && isLoopbackHost(startHost));

  // SSRF and engagement-policy checks run for the initial destination and
  // every redirect hop. Owned loopback (local app verify) skips engagement
  // hop checks — a leftover pentest scope must not block http://localhost:5173.
  const authorizeDestination = async (destination: URL): Promise<string | undefined> => {
    const hostname = destination.hostname.replace(/^\[|\]$/g, "");
    const resolvedAddresses = await resolveHosts(hostname);
    const blocked = isBlockedAddress(hostname) || resolvedAddresses.some(isBlockedAddress);
    const destLoopback = isLoopbackHost(hostname);
    if (blocked && !options.iOwnThis) {
      return `Refusing to fetch private/loopback/metadata address ${hostname}. Pass iOwnThis=true to override.`;
    }
    // Owned local-dev probes are never subject to remote engagement scope.
    if (options.iOwnThis && destLoopback) {
      return undefined;
    }
    if (options.authorizeHop) {
      const decision = await options.authorizeHop(destination.toString(), resolvedAddresses);
      if (!decision.allowed) return `Blocked network destination ${destination.toString()}: ${decision.reason}`;
    }
    return undefined;
  };
  const initialDenial = await authorizeDestination(target);
  if (initialDenial) return { ok: false, output: initialDenial, exitCode: 1 };

  const headers = new Headers(options.headers);
  if (!headers.has("user-agent")) {
    headers.set("user-agent", DEFAULT_USER_AGENT);
  }
  if (!headers.has("accept")) {
    headers.set(
      "accept",
      "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
    );
  }
  if (!headers.has("accept-language")) {
    headers.set("accept-language", "en-US,en;q=0.8");
  }

  const init: RequestInit = {
    method,
    headers,
    redirect: "manual",
  };
  if (options.body !== undefined && method !== "GET" && method !== "HEAD") {
    init.body = options.body;
  }

  // Local dev: try localhost / 127.0.0.1 / ::1 until one accepts (Vite dual-stack).
  const urlCandidates =
    ownedLoopback && (method === "GET" || method === "HEAD")
      ? loopbackUrlCandidates(url)
      : [url];

  let response: Response | undefined;
  let attempts = 0;
  let lastNetworkError: unknown;
  let usedUrl = url;
  let redirectHops: RedirectHop[] = [];
  const timeoutMs = clampTimeoutMs(options.timeoutMs);
  // Status retries only when caller opts in (default 0). Loopback keeps soft
  // connection-refused retries below regardless of status-retry budget.
  const statusRetryLimit =
    method === "GET" || method === "HEAD"
      ? clampRetries(options.retries ?? DEFAULT_RETRIES)
      : 0;
  const connRetryLimit = ownedLoopback
    ? Math.max(statusRetryLimit, 4)
    : statusRetryLimit;

  try {
    candidateLoop: for (let ci = 0; ci < urlCandidates.length; ci += 1) {
      const candidateUrl = urlCandidates[ci]!;
      usedUrl = candidateUrl;
      let localAttempts = 0;
      for (;;) {
        attempts += 1;
        localAttempts += 1;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const onParentAbort = () => controller.abort();
        if (options.signal) {
          if (options.signal.aborted) {
            throw options.signal.reason ?? new Error("Aborted");
          }
          options.signal.addEventListener("abort", onParentAbort);
        }
        try {
          let requestUrl = candidateUrl;
          let redirects = 0;
          redirectHops = [];
          for (;;) {
            response = await fetch(requestUrl, {
              ...init,
              signal: controller.signal,
            });
            const location = response.headers.get("location");
            if (!(response.status >= 300 && response.status < 400 && location)) break;
            if (redirects >= 10) throw new Error("Too many redirects (maximum 10)");
            const setCookies =
              typeof response.headers.getSetCookie === "function"
                ? response.headers.getSetCookie()
                : multiHeader(response.headers, "set-cookie");
            redirectHops.push({
              status: response.status,
              url: requestUrl,
              location,
              setCookies,
            });
            const next = new URL(location, requestUrl);
            const denial = await authorizeDestination(next);
            if (denial) throw new Error(denial);
            await drainResponse(response);
            requestUrl = next.toString();
            redirects += 1;
          }
          if (
            localAttempts <= statusRetryLimit &&
            RETRY_STATUSES.has(response.status)
          ) {
            await drainResponse(response);
            await sleep(retryDelayMs(localAttempts));
            continue;
          }
          break candidateLoop;
        } catch (error) {
          lastNetworkError = error;
          const isTimeout =
            error instanceof Error &&
            error.name === "AbortError" &&
            !options.signal?.aborted;
          const errMsg = isTimeout
            ? `Request timed out after ${timeoutMs}ms`
            : error instanceof Error
              ? error.message
              : String(error);
          if (options.signal?.aborted) {
            throw new Error(errMsg);
          }
          // Connection refused on loopback → try next address or retry.
          if (ownedLoopback && isConnectionRefusedError(error)) {
            if (localAttempts <= connRetryLimit) {
              await sleep(Math.min(400 * localAttempts, 1500));
              continue;
            }
            if (ci + 1 < urlCandidates.length) {
              break; // next candidate
            }
            throw new Error(errMsg);
          }
          if (localAttempts > statusRetryLimit) {
            throw new Error(errMsg);
          }
          await sleep(retryDelayMs(localAttempts));
        } finally {
          clearTimeout(timer);
          if (options.signal) {
            options.signal.removeEventListener("abort", onParentAbort);
          }
        }
      }
    }
  } catch (error) {
    const tried =
      urlCandidates.length > 1
        ? ` (tried ${urlCandidates.join(" → ")})`
        : "";
    return {
      ok: false,
      output: `Network error after ${attempts} attempt${attempts === 1 ? "" : "s"}${tried}: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: 1,
    };
  }
  if (!response) {
    return {
      ok: false,
      output: "Network error: no response was received",
      exitCode: 1,
    };
  }
  const limit = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let collected = "";
  let bytesRead = 0;
  let truncated = false;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (bytesRead < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const remaining = limit - bytesRead;
        if (value.byteLength > remaining) {
          collected += decoder.decode(value.subarray(0, remaining), { stream: true });
          bytesRead += remaining;
          truncated = true;
          try {
            await reader.cancel();
          } catch {
            // ignore — we're abandoning the body deliberately
          }
          break;
        }
        collected += decoder.decode(value, { stream: true });
        bytesRead += value.byteLength;
      }
      collected += decoder.decode();
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }
  } else {
    collected = "";
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isBinary = isBinaryContentType(contentType) || isBinaryContent(collected);
  const finalUrl = response.url || usedUrl;
  const evidence = formatHttpEvidence({
    method,
    requestedUrl: url,
    usedUrl,
    finalUrl,
    status: response.status,
    statusText: response.statusText,
    attempts,
    bytesRead,
    truncated,
    limit,
    contentType,
    headers: response.headers,
    body: collected,
    isBinary,
    redirectHops,
    lastNetworkError,
  });

  return {
    ok: true,
    output: evidence,
    exitCode: 0,
    truncated,
  };
}

function multiHeader(headers: Headers, name: string): string[] {
  const out: string[] = [];
  headers.forEach((value, key) => {
    if (key.toLowerCase() === name.toLowerCase()) out.push(value);
  });
  return out;
}

/** Headers always kept in evidence (security / fingerprint / cookies). */
const PRIORITY_HEADER_RE =
  /^(set-cookie|server|x-powered-by|x-aspnet|x-generator|x-frame-options|x-content-type-options|x-xss-protection|content-security-policy|content-type|location|www-authenticate|access-control-|strict-transport|referrer-policy|permissions-policy|cross-origin-|cache-control|via|cf-ray|x-request-id|x-amz-|x-served|link|allow|retry-after)$/i;

function formatHttpEvidence(input: {
  method: string;
  requestedUrl: string;
  usedUrl: string;
  finalUrl: string;
  status: number;
  statusText: string;
  attempts: number;
  bytesRead: number;
  truncated: boolean;
  limit: number;
  contentType: string;
  headers: Headers;
  body: string;
  isBinary: boolean;
  redirectHops: RedirectHop[];
  lastNetworkError: unknown;
}): string {
  const lines: string[] = [];
  lines.push(
    `${input.status} ${input.statusText} ${input.method} ${input.finalUrl}`,
  );

  if (input.redirectHops.length > 0) {
    const chain = [
      ...input.redirectHops.map(
        (h) => `${h.status} ${h.url} → ${h.location}`,
      ),
      `${input.status} ${input.finalUrl}`,
    ];
    lines.push(`redirects: ${chain.join(" → ")}`);
    for (const hop of input.redirectHops) {
      if (hop.setCookies.length) {
        lines.push(
          `  hop ${hop.status} set-cookie: ${hop.setCookies.join("; ")}`,
        );
      }
    }
  }

  const metaBits = [
    `attempts=${input.attempts}`,
    `bytes=${input.bytesRead}`,
  ];
  if (input.truncated) metaBits.push(`truncated@${input.limit}`);
  if (input.usedUrl !== input.requestedUrl) metaBits.push(`via=${input.usedUrl}`);
  if (input.requestedUrl !== input.finalUrl && input.redirectHops.length === 0) {
    metaBits.push(`requested=${input.requestedUrl}`);
  }
  lines.push(metaBits.join(" "));

  if (input.finalUrl.startsWith("https:")) {
    lines.push(
      "TLS: leaf cert not captured by http.fetch — use web.fetch with includeTls=true for fingerprint/SAN.",
    );
  }

  // ALL response headers, always — cheap vs body and critical for pentest.
  // Security/fingerprint headers first for scannability; remainder sorted after.
  const allHeaders: Array<[string, string]> = [];
  input.headers.forEach((v, k) => allHeaders.push([k, v]));
  allHeaders.sort(([a], [b]) => a.localeCompare(b));
  const priority: string[] = [];
  const rest: string[] = [];
  for (const [k, v] of allHeaders) {
    const line = `${k}: ${v}`;
    if (PRIORITY_HEADER_RE.test(k)) priority.push(line);
    else rest.push(line);
  }
  lines.push("");
  lines.push("Headers:");
  for (const line of priority) lines.push(line);
  for (const line of rest) lines.push(line);

  const tech = deriveTechHints(input.headers, input.body, input.contentType);
  if (tech) {
    lines.push("");
    lines.push(`Tech hints: ${tech}`);
  }

  if (input.method !== "HEAD") {
    lines.push("");
    lines.push("Body:");
    if (input.isBinary) {
      lines.push(
        `[Binary content (${input.contentType || "unknown content type"}) — raw body suppressed]`,
      );
    } else {
      const ct = input.contentType.toLowerCase();
      const isHtml = ct.includes("html");
      const isJson =
        ct.includes("json") ||
        ct.includes("javascript") ||
        ct.includes("xml") ||
        ct.startsWith("text/");
      // Single representation: readable HTML OR raw text/json — never both.
      let bodyText = isHtml
        ? toReadableText(input.body) || input.body
        : input.body;
      // Error pages: keep status/headers rich, body shorter.
      const isError = input.status >= 400;
      const bodyCap = isError
        ? 3_000
        : isHtml
          ? 6_000
          : isJson
            ? 12_000
            : 8_000;
      // Body is the only intentional truncate — status/headers/redirects stay full.
      if (bodyText.length > bodyCap) {
        bodyText =
          bodyText.slice(0, bodyCap) +
          `\n... (body truncated at ${bodyCap.toLocaleString()} chars — headers/status above are complete; re-fetch with higher maxBytes or page if you need more body)`;
      }
      if (input.truncated && !bodyText.includes("capture truncated")) {
        bodyText += `\n... (wire capture stopped at ${input.limit.toLocaleString()} bytes — raise maxBytes for more body)`;
      }
      lines.push(bodyText || "(empty)");
    }
  }

  if (input.lastNetworkError) {
    const err =
      input.lastNetworkError instanceof Error
        ? input.lastNetworkError.message
        : String(input.lastNetworkError);
    if (err) {
      lines.push("");
      lines.push(`note: earlier network error during retries: ${err}`);
    }
  }

  return lines.join("\n");
}

/** Header-derived stack hints only — never invent products. */
function deriveTechHints(
  headers: Headers,
  body: string,
  contentType: string,
): string {
  const bits: string[] = [];
  const server = headers.get("server");
  if (server) bits.push(`server=${server}`);
  const powered = headers.get("x-powered-by");
  if (powered) bits.push(`x-powered-by=${powered}`);
  const gen = headers.get("x-generator");
  if (gen) bits.push(`x-generator=${gen}`);
  const cookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : multiHeader(headers, "set-cookie");
  if (cookies.length) {
    const names = cookies
      .map((c) => c.split("=")[0]?.trim())
      .filter(Boolean)
      .slice(0, 8);
    if (names.length) bits.push(`cookies=${names.join(",")}`);
  }
  if (contentType) bits.push(`content-type=${contentType.split(";")[0]?.trim()}`);
  // Light path markers from body (safe, non-invented).
  const sample = body.slice(0, 8_000);
  if (/\/_next\//i.test(sample) || /__NEXT_DATA__/i.test(sample)) {
    bits.push("marker=next.js");
  } else if (/wp-content|wordpress/i.test(sample)) {
    bits.push("marker=wordpress");
  } else if (/csrfmiddlewaretoken|django/i.test(sample)) {
    bits.push("marker=django");
  } else if (/react/i.test(sample) && /data-reactroot|__REACT/i.test(sample)) {
    bits.push("marker=react");
  }
  return bits.join("; ");
}

function clampRetries(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RETRIES;
  return Math.max(0, Math.min(5, Math.floor(value)));
}

function retryDelayMs(attempt: number): number {
  return Math.min(250 * 2 ** Math.max(0, attempt - 1), 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drainResponse(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // Best effort only; retrying is more important than draining.
  }
}

function isBinaryContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase().trim();
  if (ct.includes("image/svg+xml")) return false; // SVGs are xml text
  if (
    ct.startsWith("image/") ||
    ct.startsWith("video/") ||
    ct.startsWith("audio/") ||
    ct.startsWith("application/octet-stream") ||
    ct.startsWith("application/zip") ||
    ct.startsWith("application/pdf") ||
    ct.startsWith("application/x-")
  ) {
    return true;
  }
  return false;
}

function isBinaryContent(text: string): boolean {
  const sample = text.slice(0, 2048);
  if (sample.includes("\u0000")) return true;
  let nonPrintableCount = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    // Control chars other than tab (9), lf (10), cr (13)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      nonPrintableCount++;
      if (nonPrintableCount > 5) {
        return true;
      }
    }
  }
  return false;
}
