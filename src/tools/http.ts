import net from "node:net";
import { lookup } from "node:dns/promises";
import type { ToolResult } from "../types.js";
import { isBlockedAddress } from "./web/ssrf-guard.js";
import { toReadableText } from "./web/readable.js";

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_RETRIES = 2;
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

async function resolveHosts(host: string): Promise<string[]> {
  if (net.isIP(host)) return [host];
  try {
    const results = await lookup(host, { all: true });
    return Array.from(new Set(results.map((result) => result.address)));
  } catch {
    return [];
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
  signal?: AbortSignal | undefined;
  authorizeHop?: ((url: string, resolvedAddresses: string[]) => Promise<{ allowed: boolean; reason: string }> | { allowed: boolean; reason: string }) | undefined;
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
    headers.set("user-agent", "clai-http-fetch/1.1");
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
  // Extra retries for local probes (server often not ready on first tick).
  const baseRetries =
    method === "GET" || method === "HEAD"
      ? clampRetries(options.retries ?? DEFAULT_RETRIES)
      : 0;
  const retryLimit = ownedLoopback
    ? Math.max(baseRetries, 4)
    : baseRetries;

  try {
    candidateLoop: for (let ci = 0; ci < urlCandidates.length; ci += 1) {
      const candidateUrl = urlCandidates[ci]!;
      usedUrl = candidateUrl;
      // Fresh attempt counter per candidate, but keep total for the message.
      let localAttempts = 0;
      for (;;) {
        attempts += 1;
        localAttempts += 1;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
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
          for (;;) {
            response = await fetch(requestUrl, {
              ...init,
              signal: controller.signal,
            });
            const location = response.headers.get("location");
            if (!(response.status >= 300 && response.status < 400 && location)) break;
            if (redirects >= 10) throw new Error("Too many redirects (maximum 10)");
            const next = new URL(location, requestUrl);
            const denial = await authorizeDestination(next);
            if (denial) throw new Error(denial);
            await drainResponse(response);
            requestUrl = next.toString();
            redirects += 1;
          }
          if (
            localAttempts <= retryLimit &&
            RETRY_STATUSES.has(response.status)
          ) {
            await drainResponse(response);
            await sleep(retryDelayMs(localAttempts));
            continue;
          }
          // Success for this candidate
          break candidateLoop;
        } catch (error) {
          lastNetworkError = error;
          const isTimeout =
            error instanceof Error &&
            error.name === "AbortError" &&
            !options.signal?.aborted;
          const errMsg = isTimeout
            ? "Request timed out after 15s"
            : error instanceof Error
              ? error.message
              : String(error);
          if (options.signal?.aborted) {
            throw new Error(errMsg);
          }
          // Connection refused on loopback → try next address or retry.
          if (ownedLoopback && isConnectionRefusedError(error)) {
            if (localAttempts <= retryLimit) {
              await sleep(Math.min(400 * localAttempts, 1500));
              continue;
            }
            // Exhausted retries for this host — try next loopback candidate.
            if (ci + 1 < urlCandidates.length) {
              break; // next candidate
            }
            throw new Error(errMsg);
          }
          if (localAttempts > retryLimit) {
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
    // No streaming body (eg HEAD or empty 204). Fall through with empty text.
    collected = "";
  }

  const headerLines: string[] = [];
  response.headers.forEach((v, k) => headerLines.push(`${k}: ${v}`));
  const headerBlock = headerLines.length > 0 ? `Headers:\n${headerLines.join("\n")}\n\n` : "";
  const truncNote = truncated
    ? `\n... (truncated at ${limit.toLocaleString()} bytes)`
    : "";
  const contentType = response.headers.get("content-type") ?? "";
  const isBinary = isBinaryContentType(contentType) || isBinaryContent(collected);
  const displayBody = isBinary
    ? `[Binary content (${contentType || "unknown content type"}) - raw body suppressed]`
    : collected;
  const body = method === "HEAD" ? "" : displayBody;
  const readable =
    method !== "HEAD" && !isBinary && contentType.toLowerCase().includes("html")
      ? toReadableText(collected)
      : "";
  const finalUrl = response.url || usedUrl;
  const meta = {
    requestedUrl: url,
    finalUrl,
    probedUrl: usedUrl !== url ? usedUrl : undefined,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    method,
    attempts,
    retried: attempts > 1,
    headers: Object.fromEntries(
      [...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ),
    contentType,
    bytesRead,
    truncated,
    truncatedAt: truncated ? limit : undefined,
    lastNetworkError:
      lastNetworkError instanceof Error
        ? lastNetworkError.message
        : lastNetworkError
          ? String(lastNetworkError)
          : undefined,
  };
  const evidence = [
    `${response.status} ${response.statusText} ${finalUrl}`,
    `attempts=${attempts} bytes=${bytesRead}${truncated ? ` truncated@${limit}` : ""}${usedUrl !== url ? ` via=${usedUrl}` : ""}`,
    "",
    "Metadata:",
    JSON.stringify(meta, null, 2),
    "",
    headerBlock.trimEnd(),
    readable ? `\nReadable content:\n${readable}\n` : "",
    method === "HEAD" ? "" : `Raw body:\n${body}${truncNote}`,
  ]
    .filter((part) => part !== "")
    .join("\n");

  return {
    ok: true,
    output: evidence,
    exitCode: 0,
    truncated,
  };
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
