import { getConfig, getProviderModel, updateConfig } from "../../store/config.js";
import type { ProviderId } from "../../types.js";

/**
 * Model-window overrides keyed by concrete provider/model pair so a limit
 * never leaks into another route or model. Values persist in config and
 * survive history navigation and restarts; the in-memory map is a write-through
 * cache cleared on session-id change.
 */
export class SessionContextLimits {
  private readonly byTarget = new Map<string, number>();

  get(provider: ProviderId | undefined, model: string | undefined): number | undefined {
    const key = this.key(provider, model);
    const local = this.byTarget.get(key);
    if (local !== undefined) return local;
    const persisted = getConfig().contextLimitTokens?.[key];
    return typeof persisted === "number" && Number.isFinite(persisted) && persisted >= 20_000
      ? Math.floor(persisted)
      : undefined;
  }

  set(
    provider: ProviderId | undefined,
    model: string | undefined,
    limit: number | undefined,
  ): void {
    const key = this.key(provider, model);
    const valid = limit !== undefined && Number.isFinite(limit) && limit >= 20_000;
    if (valid) {
      this.byTarget.set(key, Math.floor(limit));
    } else {
      this.byTarget.delete(key);
    }
    const persisted = { ...(getConfig().contextLimitTokens ?? {}) };
    if (valid) {
      persisted[key] = Math.floor(limit);
    } else {
      delete persisted[key];
    }
    updateConfig({ contextLimitTokens: persisted });
  }

  clear(): void {
    this.byTarget.clear();
  }

  private key(provider: ProviderId | undefined, model: string | undefined): string {
    const config = getConfig();
    const selectedProvider = provider ?? config.defaultProvider;
    const selectedModel = model ?? getProviderModel(selectedProvider);
    return `${selectedProvider}:${selectedModel}`;
  }
}
