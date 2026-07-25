import type { ProviderId } from "../types.js";

/**
 * One declarative sampling policy.
 *
 * Everything used to run at `temperature: 0.2` with a single hard-coded MiniMax
 * exception and no `top_p` plumbing at all. Reasoning families degrade badly
 * under near-greedy decoding (Qwen3 in thinking mode loops, DeepSeek-R1 wants
 * ~0.6, gpt-oss wants 1.0), which is exactly the set of models users enable
 * thinking for.
 *
 * Add model families here, not as another regex inside an adapter.
 */
export interface SamplingDefaults {
  temperature: number;
  topP?: number | undefined;
}

interface SamplingRule {
  /** Model id pattern. */
  pattern: RegExp;
  /** Restrict the rule to reasoning-enabled steps when true. */
  reasoningOnly?: boolean;
  /** Restrict the rule to specific providers when set. */
  providers?: ProviderId[];
  defaults: SamplingDefaults;
}

export const DEFAULT_SAMPLING: SamplingDefaults = { temperature: 0.2 };

/** First match wins; order from most specific to least. */
const SAMPLING_RULES: SamplingRule[] = [
  // Kimchi exposes this as `minimax-m3`; NVIDIA uses `minimaxai/minimax-m3`.
  // Both require near-full sampling or the model degenerates.
  {
    pattern: /minimax-m3/i,
    defaults: { temperature: 1.0, topP: 0.95 },
  },
  // OpenAI's gpt-oss weights are trained for temperature 1.0.
  { pattern: /gpt-oss/i, defaults: { temperature: 1.0 } },
  // Thinking-mode recommendations from the model cards.
  {
    pattern: /qwen-?3|qwen3/i,
    reasoningOnly: true,
    defaults: { temperature: 0.6, topP: 0.95 },
  },
  {
    pattern: /deepseek-r1|deepseek-v3/i,
    reasoningOnly: true,
    defaults: { temperature: 0.6, topP: 0.95 },
  },
];

export function samplingDefaults(input: {
  provider?: ProviderId | undefined;
  model: string;
  reasoningEnabled?: boolean | undefined;
}): SamplingDefaults {
  for (const rule of SAMPLING_RULES) {
    if (rule.reasoningOnly && !input.reasoningEnabled) continue;
    if (
      rule.providers &&
      (!input.provider || !rule.providers.includes(input.provider))
    ) {
      continue;
    }
    if (rule.pattern.test(input.model)) return rule.defaults;
  }
  return DEFAULT_SAMPLING;
}

/**
 * Effective sampling for a request: an explicit caller/user temperature always
 * wins; `top_p` is only sent when the policy asks for it.
 */
export function resolveSampling(input: {
  provider?: ProviderId | undefined;
  model: string;
  reasoningEnabled?: boolean | undefined;
  requestedTemperature?: number | undefined;
}): SamplingDefaults {
  const policy = samplingDefaults(input);
  return {
    temperature: input.requestedTemperature ?? policy.temperature,
    ...(policy.topP !== undefined ? { topP: policy.topP } : {}),
  };
}
