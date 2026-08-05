import { getConfig, getProviderModel } from "../../store/config.js";
import type { ProviderId } from "../../types.js";

/**
 * Model-window overrides keyed by concrete provider/model pair so a limit
 * never leaks into another route or model. Session-only: the in-memory map
 * is cleared on session-id change and never persists to config, so a fresh
 * process or a new conversation resets to the default 180k compaction trigger.
 */
export class SessionContextLimits {
  private readonly byTarget = new Map<string, number>();

  get(provider: ProviderId | undefined, model: string | undefined): number | undefined {
    const key = this.key(provider, model);
    const local = this.byTarget.get(key);
    if (local !== undefined) return local;
    return undefined;
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
