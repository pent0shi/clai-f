/**
 * Credential management: /set, /unset, /keys, /info (multi-key per provider).
 */

import { getProvider } from "../../../llm/router.js";
import { MAX_PROVIDER_KEYS } from "../../../llm/key-rotation.js";
import {
  assertProvider,
  getProviderInfoText,
  maskSecret,
} from "../../../llm/provider.js";
import { getConfig, updateConfig } from "../../../store/config.js";
import {
  appendSearchProviderKey,
  getProviderKeys,
  getSearchProviderKeys,
  listProviderStatuses,
  setProviderKeys,
  setSearchProviderKeys,
  unsetProviderSecret,
  unsetSearchProviderSecret,
} from "../../../store/keys.js";
import { searchProviderIds, type SearchProviderId } from "../../../tools/web/types.js";
import type { ProviderId } from "../../../types.js";
import { formatKeyStatus, type SearchKeyStatus } from "../../../tui/format-keys.js";
import type { CommandInvocation } from "../../../app/commands/command.js";
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { PickerOption } from "../../rendering/picker-filter.js";

const SEARCH_IDS = new Set(["brave", "tavily", "duckduckgo"]);

function notice(services: AppServices, level: "info" | "warn", text: string): void {
  services.session.notice(level, text);
}

async function getSearchKeyStatuses(): Promise<SearchKeyStatus[]> {
  const activeSearch = getConfig().activeSearchProvider;
  return Promise.all(
    searchProviderIds.map(async (id) => {
      const keyless = id === "duckduckgo";
      const multi = await getSearchProviderKeys(id);
      const count = multi.keys.length;
      const activeIndex = count > 0 ? multi.activeIndex : 0;
      const activeValue = multi.keys[activeIndex]?.value;
      return {
        provider: id,
        active: id === activeSearch,
        configured: keyless || count > 0,
        source: keyless ? "keyless" : multi.source,
        maskedKey: activeValue ? maskSecret(activeValue) : undefined,
        keyCount: keyless ? undefined : count || undefined,
        maskedKeys: count > 0 ? multi.keys.map((key) => maskSecret(key.value)) : undefined,
        activeMaskedKey:
          count > 1 && activeValue ? maskSecret(activeValue) : undefined,
      };
    }),
  );
}

export async function handleInfo(
  services: AppServices,
  invocation: CommandInvocation,
): Promise<void> {
  const providerVal = invocation.args.trim().toLowerCase();
  let target = services.session.getState().provider ?? getConfig().defaultProvider;
  if (providerVal) {
    try {
      target = assertProvider(providerVal);
    } catch {
      notice(services, "warn", `unknown provider: ${providerVal}`);
      return;
    }
  }
  services.overlay.openPager(`${target} Info`, getProviderInfoText(target));
}

export async function handleKeys(services: AppServices): Promise<void> {
  try {
    const active = services.session.getState().provider ?? getConfig().defaultProvider;
    const llm = await listProviderStatuses(active);
    services.overlay.openPager("Credential status", formatKeyStatus(llm, await getSearchKeyStatuses()));
  } catch (error) {
    notice(
      services,
      "warn",
      `could not read keys: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function handleSet(
  services: AppServices,
  invocation: CommandInvocation,
): Promise<void> {
  const parts = invocation.args.split(/\s+/).filter(Boolean);
  const providerVal = parts[0];
  const keyVal = parts[1];

  if (!providerVal) {
    await openSetPicker(services);
    return;
  }

  try {
    if (SEARCH_IDS.has(providerVal)) {
      await setSearchKey(services, providerVal as SearchProviderId, keyVal);
      return;
    }
    const id = assertProvider(providerVal);
    if (keyVal) {
      await appendLlmKey(services, id, keyVal);
      return;
    }
    await openLlmKeysEditor(services, id);
  } catch (error) {
    notice(services, "warn", error instanceof Error ? error.message : String(error));
  }
}

export async function handleUnset(
  services: AppServices,
  invocation: CommandInvocation,
): Promise<void> {
  const providerVal = invocation.args.trim().split(/\s+/)[0];
  if (!providerVal) {
    await openUnsetPicker(services);
    return;
  }
  try {
    if (SEARCH_IDS.has(providerVal)) {
      await unsetSearchKey(services, providerVal as SearchProviderId);
      return;
    }
    await unsetLlmKey(services, assertProvider(providerVal));
  } catch (error) {
    notice(services, "warn", error instanceof Error ? error.message : String(error));
  }
}

async function openSetPicker(services: AppServices): Promise<void> {
  const active = services.session.getState().provider ?? getConfig().defaultProvider;
  const llm = await listProviderStatuses(active);
  const search = await getSearchKeyStatuses();
  const options: PickerOption[] = [
    ...llm.map((status) => {
      const count = status.keyCount ?? (status.configured ? 1 : 0);
      const keyLabel =
        status.provider === "ollama"
          ? status.configured
            ? "✓ host set"
            : "✗ no host"
          : count === 0
            ? "✗ no key"
            : count === 1
              ? `✓ ${status.maskedKey ?? "1 key"}`
              : `✓ ${count} keys`;
      return {
        value: `llm:${status.provider}`,
        label: `${status.provider} ${keyLabel}${status.active ? " (active)" : ""}`,
        description: status.model,
      };
    }),
    ...search.map((status) => {
      const count = status.keyCount ?? 0;
      const keyLabel =
        status.provider === "duckduckgo"
          ? "✓ keyless"
          : count === 0
            ? "✗ no key"
            : count === 1
              ? `✓ ${status.maskedKey ?? "1 key"}`
              : `✓ ${count} keys`;
      return {
        value: `search:${status.provider}`,
        label: `${status.provider} ${keyLabel}${status.active ? " (active)" : ""}`,
        description: "Search provider",
      };
    }),
  ];
  services.overlay.openPicker({ title: "Set API key for provider", options }, (value) => {
    services.overlay.close();
    void (async () => {
      const isSearch = value.startsWith("search:");
      const id = value.split(":")[1]!;
      if (isSearch) await openSearchKeysEditor(services, id as SearchProviderId);
      else await openLlmKeysEditor(services, id as ProviderId);
    })();
  });
}

async function openUnsetPicker(services: AppServices): Promise<void> {
  const active = services.session.getState().provider ?? getConfig().defaultProvider;
  const llm = await listProviderStatuses(active);
  const search = await getSearchKeyStatuses();
  const options: PickerOption[] = [
    ...llm.map((status) => {
      const count = status.keyCount ?? (status.configured ? 1 : 0);
      const keyLabel =
        status.provider === "ollama"
          ? "host (config)"
          : count === 0
            ? "✗ no key"
            : count === 1
              ? `✓ ${status.maskedKey ?? "1 key"}`
              : `✓ ${count} keys — reset all`;
      return {
        value: `llm:${status.provider}`,
        label: `${status.provider} ${keyLabel}${status.active ? " (active)" : ""}`,
        description: status.model,
      };
    }),
    ...search.map((status) => {
      const count = status.keyCount ?? 0;
      const keyLabel =
        status.provider === "duckduckgo"
          ? "keyless"
          : count === 0
            ? "✗ no key"
            : count === 1
              ? `✓ ${status.maskedKey ?? "1 key"}`
              : `✓ ${count} keys — reset all`;
      return {
        value: `search:${status.provider}`,
        label: `${status.provider} ${keyLabel}${status.active ? " (active)" : ""}`,
        description: "Search provider",
      };
    }),
  ];
  services.overlay.openPicker({ title: "Unset API key for provider", options }, (value) => {
    services.overlay.close();
    void (async () => {
      const isSearch = value.startsWith("search:");
      const id = value.split(":")[1]!;
      if (isSearch) await unsetSearchKey(services, id as SearchProviderId);
      else await unsetLlmKey(services, id as ProviderId);
    })();
  });
}

async function openLlmKeysEditor(
  services: AppServices,
  id: ProviderId,
): Promise<void> {
  if (id === "ollama") {
    const host = await services.overlay.openSecret({
      title: "Ollama host URL",
      prompt: "Enter host URL for Ollama:",
    });
    if (!host) {
      notice(services, "info", "cancelled");
      return;
    }
    updateConfig({ ollamaHost: host.trim() });
    notice(services, "info", `saved ollama host → ${host.trim()}`);
    return;
  }

  const multi = await getProviderKeys(id);
  const stored =
    multi.source === "env"
      ? []
      : multi.keys.map((key) => ({ id: key.id, masked: maskSecret(key.value), value: key.value }));

  const answer = await services.overlay.openKeysEditor({
    provider: id,
    initialKeys: stored.map((key) => ({ id: key.id, masked: key.masked })),
  });
  if (!answer) {
    notice(services, "info", "cancelled");
    return;
  }
  if (answer.action === "reset") {
    await unsetProviderSecret(id);
    notice(services, "info", `unset all keys for ${id}`);
    return;
  }

  const byId = new Map(stored.map((key) => [key.id, key.value]));
  const resolved = resolveEditorRows(answer.rows, byId);
  if (resolved.length === 0) {
    await unsetProviderSecret(id);
    notice(services, "info", `unset all keys for ${id}`);
    return;
  }

  const impl = getProvider(id);
  for (const key of resolved) {
    if (!impl.validateKey(key)) {
      notice(services, "warn", `invalid API key format for ${id}`);
      return;
    }
  }
  if (resolved.length > MAX_PROVIDER_KEYS) {
    notice(services, "warn", `at most ${MAX_PROVIDER_KEYS} API keys per provider`);
    return;
  }

  let activeIndex = 0;
  if (multi.source !== "env" && multi.keys.length > 0) {
    const previous = multi.keys[multi.activeIndex]?.value;
    if (previous) {
      const found = resolved.indexOf(previous);
      if (found >= 0) activeIndex = found;
    }
  }

  await setProviderKeys(id, resolved, activeIndex);
  const label = resolved.length === 1 ? maskSecret(resolved[0]!) : `${resolved.length} keys`;
  notice(services, "info", `saved ${id} · ${label}`);
}

async function openSearchKeysEditor(
  services: AppServices,
  id: SearchProviderId,
): Promise<void> {
  if (id === "duckduckgo") {
    notice(services, "info", "duckduckgo is keyless and requires no setup");
    return;
  }

  const multi = await getSearchProviderKeys(id);
  const stored =
    multi.source === "env"
      ? []
      : multi.keys.map((key) => ({ id: key.id, masked: maskSecret(key.value), value: key.value }));
  const answer = await services.overlay.openKeysEditor({
    provider: id,
    initialKeys: stored.map((key) => ({ id: key.id, masked: key.masked })),
  });
  if (!answer) {
    notice(services, "info", "cancelled");
    return;
  }
  if (answer.action === "reset") {
    await unsetSearchProviderSecret(id);
    notice(services, "info", `unset all keys for ${id}`);
    return;
  }

  const resolved = resolveEditorRows(answer.rows, new Map(stored.map((key) => [key.id, key.value])));
  if (resolved.length === 0) {
    await unsetSearchProviderSecret(id);
    notice(services, "info", `unset all keys for ${id}`);
    return;
  }
  if (resolved.length > MAX_PROVIDER_KEYS) {
    notice(services, "warn", `at most ${MAX_PROVIDER_KEYS} API keys per provider`);
    return;
  }

  let activeIndex = 0;
  if (multi.source !== "env" && multi.keys.length > 0) {
    const previous = multi.keys[multi.activeIndex]?.value;
    if (previous) {
      const found = resolved.indexOf(previous);
      if (found >= 0) activeIndex = found;
    }
  }

  await setSearchProviderKeys(id, resolved, activeIndex);
  const label = resolved.length === 1 ? maskSecret(resolved[0]!) : `${resolved.length} keys`;
  notice(services, "info", `saved ${id} · ${label}`);
}

function resolveEditorRows(
  rows: readonly { slotId?: string; value: string }[],
  byId: ReadonlyMap<string, string>,
): string[] {
  const resolved: string[] = [];
  for (const row of rows) {
    if (row.slotId) {
      const value = row.value.trim();
      const keep = value || byId.get(row.slotId);
      if (keep) resolved.push(keep);
    } else if (row.value.trim()) {
      resolved.push(row.value.trim());
    }
  }
  return resolved;
}

async function appendLlmKey(
  services: AppServices,
  id: ProviderId,
  keyVal: string,
): Promise<void> {
  if (id === "ollama") {
    updateConfig({ ollamaHost: keyVal.trim() });
    notice(services, "info", `saved ollama host → ${keyVal.trim()}`);
    return;
  }
  const key = keyVal.trim();
  if (!getProvider(id).validateKey(key)) {
    notice(services, "warn", `invalid API key format for ${id}`);
    return;
  }
  const { appendProviderKey } = await import("../../../store/keys.js");
  await appendProviderKey(id, key);
  const multi = await getProviderKeys(id);
  const count = multi.source === "env" ? 1 : multi.keys.length;
  notice(
    services,
    "info",
    count > 1
      ? `added ${id} ${maskSecret(key)} · ${count} keys total`
      : `saved ${id} ${maskSecret(key)}`,
  );
}

async function setSearchKey(
  services: AppServices,
  id: SearchProviderId,
  keyVal?: string | undefined,
): Promise<void> {
  if (id === "duckduckgo") {
    notice(services, "info", "duckduckgo is keyless and requires no setup");
    return;
  }
  if (!keyVal) {
    await openSearchKeysEditor(services, id);
    return;
  }
  const key = keyVal.trim();
  if (!key) {
    notice(services, "warn", "API key cannot be empty");
    return;
  }
  await appendSearchProviderKey(id, key);
  const multi = await getSearchProviderKeys(id);
  const count = multi.source === "env" ? 1 : multi.keys.length;
  notice(
    services,
    "info",
    count > 1
      ? `added ${id} ${maskSecret(key)} · ${count} keys total`
      : `saved ${id} ${maskSecret(key)}`,
  );
}

async function unsetSearchKey(services: AppServices, id: SearchProviderId): Promise<void> {
  if (id === "duckduckgo") {
    notice(services, "info", "duckduckgo requires no credentials and cannot be unset");
    return;
  }
  const multi = await getSearchProviderKeys(id);
  const storedCount = multi.source === "env" ? 0 : multi.keys.length;
  if (storedCount === 0) {
    notice(services, "warn", `${id} has no key to unset`);
    return;
  }
  await unsetSearchProviderSecret(id);
  notice(
    services,
    "info",
    storedCount > 1 ? `unset all ${storedCount} keys for ${id}` : `unset ${id}`,
  );
}

async function unsetLlmKey(services: AppServices, id: ProviderId): Promise<void> {
  if (id === "ollama") {
    notice(services, "info", "ollama does not store an API key");
    return;
  }
  const multi = await getProviderKeys(id);
  const storedCount = multi.source === "env" ? 0 : multi.keys.length;
  if (storedCount === 0) {
    notice(services, "warn", `${id} has no key to unset`);
    return;
  }
  await unsetProviderSecret(id);
  notice(
    services,
    "info",
    storedCount > 1 ? `unset all ${storedCount} keys for ${id}` : `unset ${id}`,
  );
}
