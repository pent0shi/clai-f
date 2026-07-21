import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildChatBody,
  isReasoningUnsupportedError,
  ProviderError,
} from "../src/llm/http.js";
import {
  clearReasoningUnsupported,
  isReasoningUnsupported,
  markReasoningUnsupported,
  modelSupportsThinking,
} from "../src/llm/capabilities.js";
import { providers, streamWithProvider } from "../src/llm/router.js";
import { getConfig, updateConfig } from "../src/store/config.js";
import type { LlmProvider } from "../src/llm/provider.js";
import type { ChatMessage } from "../src/types.js";

const userMessages: ChatMessage[] = [{ role: "user", content: "hi" }];

afterEach(() => clearReasoningUnsupported());

describe("isReasoningUnsupportedError", () => {
  it("detects 4xx bodies that name a reasoning knob", () => {
    expect(
      isReasoningUnsupportedError(
        new ProviderError(
          "NVIDIA NIM (model=z-ai/glm-5.2): request failed",
          400,
          "chat template does not accept enable_thinking",
        ),
      ),
    ).toBe(true);
    expect(
      isReasoningUnsupportedError(
        new ProviderError("unprocessable", 422, "unknown field reasoning_budget"),
      ),
    ).toBe(true);
  });

  it("detects explicit not-supported wording at any status", () => {
    expect(
      isReasoningUnsupportedError(
        new ProviderError("reasoning_effort is not supported for this model"),
      ),
    ).toBe(true);
  });

  it("ignores errors that do not mention a reasoning knob", () => {
    expect(
      isReasoningUnsupportedError(
        new ProviderError("Invalid schema for function 'fs_write'", 400, "tools"),
      ),
    ).toBe(false);
    expect(isReasoningUnsupportedError(new Error("socket closed"))).toBe(false);
  });

  it("does not treat a transient 5xx that merely mentions thinking as a reject", () => {
    expect(
      isReasoningUnsupportedError(
        new ProviderError("server error while thinking", 500, "thinking"),
      ),
    ).toBe(false);
  });
});

describe("reasoning payload graceful degradation", () => {
  it("modelSupportsThinking returns false after a model is marked unsupported", () => {
    expect(modelSupportsThinking("nvidia", "z-ai/glm-5.2")).toBe(true);
    markReasoningUnsupported("z-ai/glm-5.2");
    expect(isReasoningUnsupported("z-ai/glm-5.2")).toBe(true);
    expect(modelSupportsThinking("nvidia", "z-ai/glm-5.2")).toBe(false);
  });

  it("buildChatBody omits reasoning knobs for a model marked unsupported", () => {
    const before = JSON.parse(
      buildChatBody({
        model: "z-ai/glm-5.2",
        messages: userMessages,
        stream: false,
        reasoning: { enabled: true, effort: "high" },
        reasoningStyle: "nvidia",
      }),
    ) as Record<string, unknown>;
    expect(before).toHaveProperty("chat_template_kwargs");

    markReasoningUnsupported("z-ai/glm-5.2");
    const after = JSON.parse(
      buildChatBody({
        model: "z-ai/glm-5.2",
        messages: userMessages,
        stream: false,
        reasoning: { enabled: true, effort: "high" },
        reasoningStyle: "nvidia",
      }),
    ) as Record<string, unknown>;
    expect(after).not.toHaveProperty("chat_template_kwargs");
    expect(after).not.toHaveProperty("reasoning_budget");
    expect(after).not.toHaveProperty("reasoning_effort");
  });
});

describe("router retries without reasoning when a knob is rejected", () => {
  const originalNvidia = providers.nvidia;
  const beforeFallback = getConfig().providerFallback;
  const beforeKey = process.env.NVIDIA_API_KEY;

  beforeEach(() => {
    updateConfig({ providerFallback: false });
    process.env.NVIDIA_API_KEY = "nvapi_test_key_for_router";
  });

  afterEach(() => {
    providers.nvidia = originalNvidia;
    updateConfig({ providerFallback: beforeFallback });
    if (beforeKey === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = beforeKey;
    clearReasoningUnsupported();
  });

  it("marks the model and retries once without reasoning on a 400 knob rejection", async () => {
    let calls = 0;
    providers.nvidia = {
      ...originalNvidia,
      async stream() {
        calls += 1;
        if (calls === 1) {
          throw new ProviderError(
            "NVIDIA NIM (model=z-ai/glm-5.2): request failed",
            400,
            "chat template does not accept enable_thinking",
          );
        }
        return { text: "ok", provider: "nvidia", model: "z-ai/glm-5.2" };
      },
    } as LlmProvider;

    const statuses: string[] = [];
    const result = await streamWithProvider(
      {
        provider: "nvidia",
        model: "z-ai/glm-5.2",
        thinking: { enabled: true, effort: "high" },
        messages: userMessages,
      },
      () => undefined,
      (message) => statuses.push(message),
    );

    expect(calls).toBe(2);
    expect(result.text).toBe("ok");
    expect(isReasoningUnsupported("z-ai/glm-5.2")).toBe(true);
    expect(statuses.join("")).toMatch(/rejected reasoning options/i);
  });
});
