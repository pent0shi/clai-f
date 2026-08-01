import { getConfig, getProviderModel } from "../../store/config.js";
import type { ProviderId } from "../../types.js";

/**
 * Session-local model-window overrides. Keys are concrete provider/model pairs
 * so a limit never leaks into another route, model, or resumed session.
 */
export class SessionContextLimits {
  private readonly byTarget = new Map<string, number>();

  get(provider: ProviderId | undefined, model: string | undefined): number | undefined {
    return this.byTarget.get(this.key(provider, model));
  }

  set(
    provider: ProviderId | undefined,
    model: string | undefined,
    limit: number | undefined,
  ): void {
    const key = this.key(provider, model);
    if (limit === undefined || !Number.isFinite(limit) || limit < 20_000) {
      this.byTarget.delete(key);
      return;
    }
    this.byTarget.set(key, Math.floor(limit));
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
