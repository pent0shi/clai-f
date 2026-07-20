import { describe, expect, it } from "vitest";
import { buildAnthropicBody } from "../../src/llm/anthropic.js";
import type { CompletionRequest } from "../../src/types.js";

/**
 * Anthropic rejects a non-default `temperature` whenever `thinking` is
 * enabled (HTTP 400: "temperature may only be set to 1 when thinking is
 * enabled"). Additionally, Claude Opus 4.7+ / Sonnet 5+ removed legacy
 * manual extended thinking (`type: "enabled", budget_tokens`) entirely and
 * require adaptive thinking (`type: "adaptive", effort`) instead — sending
 * the legacy form on those models also returns HTTP 400.
 */
function baseRequest(model: string, thinking?: CompletionRequest["thinking"]): CompletionRequest {
  return {
    model,
    messages: [{ role: "user", content: "hi" }],
    ...(thinking ? { thinking } : {}),
  };
}

describe("buildAnthropicBody thinking/temperature compatibility", () => {
  it("omits temperature when thinking is enabled on a legacy-thinking model", () => {
    const body = JSON.parse(
      buildAnthropicBody(
        baseRequest("claude-3-5-haiku-latest", { enabled: true, effort: "medium" }),
        false,
      ),
    );
    expect(body.temperature).toBeUndefined();
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  it("sends a real temperature when thinking is disabled", () => {
    const body = JSON.parse(
      buildAnthropicBody(baseRequest("claude-3-5-haiku-latest"), false),
    );
    expect(body.temperature).toBe(0.2);
    expect(body.thinking).toBeUndefined();
  });

  it("uses adaptive thinking (not budget_tokens) for Opus 4.7+", () => {
    const body = JSON.parse(
      buildAnthropicBody(
        baseRequest("claude-opus-4-7", { enabled: true, effort: "high" }),
        false,
      ),
    );
    expect(body.thinking).toEqual({ type: "adaptive", effort: "high" });
    expect(body.temperature).toBeUndefined();
  });

  it("uses adaptive thinking for Sonnet 5", () => {
    const body = JSON.parse(
      buildAnthropicBody(
        baseRequest("claude-sonnet-5", { enabled: true, effort: "medium" }),
        false,
      ),
    );
    expect(body.thinking).toEqual({ type: "adaptive", effort: "medium" });
  });

  it("keeps legacy budget_tokens thinking for pre-4.7 models", () => {
    const body = JSON.parse(
      buildAnthropicBody(
        baseRequest("claude-opus-4-6", { enabled: true, effort: "low" }),
        false,
      ),
    );
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });
});
