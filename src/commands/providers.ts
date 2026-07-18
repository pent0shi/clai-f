import { password, select } from "@inquirer/prompts";
import chalk from "chalk";
import { getProvider, pingProvider } from "../llm/router.js";
import { assertProvider, maskSecret } from "../llm/provider.js";
import {
  getConfig,
  getProviderModel,
  setDefaultProvider,
  updateConfig,
} from "../store/config.js";
import {
  appendProviderKey,
  envValue,
  getFallbackKeysPath,
  getProviderKeys,
  getProviderSecret,
  listProviderStatuses,
  unsetProviderSecret,
} from "../store/keys.js";
import type { ProviderId } from "../types.js";

export interface SetKeyOptions {
  fromEnv?: string | undefined;
  stdin?: boolean | undefined;
  url?: string | undefined;
  skipPing?: boolean | undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function promptForSecret(provider: ProviderId): Promise<string> {
  const raw = await password({
    message: `Enter API key for ${provider} (input hidden, leave blank to cancel):`,
    mask: "•",
  });
  return raw.trim();
}

function invalidFormatHint(provider: ProviderId): string {
  if (provider === "groq") return "Groq keys usually start with gsk_";
  if (provider === "gemini")
    return "Gemini keys usually start with AIza or AQ.";
  if (provider === "openrouter")
    return "OpenRouter keys usually start with sk-or-";
  if (provider === "openai") return "OpenAI keys usually start with sk- or sk-proj-";
  if (provider === "anthropic")
    return "Anthropic keys usually start with sk-ant-";
  if (provider === "nvidia")
    return "NVIDIA NIM keys usually start with nvapi-";
  if (provider === "agentrouter")
    return "AgentRouter keys usually start with sk- (issued at https://agentrouter.org/console/token)";
  if (provider === "kimchi")
    return "Kimchi keys are alphanumeric (at least 8 characters)";
  if (provider === "aws-mantle")
    return "Mantle keys are alphanumeric with base64 characters (at least 8 characters)";
  if (provider === "bynara")
    return "Bynara keys usually start with sk_nry_ (at least 8 characters)";
  if (provider === "qwen-cloud")
    return "Qwen Cloud keys usually start with sk- (from https://home.qwencloud.com)";
  return "Ollama expects a URL such as http://localhost:11434";
}

export async function setProviderKey(
  providerValue: string,
  keyArg: string | undefined,
  options: SetKeyOptions,
): Promise<void> {
  
  if (
    providerValue === "brave" ||
    providerValue === "tavily" ||
    providerValue === "duckduckgo"
  ) {
    const { setSearchProviderKey } = await import("./search-providers.js");
    const opts: { fromEnv?: string; stdin?: boolean } = {};
    if (options.fromEnv !== undefined) opts.fromEnv = options.fromEnv;
    if (options.stdin !== undefined) opts.stdin = options.stdin;
    await setSearchProviderKey(providerValue, keyArg, opts);
    return;
  }

  const provider = assertProvider(providerValue);
  const providerImpl = getProvider(provider);

  let secret = options.url ?? keyArg;
  if (options.fromEnv) {
    secret = process.env[options.fromEnv];
    if (!secret)
      throw new Error(
        `Environment variable ${options.fromEnv} is empty or missing`,
      );
  }
  if (options.stdin) {
    secret = await readStdin();
  }
  if (!secret) {
    secret = await promptForSecret(provider);
  }
  if (!secret) {
    console.log("cancelled");
    return;
  }

  secret = secret.trim();

  if (!providerImpl.validateKey(secret)) {
    process.exitCode = 2;
    throw new Error(
      `Invalid ${provider} format. ${invalidFormatHint(provider)}.`,
    );
  }

  if (provider === "ollama") {
    updateConfig({ ollamaHost: secret });
    setDefaultProvider(provider);
  } else {
    const storage = await appendProviderKey(provider, secret);
    if (storage === "fallback") {
      process.exitCode = 3;
      console.warn(
        chalk.yellow(
          `Warning: OS keychain unavailable; stored in ${getFallbackKeysPath()} with restricted permissions.`,
        ),
      );
    }
  }

  if (!options.skipPing) {
    try {
      await pingProvider(provider, secret);
    } catch (error) {
      process.exitCode = 4;
      console.warn(
        chalk.yellow(
          `Saved, but ping failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }
  }

  if (provider === "ollama") {
    console.log(`saved ollama ${secret}`);
  } else {
    const multi = await getProviderKeys(provider);
    const count = multi.source === "env" ? 1 : multi.keys.length;
    console.log(
      count > 1
        ? `added ${provider} ${maskSecret(secret)} · ${count} keys total`
        : `saved ${provider} ${maskSecret(secret)}`,
    );
  }
}

export async function unsetProviderKey(providerValue: string): Promise<void> {
  if (
    providerValue === "brave" ||
    providerValue === "tavily" ||
    providerValue === "duckduckgo"
  ) {
    const { unsetSearchProviderKey } = await import("./search-providers.js");
    await unsetSearchProviderKey(providerValue);
    return;
  }
  const provider = assertProvider(providerValue);
  const multi = await getProviderKeys(provider);
  const count = multi.source === "env" ? 0 : multi.keys.length;
  await unsetProviderSecret(provider);
  console.log(
    count > 1 ? `unset all ${count} keys for ${provider}` : `unset ${provider}`,
  );
}

export async function printProviderKeys(): Promise<void> {
  const config = getConfig();
  const statuses = await listProviderStatuses(config.defaultProvider);

  console.log(chalk.bold("LLM Providers:"));
  console.log(chalk.dim("  PROVIDER      SOURCE    KEYS          MODEL"));

  for (const s of statuses) {
    const mark = s.configured ? chalk.green("✓") : chalk.red("✗");
    const tag = s.active ? chalk.cyan(" ◀") : "";
    const count = s.keyCount ?? (s.maskedKey ? 1 : 0);
    const keySummary =
      s.provider === "ollama"
        ? s.note || "local"
        : count === 0
          ? "—"
          : count === 1
            ? s.maskedKey || "••••••••"
            : `${count} keys`;
    const source = (s.source === "missing" ? "no key" : s.source).padEnd(9);
    console.log(
      `  ${mark} ${s.provider.padEnd(13)} ${source} ${String(keySummary).padEnd(13)} ${s.model}${tag}`,
    );
    if (s.maskedKeys && s.maskedKeys.length > 1) {
      let activeIdx = 0;
      if (s.activeMaskedKey) {
        const found = s.maskedKeys.indexOf(s.activeMaskedKey);
        if (found >= 0) activeIdx = found;
      }
      s.maskedKeys.forEach((masked, i) => {
        const star = i === activeIdx ? chalk.cyan(" ★ active") : "";
        console.log(`      [${i + 1}] ${masked}${star}`);
      });
    }
  }

  console.log("");
  const { printSearchProviderKeys } = await import("./search-providers.js");
  await printSearchProviderKeys();
}

export async function ensureProviderConfigured(
  provider: ProviderId,
): Promise<void> {
  const secret = await getProviderSecret(provider);
  if (secret.value || envValue(provider) || provider === "ollama") return;
  if (!process.stdin.isTTY) return;
  const entered = await promptForSecret(provider);
  if (!entered) return;
  await setProviderKey(provider, entered, { skipPing: false });
}

export async function useProvider(providerValue: string): Promise<void> {
  const provider = assertProvider(providerValue);
  const secret = await getProviderSecret(provider);
  if (!secret.value && !envValue(provider) && provider !== "ollama") {
    const entered = await promptForSecret(provider);
    if (!entered) {
      console.log("provider unchanged");
      return;
    }
    await setProviderKey(provider, entered, { skipPing: false });
  }
  setDefaultProvider(provider);
  console.log(`now using ${provider} · model=${getProviderModel(provider)}`);
}

export async function providerSwitcher(
  providerValue?: string | undefined,
): Promise<void> {
  if (providerValue) {
    await useProvider(providerValue);
    return;
  }

  const config = getConfig();
  const statuses = await listProviderStatuses(config.defaultProvider);
  const pageSize = 15;
  const selected = await select({
    message: "Select provider:",
    pageSize,
    choices: statuses.map((status) => ({
      name: `${status.provider.padEnd(10)} ${status.configured ? "✓ key set" : "✗ no key"}${status.active ? " (active)" : ""}`,
      value: status.provider,
    })),
    loop: false,
  });
  await useProvider(selected);
}

export async function setKeyPicker(
  providerValue?: string | undefined,
  keyArg?: string | undefined,
): Promise<void> {
  if (providerValue) {
    await setProviderKey(providerValue, keyArg, {});
    return;
  }

  const config = getConfig();
  const statuses = await listProviderStatuses(config.defaultProvider);
  const pageSize = 15;
  const selected = await select({
    message: "Set / add API key for provider:",
    pageSize,
    choices: statuses.map((status) => {
      const count = status.keyCount ?? (status.configured ? 1 : 0);
      const label =
        count > 1
          ? chalk.green(`✓ ${count} keys`)
          : status.configured
            ? chalk.green("✓ key set")
            : chalk.red("✗ no key");
      return {
        name: `${status.provider.padEnd(12)} ${label}${status.active ? chalk.cyan(" (active)") : ""}`,
        value: status.provider,
      };
    }),
    loop: false,
  });

  const multi = await getProviderKeys(selected);
  const storedCount = multi.source === "env" ? 0 : multi.keys.length;
  if (storedCount > 0) {
    console.log(
      chalk.dim(
        `${selected} has ${storedCount} key(s). New key will be added (multi-key).`,
      ),
    );
  }
  // Prompt for another key (append)
  await setProviderKey(selected, undefined, {});
}

export async function unsetKeyPicker(
  providerValue?: string | undefined,
): Promise<void> {
  if (providerValue) {
    await unsetProviderKey(providerValue);
    return;
  }

  const config = getConfig();
  const statuses = await listProviderStatuses(config.defaultProvider);
  const pageSize = 15;
  const selected = await select({
    message: "Unset API key for provider:",
    pageSize,
    choices: statuses.map((status) => ({
      name: `${status.provider.padEnd(12)} ${status.configured ? chalk.green("✓ ") + (status.maskedKey ?? "key set") : chalk.red("✗ no key")}${status.active ? chalk.cyan(" (active)") : ""}`,
      value: status.provider,
    })),
    loop: false,
  });

  const secret = await getProviderSecret(selected);
  if (!secret.value && selected !== "ollama") {
    console.log(chalk.dim(`${selected} has no key to unset`));
    return;
  }
  await unsetProviderKey(selected);
}
