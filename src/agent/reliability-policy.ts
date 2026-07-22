/**
 * Reliability experiments from the architecture audit (E1–E6).
 *
 * Defaults are capability-preserving: they reduce unnecessary context / fragile
 * free-tier overload without hard-truncating critical evidence or blocking free
 * users. Every knob is config-backed and can be disabled independently.
 */

import { createHash } from "node:crypto";
import { getConfig, providerCategory } from "../store/config.js";
import type { ProviderId } from "../types.js";
import { AUTO_COMPACT_TOKEN_BUDGET } from "./context-manager.js";

/** Hard auto-compact ceiling — never raise soft past this. */
export const HARD_COMPACT_TOKEN_BUDGET = AUTO_COMPACT_TOKEN_BUDGET;

/** E1 default: auto-compact trigger. Fires at ~72k estimated tokens (soft
 * path, on by default); the hard ceiling stays at HARD_COMPACT_TOKEN_BUDGET.
 * Lower further via config/env for earlier compaction. */
export const DEFAULT_SOFT_COMPACT_TOKEN_BUDGET = 72_000;

/** E2 default fs passthrough (was 400k). Full body always on disk when truncated. */
export const DEFAULT_FS_PASSTHROUGH_CAP_CHARS = 64_000;

/** E4: warn when free-cloud context is this large. */
export const DEFAULT_FREE_TIER_WARN_TOKENS = 40_000;

/** E4: stronger notice after this many consecutive free-tier stream failures. */
export const DEFAULT_FREE_TIER_FAIL_THRESHOLD = 2;

/** E3 floors — large enough for fs.write / salvage, lower than prior 32k default. */
export const ADAPTIVE_MAX_TOKENS_TOOL_STEP = 24_576;
export const ADAPTIVE_MAX_TOKENS_LIGHT = 12_288;
export const ADAPTIVE_MAX_TOKENS_FLOOR = 8_192;
export const LEGACY_MAX_TOKENS = 32_768;

export interface ReliabilityPolicy {
  readonly softEarlyCompact: boolean;
  readonly softCompactTokenBudget: number;
  readonly hardCompactTokenBudget: number;
  readonly fsPassthroughCapChars: number;
  readonly adaptiveMaxTokens: boolean;
  readonly freeTierContextGuard: boolean;
  readonly freeTierWarnTokens: number;
  readonly freeTierFailThreshold: number;
  readonly toolResultDedup: boolean;
  readonly slimNativePrompt: boolean;
}

function boolEnv(name: string): boolean | undefined {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === undefined || v === "") return undefined;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

function intEnv(name: string): number | undefined {
  const v = process.env[name]?.trim();
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Resolve effective policy from config + optional env overrides. */
export function getReliabilityPolicy(): ReliabilityPolicy {
  const cfg = getConfig();
  const softEarly =
    boolEnv("CLAI_SOFT_EARLY_COMPACT") ?? cfg.softEarlyCompact ?? true;
  let softBudget =
    intEnv("CLAI_SOFT_COMPACT_TOKENS") ??
    cfg.softCompactTokenBudget ??
    DEFAULT_SOFT_COMPACT_TOKEN_BUDGET;
  softBudget = Math.max(20_000, Math.min(softBudget, HARD_COMPACT_TOKEN_BUDGET));

  let fsCap =
    intEnv("CLAI_FS_PASSTHROUGH_CHARS") ??
    cfg.fsPassthroughCapChars ??
    DEFAULT_FS_PASSTHROUGH_CAP_CHARS;
  fsCap = Math.max(8_000, Math.min(fsCap, 400_000));

  return {
    softEarlyCompact: softEarly,
    softCompactTokenBudget: softBudget,
    hardCompactTokenBudget: HARD_COMPACT_TOKEN_BUDGET,
    fsPassthroughCapChars: fsCap,
    adaptiveMaxTokens:
      boolEnv("CLAI_ADAPTIVE_MAX_TOKENS") ?? cfg.adaptiveMaxTokens ?? true,
    freeTierContextGuard:
      boolEnv("CLAI_FREE_TIER_GUARD") ?? cfg.freeTierContextGuard ?? true,
    freeTierWarnTokens:
      intEnv("CLAI_FREE_TIER_WARN_TOKENS") ??
      cfg.freeTierWarnTokens ??
      DEFAULT_FREE_TIER_WARN_TOKENS,
    freeTierFailThreshold:
      intEnv("CLAI_FREE_TIER_FAIL_THRESHOLD") ??
      cfg.freeTierFailThreshold ??
      DEFAULT_FREE_TIER_FAIL_THRESHOLD,
    toolResultDedup:
      boolEnv("CLAI_TOOL_RESULT_DEDUP") ?? cfg.toolResultDedup ?? true,
    slimNativePrompt:
      boolEnv("CLAI_SLIM_NATIVE_PROMPT") ?? cfg.slimNativePrompt ?? true,
  };
}

/**
 * E1: token threshold that triggers auto-compact.
 * Soft path fires earlier; hard budget is always the ceiling used when soft is off.
 */
export function autoCompactTriggerTokens(policy = getReliabilityPolicy()): number {
  if (!policy.softEarlyCompact) return policy.hardCompactTokenBudget;
  return Math.min(
    policy.softCompactTokenBudget,
    policy.hardCompactTokenBudget,
  );
}

/**
 * E3: max completion tokens for a model step.
 * Tool-heavy steps keep room for large writes; light steps use a lower cap.
 * Never goes below {@link ADAPTIVE_MAX_TOKENS_FLOOR}.
 */
export function resolveStepMaxTokens(input: {
  nativeToolsActive: boolean;
  toolsAttached: boolean;
  recoveryNudge?: boolean | undefined;
  policy?: ReliabilityPolicy | undefined;
}): number {
  const policy = input.policy ?? getReliabilityPolicy();
  if (!policy.adaptiveMaxTokens) return LEGACY_MAX_TOKENS;
  if (input.recoveryNudge) {
    return Math.max(ADAPTIVE_MAX_TOKENS_FLOOR, ADAPTIVE_MAX_TOKENS_LIGHT);
  }
  if (input.toolsAttached || input.nativeToolsActive) {
    return ADAPTIVE_MAX_TOKENS_TOOL_STEP;
  }
  return ADAPTIVE_MAX_TOKENS_LIGHT;
}

export function isFreeCloudProvider(provider: ProviderId): boolean {
  return providerCategory[provider] === "free-cloud";
}

/**
 * E4: advisory notices for free-tier + large context / repeated failures.
 * Never blocks the request.
 */
export function freeTierGuardNotices(input: {
  provider: ProviderId;
  estimatedInputTokens: number;
  consecutiveFailures: number;
  policy?: ReliabilityPolicy | undefined;
}): string[] {
  const policy = input.policy ?? getReliabilityPolicy();
  if (!policy.freeTierContextGuard) return [];
  if (!isFreeCloudProvider(input.provider)) return [];
  const notices: string[] = [];
  if (input.estimatedInputTokens >= policy.freeTierWarnTokens) {
    notices.push(
      `Large context (~${input.estimatedInputTokens.toLocaleString()} tokens) on free-cloud model — disconnects and empty admissions are more common. Prefer /compact, a paid/local model, or shorter turns if this fails.`,
    );
  }
  if (input.consecutiveFailures >= policy.freeTierFailThreshold) {
    notices.push(
      `Free-cloud model failed ${input.consecutiveFailures} time(s) this turn. Switch with /model or /provider, or enable providerFallback for automatic recovery.`,
    );
  }
  return notices;
}

/** Stable hash for E5 tool-result dedup (content only). */
export function hashToolResultContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * E5: if identical tool output already appeared this turn, replace with a
 * pointer so history does not grow with duplicate dumps. Full text remains
 * available via artifact path when present.
 */
export function dedupeToolContextOutput(input: {
  content: string;
  toolName: string;
  artifactPath?: string | undefined;
  seenHashes: Map<string, { toolName: string; count: number }>;
  policy?: ReliabilityPolicy | undefined;
}): { content: string; deduped: boolean; hash: string } {
  const policy = input.policy ?? getReliabilityPolicy();
  const hash = hashToolResultContent(input.content);
  if (!policy.toolResultDedup) {
    return { content: input.content, deduped: false, hash };
  }
  // Tiny results are not worth pointer indirection.
  if (input.content.length < 400) {
    input.seenHashes.set(hash, {
      toolName: input.toolName,
      count: (input.seenHashes.get(hash)?.count ?? 0) + 1,
    });
    return { content: input.content, deduped: false, hash };
  }
  const prior = input.seenHashes.get(hash);
  if (!prior) {
    input.seenHashes.set(hash, { toolName: input.toolName, count: 1 });
    return { content: input.content, deduped: false, hash };
  }
  prior.count += 1;
  const artifact = input.artifactPath
    ? ` Full output: ${input.artifactPath}`
    : "";
  const head = input.content.slice(0, 200).replace(/\s+/g, " ").trim();
  const content =
    `[duplicate tool output — identical to earlier ${prior.toolName} this turn; hash=${hash}]${artifact}\n` +
    `Preview: ${head}${input.content.length > 200 ? "…" : ""}\n` +
    `Re-read the prior tool result or artifact if you need the full body; do not assume it changed.`;
  return { content, deduped: true, hash };
}
