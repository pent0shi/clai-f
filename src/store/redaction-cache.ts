import { redactSecrets } from "../llm/provider.js";

const MAX_ENTRIES = 1_024;
const MAX_CACHED_CHARS = 8_000_000;
const MIN_CACHED_LENGTH = 32;

const cache = new Map<string, string>();
let cachedChars = 0;
let hits = 0;
let misses = 0;

function evictUntilWithinBudget(): void {
  while (
    (cache.size > MAX_ENTRIES || cachedChars > MAX_CACHED_CHARS) &&
    cache.size > 0
  ) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const value = cache.get(oldest.value);
    cache.delete(oldest.value);
    cachedChars -= oldest.value.length + (value?.length ?? 0);
  }
}

/**
 * Redaction is pure, so identical persisted text never needs a second regex
 * pass. Autosaves resend the same closed transcript items every turn, which is
 * where the repeated whole-transcript scrub cost came from.
 */
export function redactSecretsCached(text: string): string {
  if (text.length < MIN_CACHED_LENGTH) return redactSecrets(text);
  const cached = cache.get(text);
  if (cached !== undefined) {
    hits += 1;
    cache.delete(text);
    cache.set(text, cached);
    return cached;
  }
  misses += 1;
  const redacted = redactSecrets(text);
  cache.set(text, redacted);
  cachedChars += text.length + redacted.length;
  evictUntilWithinBudget();
  return redacted;
}

export function redactionCacheStats(): {
  hits: number;
  misses: number;
  entries: number;
} {
  return { hits, misses, entries: cache.size };
}

export function resetRedactionCache(): void {
  cache.clear();
  cachedChars = 0;
  hits = 0;
  misses = 0;
}
