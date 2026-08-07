import { getConfig, getProviderModel, updateConfig } from "../../store/config.js";
import type { ProviderId } from "../../types.js";

const MIN_CONTEXT_LIMIT_TOKENS = 20_000;

export class SessionContextLimits {
  get(provider: ProviderId | undefined, model: string | undefined): number | undefined {
    const value = getConfig().contextLimitTokens?.[this.key(provider, model)];
    return this.isValid(value) ? Math.floor(value) : undefined;
  }

  set(
    provider: ProviderId | undefined,
    model: string | undefined,
    limit: number | undefined,
  ): void {
    const key = this.key(provider, model);
    const config = getConfig();
    const contextLimitTokens = { ...(config.contextLimitTokens ?? {}) };
    if (this.isValid(limit)) {
      contextLimitTokens[key] = Math.floor(limit);
    } else {
      delete contextLimitTokens[key];
    }
    updateConfig({ contextLimitTokens });
  }

  clear(): void {
    updateConfig({ contextLimitTokens: {} });
  }

  private isValid(value: unknown): value is number {
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= MIN_CONTEXT_LIMIT_TOKENS
    );
  }

  private key(provider: ProviderId | undefined, model: string | undefined): string {
    const config = getConfig();
    const selectedProvider = provider ?? config.defaultProvider;
    const selectedModel = model ?? getProviderModel(selectedProvider);
    return `${selectedProvider}:${selectedModel}`;
  }
}
