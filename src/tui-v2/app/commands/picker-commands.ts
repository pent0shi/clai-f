/**
 * Picker-backed slash commands: model/provider/search/reasoning/history/
 * permissions/output/plan (V2-072, V2-080).
 */

import { getProvider, providerAuth } from "../../../llm/router.js";
import { defaultModels } from "../../../llm/provider.js";
import { modelSupportsThinking } from "../../../llm/capabilities.js";
import { assertProvider } from "../../../llm/provider.js";
import { assertSearchProvider } from "../../../tools/web/providers/provider.js";
import { searchProviders } from "../../../tools/web/providers/provider.js";
import { searchProviderIds, type SearchProviderId } from "../../../tools/web/types.js";
import { providerIds, type ProviderId, type ReasoningEffort } from "../../../types.js";
import { getKnownModels } from "../../../repl/slash-commands.js";
import { clearActiveProjectRoot } from "../../../agent/project-root.js";
import {
  getConfig,
  getProviderModel,
  setActiveSearchProvider,
  setDefaultProvider,
  setProviderModel,
  setThinking,
  updateConfig,
} from "../../../store/config.js";
import {
  envValue,
  getProviderSecret,
  getSearchProviderKey,
  setProviderSecret,
  setSecret,
} from "../../../store/keys.js";
import {
  getSession,
  listSessions,
  recoverOrphanedHistory,
} from "../../../store/history.js";
import { relativeTime, shortCwd } from "../../../tui/text-format.js";
import { conversationItemCount } from "../../state/transcript-types.js";
import {
  hydrateSessionVisual,
  transcriptLooksIncomplete,
} from "../../state/transcript-hydrate.js";
import type { CommandInvocation } from "../../../app/commands/command.js";
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { PickerOption } from "../../rendering/picker-filter.js";
import { openToolOutputPager } from "../../rendering/open-tool-output.js";

const REASONING_DESCRIPTIONS: Record<string, string> = {
  off: "disable reasoning",
  minimal: "lowest latency",
  low: "light reasoning",
  medium: "balanced",
  high: "deep reasoning",
  xhigh: "maximum depth",
};

/**
 * Live provider model catalogue (matches classic TUI `/model`).
 * Prefers `provider.listModels`; falls back to the static known list.
 */
export async function resolveModelsForProvider(
  provider: ProviderId,
  currentModel?: string | undefined,
): Promise<{ models: string[]; source: "live" | "known"; error?: string }> {
  const providerImpl = getProvider(provider);
  let models: string[] = [];
  let error: string | undefined;

  if (providerImpl.listModels) {
    try {
      const auth = await providerAuth(provider);
      models = await providerImpl.listModels(auth);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  let source: "live" | "known" = "live";
  if (models.length === 0) {
    models = getKnownModels(provider);
    source = "known";
  }

  if (currentModel && !models.includes(currentModel)) {
    models = [currentModel, ...models];
  }
  return error ? { models, source, error } : { models, source };
}

export async function handleModel(
  services: AppServices,
  invocation: CommandInvocation,
): Promise<void> {
  const state = services.session.getState();
  const provider = state.provider ?? getConfig().defaultProvider;
  const arg = invocation.args.trim();
  if (arg && arg !== "list" && arg !== "ls") {
    applyModel(services, provider, arg, getKnownModels(provider));
    return;
  }

  services.session.notice("info", `fetching ${provider} models…`);
  const { models, source, error } = await resolveModelsForProvider(provider, state.model);
  if (error) {
    services.session.notice(
      "warn",
      `could not refresh ${provider} models: ${error} · showing known models`,
    );
  } else if (source === "known" && getProvider(provider).listModels) {
    services.session.notice(
      "warn",
      `${provider} model list empty from API · showing known models`,
    );
  } else if (source === "live") {
    services.session.notice("info", `${provider} · ${models.length} models (live)`);
  }

  if (models.length === 0) {
    services.session.notice(
      "info",
      `no models for ${provider} — type /model <name> to set one manually`,
    );
    return;
  }

  services.overlay.openPicker(
    {
      title: `Models · ${provider}${source === "live" ? " · live" : ""}`,
      options: models.map((value) => ({
        value,
        label: value,
        active: value === state.model,
      })),
    },
    (value) => {
      applyModel(services, provider, value, models);
      services.overlay.close();
    },
  );
}

function applyModel(
  services: AppServices,
  provider: ProviderId,
  model: string,
  options: readonly string[] = getKnownModels(provider),
): void {
  const index = Number.parseInt(model, 10);
  const next =
    Number.isInteger(index) && index >= 1 && index <= options.length
      ? options[index - 1]!
      : model;
  services.session.setModel(next);
  setProviderModel(provider, next);
  services.session.notice("info", `model → ${next}`);
}

export function handleProvider(services: AppServices, invocation: CommandInvocation): void {
  if (invocation.args) {
    try {
      void activateProvider(services, assertProvider(invocation.args.trim()));
    } catch {
      services.session.notice("warn", `unknown provider: ${invocation.args.trim()}`);
    }
    return;
  }
  const current = services.session.getState().provider ?? getConfig().defaultProvider;
  // Classic parity: each provider row shows its configured model (green in UI).
  const options: PickerOption[] = providerIds.map((value) => ({
    value,
    label: value,
    description: getProviderModel(value),
    active: value === current,
  }));
  services.overlay.openPicker(
    {
      title: "Providers",
      // Search provider name + model name.
      searchDescription: true,
      options,
    },
    (value) => {
      void activateProvider(services, assertProvider(value));
    },
  );
}

async function activateProvider(services: AppServices, next: ProviderId): Promise<void> {
  const configured =
    next === "ollama" || Boolean(envValue(next)) || Boolean((await getProviderSecret(next)).value);
  if (!configured) {
    services.overlay.close();
    const key = await services.overlay.openSecret({
      title: `${next} API key`,
      prompt: `No API key is configured for ${next}. Enter it now to activate this provider.`,
    });
    if (!key || !getProvider(next).validateKey(key.trim())) return;
    await setProviderSecret(next, key.trim());
  }
  const model = getConfig().providerModels[next] ?? defaultModels[next];
  setDefaultProvider(next);
  services.session.setProvider(next);
  services.session.setModel(model);
  services.overlay.close();
  services.session.notice("info", `provider → ${next} · model → ${model}`);
}

export function handleSearch(services: AppServices, invocation: CommandInvocation): void {
  if (invocation.args) {
    try {
      void activateSearchProvider(services, assertSearchProvider(invocation.args.trim()));
    } catch {
      services.session.notice("warn", `unknown search provider: ${invocation.args.trim()}`);
    }
    return;
  }
  const active = getConfig().activeSearchProvider;
  const options: PickerOption[] = searchProviderIds.map((id) => {
    const adapter = searchProviders[id];
    return {
      value: id,
      label: id === active ? `${id} · active` : id,
      description: adapter?.needsApiKey
        ? `${adapter.displayName} · API key required`
        : `${adapter?.displayName ?? id} · keyless`,
    };
  });
  services.overlay.openPicker({ title: "Search providers", options }, (value) => {
    void activateSearchProvider(services, assertSearchProvider(value));
  });
}

async function activateSearchProvider(services: AppServices, next: SearchProviderId): Promise<void> {
  const adapter = searchProviders[next];
  if (adapter?.needsApiKey) {
    const current = await getSearchProviderKey(next);
    if (!current.value) {
      services.overlay.close();
      const key = await services.overlay.openSecret({
        title: `${next} search API key`,
        prompt: `No API key is configured for ${adapter.displayName}. Enter it now to use this search provider.`,
      });
      if (!key) return;
      await setSecret("search", next, key);
    }
  }
  setActiveSearchProvider(next);
  services.overlay.close();
  services.session.notice("info", `search provider → ${next}`);
}

export function handleReasoning(services: AppServices, invocation: CommandInvocation): void {
  if (invocation.args) {
    applyReasoning(services, invocation.args.trim());
    return;
  }
  const current = getConfig().thinking;
  const provider = services.session.getState().provider ?? getConfig().defaultProvider;
  const model = services.session.getState().model ?? "";
  const supported = modelSupportsThinking(provider, model) ? "supported" : "model may ignore it";
  const options: PickerOption[] = Object.entries(REASONING_DESCRIPTIONS).map(([value, description]) => ({
    value,
    label: value,
    description,
    active: value === (current.enabled ? current.effort : "off"),
  }));
  services.overlay.openPicker({ title: `Reasoning · ${supported}`, options }, (value) => {
    applyReasoning(services, value);
    services.overlay.close();
  });
}

function applyReasoning(services: AppServices, value: string): void {
  const lower = value.toLowerCase();
  if (/^(on|enable|true)$/.test(lower)) {
    setThinking({ enabled: true });
    services.session.notice("info", `thinking → ${getConfig().thinking.effort}`);
    return;
  }
  if (["off", "none", "disable", "false"].includes(lower)) {
    setThinking({ enabled: false });
    services.session.notice("info", "thinking → off");
    return;
  }
  if (["minimal", "low", "medium", "high", "xhigh"].includes(lower)) {
    setThinking({ enabled: true, effort: lower as ReasoningEffort });
    services.session.notice("info", `thinking → ${lower}`);
    return;
  }
  services.session.notice("warn", "usage: /variants [on|off|minimal|low|medium|high|xhigh]");
}

export async function handleHistory(services: AppServices): Promise<void> {
  // Recover pruned/orphan sessions from .tmp snapshots + archive before listing.
  try {
    const recovered = await recoverOrphanedHistory();
    if (recovered.recovered > 0) {
      services.session.notice(
        "info",
        `restored ${recovered.recovered} session(s) from backup/archive`,
      );
    }
  } catch {
    /* best-effort */
  }

  const sessions = await listSessions(200);
  const currentMessages = services.session.messages;
  const currentId = services.session.sessionId;
  const currentTitle = services.session.getState().title;
  if (sessions.length === 0 && currentMessages.length === 0) {
    services.session.notice(
      "info",
      "no session history yet — chat once and it will appear here with an AI title",
    );
    return;
  }
  // Live session once at the top — never also list the same id below
  // (that looked like two copies of one chat with different item counts).
  const otherSessions = sessions.filter((s) => s.id !== currentId);
  const liveVisualCount = conversationItemCount(
    services.transcript.getState(),
  );
  const shortSessionId = (id: string): string =>
    id.length <= 12 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;

  const options: PickerOption[] = [
    {
      value: "__current__",
      label: currentTitle?.trim() || "Current session",
      description: currentMessages.length
        ? `id ${shortSessionId(currentId)}  ·  now  ·  ${liveVisualCount} items  ·  ${currentMessages.length} model msgs  ·  this window`
        : `id ${shortSessionId(currentId)}  ·  now  ·  empty session  ·  this window`,
      active: true,
    },
    ...otherSessions.map((session) => {
      const durableVisual = (session.transcript ?? []).filter(
        (i) => i.kind !== "notice",
      );
      const count =
        durableVisual.length > 0
          ? durableVisual.length
          : session.messages.filter(
              (m) =>
                m.role === "user" ||
                m.role === "assistant" ||
                m.role === "tool",
            ).length;
      const date = session.updatedAt ?? session.createdAt;
      const when = relativeTime(date) || "some time ago";
      const stamp = date.slice(0, 16).replace("T", " ");
      const where = shortCwd(session.cwd);
      const title =
        (session.name && session.name.trim()) || "Untitled chat";
      // Two-line card: title on top; meta chips underneath (always show session id).
      const meta = [
        `id ${shortSessionId(session.id)}`,
        when,
        stamp,
        `${count} item${count === 1 ? "" : "s"}`,
        where ? `in ${where}` : "",
      ]
        .filter(Boolean)
        .join("  ·  ");
      return {
        value: session.id,
        label: title,
        description: meta,
        active: false,
      };
    }),
  ];
  services.overlay.openPicker(
    {
      title: "History",
      twoLine: true,
      historyStyle: true,
      searchDescription: true,
      options,
    },
    (value) => {
    void (async () => {
      if (value === "__current__") {
        services.session.notice("info", "showing current session");
        services.overlay.close();
        return;
      }
      // Prefer a fresh load so we get the full transcript payload.
      const session =
        (await getSession(value)) ?? sessions.find((s) => s.id === value);
      if (!session) {
        services.session.notice("warn", "session not found");
        services.overlay.close();
        return;
      }

      if (session.id === currentId) {
        services.session.notice("info", "already on this session");
        services.overlay.close();
        return;
      }

      // Persist the outgoing live session before rebinding id, so work is not
      // lost and we don't orphan a half-saved row under the old id.
      if (currentMessages.length > 0) {
        try {
          await services.session.persistNow();
        } catch {
          /* best-effort */
        }
      }

      clearActiveProjectRoot();
      services.plan.clear();
      services.session.loadHistory(session.messages, {
        sessionId: session.id,
        title: session.name,
        ...(session.contextUsage
          ? { contextUsage: session.contextUsage }
          : {}),
        ...(session.workspaceFolder
          ? {
              workspaceFolder: session.workspaceFolder,
              workspaceCode: session.workspaceCode,
            }
          : {}),
      });

      // Prefer the richer of visual transcript vs model messages (tools often
      // survive only in messages after abort-before-save of the UI snapshot).
      const hydrated = hydrateSessionVisual(
        session.transcript,
        session.messages,
      );
      services.transcript.hydrate(hydrated.state);

      // Seed tool output spools so click-to-pager still has bodies.
      for (const [toolCallId, output] of hydrated.toolOutputs) {
        services.session.spool.replace(toolCallId, output);
      }

      // Plans are stored per sessionId (plans.jsonl / sqlite), separate from
      // the chat transcript. Reload them so Ctrl+H / Ctrl+P show the plan
      // that belonged to this resumed session (classic clai parity).
      const plan = await services.plan.load(session.id).catch(() => undefined);
      // Clear approval gate for a resumed plan — user must /implement again
      // if the plan was still draft/approved but execution should not resume
      // silently.
      services.session.setPlanApproved(
        plan?.status === "approved" || plan?.status === "in_progress",
      );

      // Notices are UI-only — exclude from item counts (and they are never
      // model messages; session.messages is already the real LLM history).
      const itemCount = conversationItemCount(hydrated.state);
      const titleBit = session.name
        ? ` · ${session.name.length > 28 ? `${session.name.slice(0, 27)}…` : session.name}`
        : "";
      const planBit = plan ? " · plan" : "";
      const toolCards = [...hydrated.state.byId.values()].filter(
        (i) => i.kind === "tool",
      ).length;
      const incomplete =
        transcriptLooksIncomplete(
          session.transcript?.length ?? 0,
          session.messages,
        ) ||
        (Boolean(plan?.tasks?.length) &&
          toolCards === 0 &&
          (session.transcript?.length ?? 0) < 8);
      // Short toast — full counts were too wide for the chip.
      services.session.notice(
        "info",
        `resumed${titleBit}${planBit} · ${itemCount} items`,
      );
      if (incomplete) {
        services.session.notice(
          "warn",
          plan?.tasks?.length
            ? "thin history · plan OK · /implement to continue"
            : "thin history · some tools may be missing",
        );
      }
      services.overlay.close();
    })();
  });
}

export function handlePermissions(services: AppServices, invocation: CommandInvocation): void {
  const apply = (value: "default" | "allow-all") => {
    updateConfig({ permissions: value });
    services.session.notice("info", `permissions → ${value}`);
  };
  if (invocation.args) {
    const value = invocation.args.trim().toLowerCase();
    if (value === "default" || value === "allow-all") apply(value);
    return;
  }
  const current = getConfig().permissions ?? "default";
  services.overlay.openPicker(
    {
      title: "Permissions",
      options: [
        {
          value: "default",
          label: "default",
          description: "confirm risky tool calls",
          active: current === "default",
        },
        {
          value: "allow-all",
          label: "allow-all",
          description: "skip confirmation prompts",
          active: current === "allow-all",
        },
      ],
    },
    (value) => {
      apply(value as "default" | "allow-all");
      services.overlay.close();
    },
  );
}

export function handleOutput(services: AppServices, invocation: CommandInvocation): void {
  const state = services.transcript.getState();
  const toolItems = [...state.byId.values()].filter((item) => item.kind === "tool");
  if (toolItems.length === 0) {
    services.session.notice("info", "no tool output yet");
    return;
  }

  const arg = invocation.args.trim().toLowerCase();
  if (!arg) {
    services.transcript.toggleOutputGlobal();
    const on = services.transcript.getState().expandOutputGlobal;
    services.toast.show(
      on ? "Tool output expanded · ^O" : "Tool output collapsed · ^O",
      { key: "output", durationMs: 1500 },
    );
    return;
  }
  if (arg === "list" || arg === "ls") {
    services.overlay.openPicker(
      {
        title: "Tool output",
        options: toolItems.map((item) => ({
          value: item.id,
          label: item.name,
          description: item.argsDisplay,
        })),
      },
      (value) => {
        services.overlay.close();
        const item = toolItems.find((t) => t.id === value);
        if (item) void openToolOutputPager(services, item);
      },
    );
    return;
  }
  const target =
    arg !== "last"
      ? toolItems.find((t) => t.toolCallId === arg || t.id === arg)
      : toolItems.at(-1);
  if (target) void openToolOutputPager(services, target);
  else services.session.notice("info", arg ? `no tool output: ${arg}` : "no tool output yet");
}

export function handlePlanPager(services: AppServices): void {
  void (async () => {
    let plan = services.plan.current();
    if (!plan) {
      plan = await services.plan
        .load(services.session.sessionId)
        .catch(() => undefined);
    }
    if (!plan) {
      services.session.notice("info", "no active plan yet");
      return;
    }
    const { formatPlanPagerDocument } = await import(
      "../../rendering/plan-view.js"
    );
    services.overlay.openPager(
      `Plan · ${plan.goal}`,
      formatPlanPagerDocument(plan),
      undefined,
      undefined,
      "force",
    );
  })();
}
