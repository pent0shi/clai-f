import Conf from "conf";
import { dirname } from "node:path";
import type { Mode, ProviderId, ReasoningPreference } from "../types.js";
import type { SearchProviderId } from "../tools/web/types.js";
import { defaultModels, sanitizeProviderModel } from "../llm/provider.js";
import { safeCwd } from "../os/cwd.js";
import { fixOwnerSync, handlePermissionError } from "../os/permissions.js";

export type ProviderCategory = "local" | "free-cloud" | "paid-cloud";

export interface ClaiConfig {
  defaultProvider: ProviderId;
  defaultModel: string;
  defaultMode: Mode;
  providerModels: Partial<Record<ProviderId, string>>;
  allowAlwaysTools: string[];
  pentestAuthorized: boolean;
  sandboxRoots: string[];
  ollamaHost: string;
  telemetry: boolean;
  lastUpdateCheck: number;
  thinking: ReasoningPreference;
  /** When true, exclude paid-cloud providers from the fallback chain. */
  freeOnly: boolean;
  /** When true, try other configured providers after the selected provider fails. */
  providerFallback: boolean;
  /** When true, suppress non-essential outbound calls (update check). */
  offline: boolean;
  /** When true, the agent only accepts ```tool / XML / Kimi sentinel tool calls. */
  parserStrict: boolean;
  /** When true, suppress writing chat history (in-memory only). */
  privateMode: boolean;
  /** Max number of session records kept in JSONL history (0 = unlimited). */
  historyRetentionLimit: number;
  /** When true, fs.read/list/search must stay within sandboxRoots ∪ {cwd, $HOME}. */
  sandboxReads: boolean;
  /** Active search provider used by the web.search tool. */
  activeSearchProvider: SearchProviderId;
  /** When true, bypass the OS keychain and always use plaintext file storage. */
  disableKeychain: boolean;
  /** Permissions mode for auto-confirming tool calls ("default" or "allow-all"). */
  permissions?: "default" | "allow-all";
  /**
   * Tool calling protocol:
   * - auto (default): native when dialect supports it, text fallback otherwise
   * - native: prefer native; still text-fallback on tools-unsupported
   * - text: force legacy fenced tool protocol
   */
  toolCalling?: "auto" | "native" | "text";

  // --- Reliability experiments (audit E1–E6); defaults are safe/on ---

  /** E1: auto-compact at softCompactTokenBudget before the hard 100k ceiling. */
  softEarlyCompact?: boolean;
  /** E1: soft auto-compact trigger (tokens). Clamped to ≤ hard budget. */
  softCompactTokenBudget?: number;
  /** E2: max chars of fs.read/list/search body kept in model context (full on disk). */
  fsPassthroughCapChars?: number;
  /** E3: lower maxTokens on tool steps vs legacy 32k fixed. */
  adaptiveMaxTokens?: boolean;
  /** E4: advisory notices for free-cloud + large context / repeated failures. */
  freeTierContextGuard?: boolean;
  /** E4: token estimate that triggers a free-tier large-context notice. */
  freeTierWarnTokens?: number;
  /** E4: consecutive free-tier failures before a stronger switch-model notice. */
  freeTierFailThreshold?: number;
  /** E5: collapse identical tool result bodies within a turn to a pointer. */
  toolResultDedup?: boolean;
  /** E6: omit long fence-protocol tool encyclopedia when native tools are active. */
  slimNativePrompt?: boolean;
}

/**
 * Best-effort classification for the built-in providers. Some "free-cloud"
 * providers have paid tiers too — the label reflects what the default keys
 * usually buy you. Users who set up paid OpenAI/Anthropic keys can flip
 * freeOnly off to opt back into them.
 */
export const providerCategory: Record<ProviderId, ProviderCategory> = {
  groq: "free-cloud",
  gemini: "free-cloud",
  openrouter: "free-cloud",
  nvidia: "free-cloud",
  ollama: "local",
  openai: "paid-cloud",
  anthropic: "paid-cloud",
  agentrouter: "paid-cloud",
  kimchi: "free-cloud",
  "aws-mantle": "paid-cloud",
  bynara: "free-cloud",
  "qwen-cloud": "paid-cloud",
};

const defaults: ClaiConfig = {
  defaultProvider: "nvidia",
  defaultModel: defaultModels.nvidia,
  defaultMode: "ask",
  providerModels: {},
  allowAlwaysTools: [],
  pentestAuthorized: false,
  sandboxRoots: [safeCwd()],
  ollamaHost: "http://localhost:11434",
  telemetry: false,
  lastUpdateCheck: 0,
  thinking: { enabled: false, effort: "medium" },
  freeOnly: false,
  providerFallback: false,
  offline: false,
  parserStrict: false,
  privateMode: false,
  // 0 = unlimited. A low cap used to hard-delete older chats on every
  // autosave (slice-and-rewrite), which wiped classic clai history.
  historyRetentionLimit: 0,
  sandboxReads: false,
  activeSearchProvider: "duckduckgo",
  disableKeychain: false,
  permissions: "default",
  toolCalling: "auto",
  softEarlyCompact: true,
  softCompactTokenBudget: 70_000,
  fsPassthroughCapChars: 64_000,
  adaptiveMaxTokens: true,
  freeTierContextGuard: true,
  freeTierWarnTokens: 40_000,
  freeTierFailThreshold: 2,
  toolResultDedup: true,
  slimNativePrompt: true,
};

const store = (() => {
  try {
    const s = new Conf<ClaiConfig>({
      projectName: "clai",
      ...(process.env.CLAI_CONFIG_DIR ? { cwd: process.env.CLAI_CONFIG_DIR } : {}),
      defaults,
    });
    const dir = dirname(s.path);
    fixOwnerSync(dir);
    fixOwnerSync(s.path);
    return s;
  } catch (err: any) {
    handlePermissionError(err);
  }
})();

export function getConfig(): ClaiConfig {
  const current = store.store;
  const providerModels: Partial<Record<ProviderId, string>> = {};
  for (const [provider, model] of Object.entries(current.providerModels ?? {}) as Array<
    [ProviderId, string]
  >) {
    providerModels[provider] = sanitizeProviderModel(provider, model);
  }
  return {
    ...current,
    defaultModel: sanitizeProviderModel(
      current.defaultProvider,
      current.defaultModel,
    ),
    providerModels,
  };
}

export function updateConfig(patch: Partial<ClaiConfig>): ClaiConfig {
  const next = { ...getConfig(), ...patch } satisfies ClaiConfig;
  try {
    store.set(next);
    fixOwnerSync(store.path);
  } catch (err: any) {
    handlePermissionError(err);
  }
  return getConfig();
}

export function setDefaultProvider(provider: ProviderId): ClaiConfig {
  const model = getProviderModel(provider);
  return updateConfig({ defaultProvider: provider, defaultModel: model });
}

export function setDefaultMode(mode: Mode): ClaiConfig {
  return updateConfig({ defaultMode: mode });
}

export function setProviderModel(
  provider: ProviderId,
  model: string,
): ClaiConfig {
  const current = getConfig();
  const sanitized = sanitizeProviderModel(provider, model);
  const providerModels = { ...current.providerModels, [provider]: sanitized };
  return updateConfig({ providerModels, defaultModel: sanitized });
}

export function getProviderModel(provider: ProviderId): string {
  const configured = getConfig().providerModels[provider];
  return configured
    ? sanitizeProviderModel(provider, configured)
    : defaultModels[provider];
}

export function getConfigPath(): string {
  return store.path;
}

export function setThinking(patch: Partial<ReasoningPreference>): ClaiConfig {
  const current = getConfig().thinking;
  const next: ReasoningPreference = {
    enabled: patch.enabled ?? current.enabled,
    effort: patch.effort ?? current.effort,
  };
  return updateConfig({ thinking: next });
}

export function getActiveSearchProvider(): SearchProviderId {
  return getConfig().activeSearchProvider;
}

export function setActiveSearchProvider(id: SearchProviderId): ClaiConfig {
  return updateConfig({ activeSearchProvider: id });
}
