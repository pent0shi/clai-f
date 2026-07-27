import { getConfig, hasExplicitConfigKey } from "../store/config.js";
import { modelContextWindow } from "../llm/token-usage.js";
import type { ProviderId } from "../types.js";

// One authoritative auto-compaction policy, expressed in total estimated
// request tokens (system blocks, history, tool protocol, schemas and media
// together) rather than in transcript size. Behaviour, status line and
// reliability policy all read this module so they cannot disagree.
export const DEFAULT_AUTO_COMPACT_REQUEST_TOKENS = 120_000;

// Never trigger below this: compaction itself needs room to be useful.
export const MIN_AUTO_COMPACT_REQUEST_TOKENS = 20_000;

// Output allowance reserved inside the model window before the trigger.
export const RESERVED_OUTPUT_TOKENS = 24_576;

// Slack for wire overhead the estimator cannot see exactly.
export const SAFETY_MARGIN_TOKENS = 2_048;

export type RequestBudgetSource = "explicit" | "legacy" | "default";

export interface RequestBudget {
  // User-configured (or default) trigger, before model clamping.
  readonly configured: number;
  // Largest trigger this provider/model can serve safely.
  readonly modelSafe: number;
  // The trigger actually applied: `min(configured, modelSafe)`.
  readonly effectiveTrigger: number;
  // Where `configured` came from, for diagnostics and migration notices.
  readonly source: RequestBudgetSource;
  // True when the model window, not the configuration, is the binding limit.
  readonly clampedByModel: boolean;
}

// Resolve the configured trigger. An explicit new-style value wins; a raw
// persisted legacy value is honoured exactly once (even 72k) so upgrading does
// not silently change a user's tuning; otherwise the 80k policy applies.
export function configuredRequestTokens(): {
  tokens: number;
  source: RequestBudgetSource;
} {
  const config = getConfig();
  if (
    hasExplicitConfigKey("autoCompactRequestTokens") &&
    typeof config.autoCompactRequestTokens === "number"
  ) {
    return { tokens: config.autoCompactRequestTokens, source: "explicit" };
  }
  if (
    hasExplicitConfigKey("softCompactTokenBudget") &&
    typeof config.softCompactTokenBudget === "number"
  ) {
    return { tokens: config.softCompactTokenBudget, source: "legacy" };
  }
  return {
    tokens: DEFAULT_AUTO_COMPACT_REQUEST_TOKENS,
    source: "default",
  };
}

// Largest request this provider/model can accept with room for the answer.
export function modelSafeRequestTokens(
  provider: ProviderId | undefined,
  model: string | undefined,
): number {
  const window = modelContextWindow(model, provider);
  return Math.max(
    MIN_AUTO_COMPACT_REQUEST_TOKENS,
    window - RESERVED_OUTPUT_TOKENS - SAFETY_MARGIN_TOKENS,
  );
}

export function resolveRequestBudget(input?: {
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
  readonly overrideTokens?: number | undefined;
}): RequestBudget {
  const resolved = configuredRequestTokens();
  const raw = input?.overrideTokens ?? resolved.tokens;
  const configured = Math.max(MIN_AUTO_COMPACT_REQUEST_TOKENS, raw);
  const modelSafe = modelSafeRequestTokens(input?.provider, input?.model);
  const effectiveTrigger = Math.min(configured, modelSafe);
  return {
    configured,
    modelSafe,
    effectiveTrigger,
    source: input?.overrideTokens === undefined ? resolved.source : "explicit",
    clampedByModel: modelSafe < configured,
  };
}

// Status/footer denominator: the request budget that actually governs the next
// request, not the raw model window.
export function requestBudgetDenominator(
  provider: ProviderId | undefined,
  model: string | undefined,
): number {
  return resolveRequestBudget({
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  }).effectiveTrigger;
}
