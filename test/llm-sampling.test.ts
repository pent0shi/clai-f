import { describe, expect, it } from "vitest";
import { DEFAULT_SAMPLING, resolveSampling, samplingDefaults } from "../src/llm/sampling.js";
import { buildChatBody } from "../src/llm/http.js";
import type { ChatMessage } from "../src/types.js";

const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

describe("LLM-010 — declarative sampling policy", () => {
  const cases: Array<{
    model: string;
    reasoning?: boolean;
    expected: { temperature: number; topP?: number };
  }> = [
    { model: "minimax-m3", expected: { temperature: 1.0, topP: 0.95 } },
    { model: "minimaxai/minimax-m3", expected: { temperature: 1.0, topP: 0.95 } },
    { model: "openai/gpt-oss-120b", expected: { temperature: 1.0 } },
    { model: "qwen/qwen3-32b", reasoning: true, expected: { temperature: 0.6, topP: 0.95 } },
    // Without thinking, Qwen3 stays on the conservative default.
    { model: "qwen/qwen3-32b", expected: DEFAULT_SAMPLING },
    { model: "deepseek-ai/deepseek-r1", reasoning: true, expected: { temperature: 0.6, topP: 0.95 } },
    { model: "claude-opus-4-6", expected: DEFAULT_SAMPLING },
    { model: "llama-3.3-70b-versatile", expected: DEFAULT_SAMPLING },
  ];

  for (const testCase of cases) {
    it(`${testCase.model}${testCase.reasoning ? " (thinking)" : ""}`, () => {
      expect(
        samplingDefaults({
          model: testCase.model,
          reasoningEnabled: testCase.reasoning,
        }),
      ).toEqual(testCase.expected);
    });
  }

  it("an explicit temperature always wins", () => {
    expect(
      resolveSampling({ model: "minimax-m3", requestedTemperature: 0.1 }),
    ).toEqual({ temperature: 0.1, topP: 0.95 });
  });
});

describe("sampling reaches the OpenAI-compatible body", () => {
  it("sends the policy temperature and top_p", () => {
    const body = JSON.parse(
      buildChatBody({ model: "minimax-m3", messages, stream: false }),
    ) as Record<string, unknown>;
    expect(body.temperature).toBe(1.0);
    expect(body.top_p).toBe(0.95);
  });

  it("omits top_p when the policy has none", () => {
    const body = JSON.parse(
      buildChatBody({ model: "llama-3.3-70b-versatile", messages, stream: false }),
    ) as Record<string, unknown>;
    expect(body.temperature).toBe(0.2);
    expect(body).not.toHaveProperty("top_p");
  });

  it("still omits sampling entirely for OpenAI reasoning models", () => {
    const body = JSON.parse(
      buildChatBody({ model: "gpt-5.1", messages, stream: false }),
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
  });
});
