import type { ProviderStatus } from "../types.js";

export interface SearchKeyStatus {
  provider: string;
  active: boolean;
  configured: boolean;
  source: string;
  maskedKey?: string | undefined;
}

/** Render credential metadata without ever including an unmasked secret. */
export function formatKeyStatus(llm: ProviderStatus[], search: SearchKeyStatus[]): string {
  const header = "  PROVIDER      SOURCE    KEYS          MODEL";

  const llmRows: string[] = [];
  for (const s of llm) {
    const mark = s.configured ? "✓" : "✗";
    const tag = s.active ? " ◀" : "";
    const count = s.keyCount ?? (s.maskedKey ? 1 : 0);
    const keySummary =
      s.provider === "ollama"
        ? s.note
          ? s.note
          : "local"
        : count === 0
          ? "—"
          : count === 1
            ? s.maskedKey || "••••••••"
            : `${count} keys`;
    const source = (s.source === "missing" ? "no key" : s.source).padEnd(9);
    llmRows.push(
      `  ${mark} ${s.provider.padEnd(13)} ${source} ${String(keySummary).padEnd(13)} ${s.model}${tag}`,
    );
    if (s.maskedKeys && s.maskedKeys.length > 1) {
      let activeIdx = 0;
      if (s.activeMaskedKey) {
        const found = s.maskedKeys.indexOf(s.activeMaskedKey);
        if (found >= 0) activeIdx = found;
      }
      s.maskedKeys.forEach((masked, i) => {
        llmRows.push(
          `      [${i + 1}] ${masked}${i === activeIdx ? " ★ active" : ""}`,
        );
      });
    }
  }

  const searchRows = search.map((s) => {
    const mark = s.configured ? "✓" : "✗";
    const tag = s.active ? " ◀" : "";
    const key = s.maskedKey || (s.configured ? "••••••••" : "—");
    return `  ${mark} ${s.provider.padEnd(13)} ${(s.source === "missing" ? "no key" : s.source).padEnd(9)} ${key}${tag}`;
  });

  return [
    "LLM PROVIDERS",
    header,
    ...llmRows,
    "",
    "SEARCH PROVIDERS",
    "  PROVIDER      SOURCE    KEY",
    ...searchRows,
    "",
    "◀ = active provider · ★ = sticky key used first on the next request",
    "Use /set to manage multi-keys · /unset clears all keys for a provider.",
  ].join("\n");
}
