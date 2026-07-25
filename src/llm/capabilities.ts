import { providerIds } from "../types.js";
import type { ProviderId } from "../types.js";
import type { ToolDialect, ToolCallingMode } from "./tool-protocol.js";
import { isTextOnlyModel } from "./tool-protocol.js";
import { getConfig } from "../store/config.js";

// Patterns of model names that support an explicit reasoning/thinking
// toggle. The match is case-insensitive substring or regex.
const reasoningPatterns: Record<ProviderId, RegExp[]> = {
  groq: [/qwen\/qwen3-32b/i, /gpt-oss/i],
  gemini: [/gemini-2\.5/i, /gemini-3/i, /gemini-3\.5/i],
  openrouter: [
    /:thinking/i,
    /deepseek-r1/i,
    /qwen3/i,
    /kimi-k2/i,
    /claude-(?:opus|sonnet|haiku)-4/i,
    /gpt-5/i,
    /o[134]/i,
    /grok.*reasoner/i,
  ],
  openai: [/gpt-5/i, /o1/i, /o3/i, /o4/i],
  anthropic: [/claude-(?:opus|sonnet|haiku)-(?:3-7|4|4-\d)/i, /claude-3-7/i],
  nvidia: [
    /kimi-k2/i,
    /deepseek-r1/i,
    /deepseek-v[34]/i,
    /qwen3/i,
    /nemotron/i,
    /glm-?5/i,
    /gpt-oss/i,
  ],
  ollama: [/deepseek-r1/i, /qwen3/i, /qwq/i],
  agentrouter: [
    /gpt-5/i,
    /claude-(?:opus|sonnet|haiku)-4/i,
    /deepseek-(?:v[34]|r1)/i,
    /glm-?[45]/i,
    /qwen3/i,
    /kimi-k2/i,
    /o[134]/i,
  ],
  kimchi: [/kimi-k2/i, /minimax-m2/i, /minimax-m3/i, /nemotron-3-super/i],
  "aws-mantle": [/claude-(?:opus|sonnet|haiku)-4/i],
  bynara: [/mimo-/i, /deepseek-v4/i, /deepseek-r1/i, /bynara-max/i],
  "qwen-cloud": [/qwen3/i, /qwen2/i],
};

// Session-sticky set of models that rejected our reasoning/thinking options at
// runtime. Keyed by model name because reasoning-parameter support is a
// property of the model's chat template, not the gateway serving it. Populated
// by the router when a provider returns a parameter-rejection error for a
// reasoning knob (see isReasoningUnsupportedError in http.ts).
const reasoningUnsupportedModels = new Set<string>();

const reasoningKey = (model: string): string => model.trim().toLowerCase();

/** Mark a model as having rejected reasoning options so we stop sending them. */
export function markReasoningUnsupported(model: string): void {
  reasoningUnsupportedModels.add(reasoningKey(model));
}

/** Whether a model was observed to reject reasoning options this session. */
export function isReasoningUnsupported(model: string): boolean {
  return reasoningUnsupportedModels.has(reasoningKey(model));
}

export function clearReasoningUnsupported(): void {
  reasoningUnsupportedModels.clear();
}

export function modelSupportsThinking(
  provider: ProviderId,
  model: string,
): boolean {
  if (isReasoningUnsupported(model)) return false;
  const patterns = reasoningPatterns[provider] ?? [];
  return patterns.some((pattern) => pattern.test(model));
}


const visionPatterns: Record<ProviderId, RegExp[]> = {
  groq: [
    // Llama 4 (scout/maverick) and llama-3.2 vision models on Groq.
    /llama-4/i,
    /llama-3\.2-(?:11b|90b)-vision/i,
    /meta-llama\/llama-4/i,
  ],
  gemini: [
    // All current Gemini models are natively multimodal.
    /gemini-/i,
  ],
  openrouter: [
    /gpt-4o/i,
    /gpt-4\.1/i,
    /gpt-5/i,
    /claude-(?:opus|sonnet|haiku)-(?:3-5|3-7|4|4-\d)/i,
    /claude-3(?:-|\.|$)/i,
    /gemini-/i,
    /llama-4/i,
    /llama-3\.2-(?:11b|90b)-vision/i,
    /qwen2?\.?5?-vl/i,
    /pixtral/i,
    /grok-(?:2-)?vision/i,
    /grok-4/i,
    /:vision/i,
  ],
  openai: [/gpt-4o/i, /gpt-4\.1/i, /gpt-5/i, /o[34]/i, /gpt-4-turbo/i],
  anthropic: [
    // Claude 3+ (opus/sonnet/haiku) are all vision-capable.
    /claude-(?:opus|sonnet|haiku)-(?:3|3-5|3-7|4|4-\d)/i,
    /claude-3(?:-|\.|$)/i,
  ],
  nvidia: [
    /llama-4/i,
    /llama-3\.2-(?:11b|90b)-vision/i,
    /vila/i,
    /neva/i,
    /qwen2?\.?5?-vl/i,
    /pixtral/i,
    /gemma-3/i,
    /minimax-m3/i,
  ],
  ollama: [
    /llava/i,
    /llama3\.2-vision/i,
    /llama-?4/i,
    /bakllava/i,
    /moondream/i,
    /minicpm-?v/i,
    /qwen2?\.?5?-vl/i,
    /gemma3/i,
  ],
  agentrouter: [
    /gpt-4o/i,
    /gpt-4\.1/i,
    /gpt-5/i,
    /claude-(?:opus|sonnet|haiku)-(?:3-5|3-7|4|4-\d)/i,
    /claude-3(?:-|\.|$)/i,
    /gemini-/i,
    /llama-4/i,
    /qwen2?\.?5?-vl/i,
    /glm-4\.?\d*v/i,
    /glm-?5/i,
  ],
  kimchi: [/kimi-k2/i, /minimax-m2/i, /minimax-m3/i, /nemotron-3-super/i],
  "aws-mantle": [
    /claude-(?:opus|sonnet|haiku)-(?:3|3-5|3-7|4|4-\d)/i,
    /claude-3(?:-|\.|$)/i,
    /gpt-4o/i,
    /gpt-4\.1/i,
    /gpt-5/i,
    /gemini-/i,
    /llama-4/i,
    /qwen2?\.?5?-vl/i,
    /qwen-vl/i,
    /glm-4\.?\d*v/i,
    /glm-?5/i,
    /vision/i,
  ],
  bynara: [/mimo-v2\.5-free/i, /mistral-medium-3-5/i],
  "qwen-cloud": [/qwen3\.7-(?:plus|max)/i, /qwen3\.5-(?:plus|flash)/i, /qwen-vl/i],
};

const visionCapabilityCache = new Map<
  string,
  { vision: boolean; source: "provider" | "user"; observedAt: string }
>();

const capabilityKey = (provider: ProviderId, model: string): string =>
  `${provider}:${model.trim().toLowerCase()}`;

const knownProviderIds = new Set<string>(providerIds);
const warnedUnknownProviders = new Set<string>();

/**
 * Capability lookups are keyed by canonical `ProviderId`. Passing a display
 * label (`"NVIDIA NIM"`) used to silently resolve to "no capability", which
 * disabled vision while the rest of the app believed it was on (LLM-001).
 * Fail loudly in dev/test and warn once per bad key in production.
 */
export function warnOnUnknownProviderId(site: string, provider: string): void {
  if (knownProviderIds.has(provider)) return;
  const message = `${site}: "${provider}" is not a canonical ProviderId — capability lookups will report no support. Pass the provider id, not the display label.`;
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    throw new Error(message);
  }
  if (warnedUnknownProviders.has(provider)) return;
  warnedUnknownProviders.add(provider);
  console.warn(`[clai] ${message}`);
}

function configuredVisionModel(provider: ProviderId): string | undefined {
  const envKey = `CLAI_VISION_MODEL_${provider.toUpperCase().replace(/-/g, "_")}`;
  return process.env[envKey]?.trim() || undefined;
}

/** Provider discovery/user overrides can refresh capability knowledge at runtime. */
export function registerModelVisionCapability(input: {
  provider: ProviderId;
  model: string;
  vision: boolean;
  source?: "provider" | "user";
  observedAt?: string;
}): void {
  visionCapabilityCache.set(capabilityKey(input.provider, input.model), {
    vision: input.vision,
    source: input.source ?? "provider",
    observedAt: input.observedAt ?? new Date().toISOString(),
  });
}

export function clearModelVisionCapabilities(): void {
  visionCapabilityCache.clear();
}

export function visionCapabilitySource(
  provider: ProviderId,
  model: string,
): "provider" | "user" | "fallback-table" {
  const cached = visionCapabilityCache.get(capabilityKey(provider, model));
  if (cached) return cached.source;
  const configured = configuredVisionModel(provider);
  return configured?.toLowerCase() === model.trim().toLowerCase()
    ? "user"
    : "fallback-table";
}

/**
 * Whether the given provider/model can accept image input. When true, the
 * agent attaches real image bytes to the user message; when false, it falls
 * back to a text note and OCR/inspection tools.
 */
export function modelSupportsVision(
  provider: ProviderId,
  model: string,
): boolean {
  warnOnUnknownProviderId("modelSupportsVision", provider);
  const cached = visionCapabilityCache.get(capabilityKey(provider, model));
  if (cached) return cached.vision;
  const configured = configuredVisionModel(provider);
  if (configured?.toLowerCase() === model.trim().toLowerCase()) return true;
  const patterns = visionPatterns[provider] ?? [];
  const normalizedModel = model.trim().replace(/\s+/g, "-");
  return patterns.some(
    (pattern) => pattern.test(model) || pattern.test(normalizedModel),
  );
}


const preferredVisionModels: Partial<Record<ProviderId, string>> = {
  groq: "meta-llama/llama-4-scout-17b-16e-instruct",
  gemini: "gemini-3.5-flash",
  openrouter: "google/gemini-2.5-flash",
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-latest",
  nvidia: "meta/llama-4-maverick-17b-128e-instruct",
  agentrouter: "claude-opus-4-6",
  kimchi: "kimi-k2.6",
  "aws-mantle": "anthropic.claude-haiku-4-5",
  ollama: "llama3.2-vision",
  bynara: "mimo-v2.5-free",
  "qwen-cloud": "qwen3.7-plus",
};


export function preferredVisionModel(
  provider: ProviderId,
  currentModel: string,
): string | undefined {
  if (modelSupportsVision(provider, currentModel)) return currentModel;
  const override = configuredVisionModel(provider);
  if (override && modelSupportsVision(provider, override)) return override;
  const discovered = [...visionCapabilityCache.entries()]
    .filter(([key, value]) => key.startsWith(`${provider}:`) && value.vision)
    .sort((a, b) => b[1].observedAt.localeCompare(a[1].observedAt))[0];
  if (discovered) return discovered[0].slice(provider.length + 1);
  const fallback = preferredVisionModels[provider];
  if (!fallback) return undefined;
  return modelSupportsVision(provider, fallback) ? fallback : undefined;
}

/** Default wire dialect for each provider. */
const providerToolDialect: Record<ProviderId, ToolDialect> = {
  openai: "openai",
  groq: "openai",
  openrouter: "openai",
  nvidia: "openai",
  agentrouter: "openai",
  kimchi: "openai",
  bynara: "openai",
  "qwen-cloud": "openai",
  anthropic: "anthropic",
  "aws-mantle": "openai", // refined by model below
  gemini: "gemini",
  ollama: "ollama",
};

/** Known non-tool / embedding / tiny models (light denylist). */
const nativeToolsDenylist: RegExp[] = [
  /embed/i,
  /embedding/i,
  /whisper/i,
  /tts/i,
  /dall-e/i,
  /moderation/i,
  /text-embedding/i,
];

/** Ollama families known to support tools. */
const ollamaToolFamilies: RegExp[] = [
  /llama3\.1/i,
  /llama3\.2/i,
  /llama3\.3/i,
  /llama-?4/i,
  /qwen/i,
  /mistral/i,
  /command-r/i,
  /firefunction/i,
  /tool/i,
  /nemotron/i,
  /deepseek/i,
  /gpt-oss/i,
  /gemma3/i,
];

function isAwsMantleAnthropicModel(model: string): boolean {
  return /(?:^|[./-])(?:anthropic|claude)(?:[./-]|$)/i.test(model);
}


export function resolveToolDialect(
  provider: ProviderId,
  model: string,
  toolCalling?: ToolCallingMode,
): ToolDialect {
  const mode = toolCalling ?? getConfig().toolCalling ?? "auto";
  if (mode === "text") return "none";
  if (isTextOnlyModel(provider, model)) return "none";
  if (nativeToolsDenylist.some((re) => re.test(model))) return "none";

  if (provider === "aws-mantle") {
    return isAwsMantleAnthropicModel(model) ? "anthropic" : "openai";
  }

  if (provider === "ollama") {
    if (mode === "native") return "ollama";
    // native-preferred: only attach for known tool-capable families
    if (ollamaToolFamilies.some((re) => re.test(model))) return "ollama";
    return "none";
  }

  return providerToolDialect[provider] ?? "none";
}

export function modelSupportsNativeTools(
  provider: ProviderId,
  model: string,
  toolCalling?: ToolCallingMode,
): boolean {
  return resolveToolDialect(provider, model, toolCalling) !== "none";
}
