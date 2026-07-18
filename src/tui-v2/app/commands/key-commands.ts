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
  getProviderKeys,
  getSearchProviderKey,
  listProviderStatuses,
  setProviderKeys,
  setSecret,
  unsetProviderSecret,
} from "../../../store/keys.js";
import { searchProviderIds, type SearchProviderId } from "../../../tools/web/types.js";
import type { ProviderId } from "../../../types.js";
import { formatKeyStatus } from "../../../tui/format-keys.js";
import type { CommandInvocation } from "../../../app/commands/command.js";
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { PickerOption } from "../../rendering/picker-filter.js";

const SEARCH_IDS = new Set(["brave", "tavily", "duckduckgo"]);

function notice(services: AppServices, level: "info" | "warn", text: string): void {
  services.session.notice(level, text);
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
    const activeSearch = getConfig().activeSearchProvider;
    const search = await Promise.all(
      searchProviderIds.map(async (id) => {
        const secret = await getSearchProviderKey(id);
        const keyless = id === "duckduckgo";
        return {
          provider: id,
          active: id === activeSearch,
          configured: keyless || Boolean(secret.value),
          source: keyless ? "keyless" : secret.source,
          maskedKey: secret.value ? maskSecret(secret.value) : undefined,
        };
      }),
    );
    services.overlay.openPager("Credential status", formatKeyStatus(llm, search));
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
      // Non-interactive append of one key.
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
  const activeSearch = getConfig().activeSearchProvider;
  const search = await Promise.all(
    searchProviderIds.map(async (id) => {
      const secret = await getSearchProviderKey(id);
      const keyless = id === "duckduckgo";
      return {
        provider: id,
        configured: keyless || Boolean(secret.value),
        maskedKey: secret.value ? maskSecret(secret.value) : undefined,
        keyCount: secret.value ? 1 : 0,
      };
    }),
  );
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
    ...search.map((status) => ({
      value: `search:${status.provider}`,
      label: `${status.provider} ${status.configured ? "✓ key set" : "✗ no key"}`,
      description: `Search provider${status.provider === activeSearch ? " (active)" : ""}`,
    })),
  ];
  services.overlay.openPicker({ title: "Set API key for provider", options }, (value) => {
    services.overlay.close();
    void (async () => {
      const isSearch = value.startsWith("search:");
      const id = value.split(":")[1]!;
      if (isSearch) await setSearchKey(services, id as SearchProviderId);
      else await openLlmKeysEditor(services, id as ProviderId);
    })();
  });
}

async function openUnsetPicker(services: AppServices): Promise<void> {
  const active = services.session.getState().provider ?? getConfig().defaultProvider;
  const llm = await listProviderStatuses(active);
  const activeSearch = getConfig().activeSearchProvider;
  const search = await Promise.all(
    searchProviderIds.map(async (id) => {
      const secret = await getSearchProviderKey(id);
      const keyless = id === "duckduckgo";
      return {
        provider: id,
        configured: keyless || Boolean(secret.value),
        maskedKey: secret.value ? maskSecret(secret.value) : undefined,
      };
    }),
  );
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
    ...search.map((status) => ({
      value: `search:${status.provider}`,
      label: `${status.provider} ${status.configured ? `✓ ${status.maskedKey ?? "keyless"}` : "✗ no key"}`,
      description: `Search provider${status.provider === activeSearch ? " (active)" : ""}`,
    })),
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
    let host = await services.overlay.openSecret({
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
      : multi.keys.map((k) => ({ id: k.id, masked: maskSecret(k.value), value: k.value }));

  const answer = await services.overlay.openKeysEditor({
    provider: id,
    initialKeys: stored.map((k) => ({ id: k.id, masked: k.masked })),
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

  // Resolve save rows → final plaintext list.
  const byId = new Map(stored.map((k) => [k.id, k.value]));
  const resolved: string[] = [];
  for (const row of answer.rows) {
    if (row.slotId) {
      if (row.value.trim()) {
        resolved.push(row.value.trim());
      } else {
        const keep = byId.get(row.slotId);
        if (keep) resolved.push(keep);
      }
    } else if (row.value.trim()) {
      resolved.push(row.value.trim());
    }
  }

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

  // Preserve sticky active when possible (first kept slot that matches prior active).
  let activeIndex = 0;
  if (multi.source !== "env" && multi.keys.length > 0) {
    const prevActive = multi.keys[multi.activeIndex]?.value;
    if (prevActive) {
      const found = resolved.indexOf(prevActive);
      if (found >= 0) activeIndex = found;
    }
  }

  await setProviderKeys(id, resolved, activeIndex);
  const label =
    resolved.length === 1
      ? maskSecret(resolved[0]!)
      : `${resolved.length} keys`;
  notice(services, "info", `saved ${id} · ${label}`);
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
  let key = keyVal;
  if (!key) {
    const secret = await getSearchProviderKey(id);
    if (secret.value) {
      const ok = await services.overlay.openConfirm({
        kind: "reset",
        prompt: `${id} already has a key (${maskSecret(secret.value)}). Reset it?`,
      });
      if (!ok) {
        notice(services, "info", "cancelled");
        return;
      }
    }
    key = await services.overlay.openSecret({
      title: `${id} API key`,
      prompt: `Enter API key for ${id}:`,
    });
    if (!key) {
      notice(services, "info", "cancelled");
      return;
    }
  }
  await setSecret("search", id, key.trim());
  notice(services, "info", `saved ${id} ${maskSecret(key.trim())}`);
}

async function unsetSearchKey(services: AppServices, id: SearchProviderId): Promise<void> {
  if (id === "duckduckgo") {
    notice(services, "info", "duckduckgo requires no credentials and cannot be unset");
    return;
  }
  const secret = await getSearchProviderKey(id);
  if (!secret.value) {
    notice(services, "warn", `${id} has no key to unset`);
    return;
  }
  const { unsetSearchProviderKey } = await import("../../../commands/search-providers.js");
  await unsetSearchProviderKey(id);
  notice(services, "info", `unset ${id}`);
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
