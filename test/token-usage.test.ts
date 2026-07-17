import { describe, expect, it } from "vitest";
import {
  applyUsageToSnapshot,
  formatContextChip,
  formatTokenCount,
  modelContextWindow,
  parseAnthropicUsage,
  parseGeminiUsage,
  parseOllamaUsage,
  parseOpenAiUsage,
} from "../src/llm/token-usage.js";

describe("token-usage parsers", () => {
  it("parses OpenAI usage (snake + camel)", () => {
    expect(
      parseOpenAiUsage({
        prompt_tokens: 1200,
        completion_tokens: 80,
        total_tokens: 1280,
      }),
    ).toEqual({
      promptTokens: 1200,
      completionTokens: 80,
      totalTokens: 1280,
      exact: true,
    });
    expect(
      parseOpenAiUsage({
        promptTokens: 10,
        completionTokens: 5,
      }),
    ).toMatchObject({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it("parses Anthropic / Gemini / Ollama usage", () => {
    expect(
      parseAnthropicUsage({ input_tokens: 100, output_tokens: 20 }),
    ).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      exact: true,
    });
    expect(
      parseGeminiUsage({
        promptTokenCount: 50,
        candidatesTokenCount: 10,
        totalTokenCount: 60,
      }),
    ).toMatchObject({ promptTokens: 50, completionTokens: 10, totalTokens: 60 });
    expect(
      parseOllamaUsage({ prompt_eval_count: 40, eval_count: 12 }),
    ).toMatchObject({ promptTokens: 40, completionTokens: 12 });
  });

  it("returns undefined for empty usage", () => {
    expect(parseOpenAiUsage(undefined)).toBeUndefined();
    expect(parseOpenAiUsage({})).toBeUndefined();
  });
});

describe("token-usage format + context window", () => {
  it("formats counts and context chips", () => {
    expect(formatTokenCount(12450)).toBe("12,450");
    expect(formatTokenCount(128_000, true)).toBe("128k");
    expect(
      formatContextChip({
        contextTokens: 12_450,
        contextLimit: 128_000,
        lastCompletionTokens: 80,
        sessionPromptTokens: 12_450,
        sessionCompletionTokens: 80,
        exact: true,
      }),
    ).toBe("ctx 12,450/128k");
    expect(
      formatContextChip(
        {
          contextTokens: 12_450,
          contextLimit: 128_000,
          lastCompletionTokens: 0,
          sessionPromptTokens: 0,
          sessionCompletionTokens: 0,
          exact: false,
        },
        { compact: true },
      ),
    ).toMatch(/^~ctx /);
  });

  it("resolves known model context windows", () => {
    expect(modelContextWindow("claude-sonnet-4-20250514")).toBe(200_000);
    expect(modelContextWindow("gpt-4o")).toBe(128_000);
    expect(modelContextWindow("gemini-2.0-flash")).toBe(1_048_576);
    expect(modelContextWindow("unknown-model-xyz")).toBe(128_000);
  });

  it("accumulates session totals and latest context fill", () => {
    const a = applyUsageToSnapshot(
      undefined,
      {
        promptTokens: 1000,
        completionTokens: 50,
        totalTokens: 1050,
        exact: true,
      },
      128_000,
    );
    expect(a.contextTokens).toBe(1000);
    expect(a.sessionPromptTokens).toBe(1000);
    expect(a.exact).toBe(true);

    const b = applyUsageToSnapshot(
      a,
      {
        promptTokens: 2500,
        completionTokens: 100,
        totalTokens: 2600,
        exact: true,
      },
      128_000,
    );
    expect(b.contextTokens).toBe(2500);
    expect(b.sessionPromptTokens).toBe(3500);
    expect(b.sessionCompletionTokens).toBe(150);
  });
});
