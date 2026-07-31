import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  markStreamEmittedBytes,
  streamAlreadyEmitted,
  streamEmittedBytes,
} from "../src/llm/stream-progress.js";
import { providers, streamWithProvider } from "../src/llm/router.js";
import { ProviderError, STREAM_STALL_MARKER } from "../src/llm/http.js";
import { getConfig, updateConfig } from "../src/store/config.js";
import type { LlmProvider } from "../src/llm/provider.js";

describe("LLM-003 — stream progress tagging", () => {
  it("records emitted bytes on the thrown error", () => {
    const error = markStreamEmittedBytes(new Error("stream stalled"), 42);
    expect(streamEmittedBytes(error)).toBe(42);
    expect(streamAlreadyEmitted(error)).toBe(true);
  });

  it("treats a zero-byte failure as retriable", () => {
    const error = markStreamEmittedBytes(new Error("fetch failed"), 0);
    expect(streamAlreadyEmitted(error)).toBe(false);
  });

  it("does not serialize the tag into the message or JSON", () => {
    const error = markStreamEmittedBytes(new Error("boom"), 10);
    expect(error.message).toBe("boom");
    expect(Object.keys(error)).not.toContain("emittedBytes");
  });

  it("ignores non-object failures", () => {
    expect(streamAlreadyEmitted("stream stalled")).toBe(false);
    expect(streamAlreadyEmitted(undefined)).toBe(false);
  });
});


describe("LLM-003 — router refuses transparent retry after emission", () => {
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
  });

  it("does not re-stream after prose and half a tool-call have been emitted", async () => {
    let calls = 0;
    providers.nvidia = {
      ...originalNvidia,
      async stream(_request, _auth, onToken) {
        calls += 1;
        onToken("Here is the plan. ");
        onToken('```tool\n{"tool":"fs.write","args":{"path":"a.txt"');
        throw new ProviderError("Provider stream stalled — no model output");
      },
    } as LlmProvider;

    const tokens: string[] = [];
    await expect(
      streamWithProvider(
        { provider: "nvidia", model: "z-ai/glm-5.2", messages: [{ role: "user", content: "hi" }] },
        (token) => tokens.push(token),
      ),
    ).rejects.toThrow(/stalled|No provider could stream/i);

    expect(calls).toBe(1);
    expect(tokens.join("")).toContain("Here is the plan.");
  });

  it("still retries a route that never delivered a byte", async () => {
    let calls = 0;
    providers.nvidia = {
      ...originalNvidia,
      async stream() {
        calls += 1;
        if (calls === 1) {
          throw new ProviderError(
            "nvidia request timed out before any response (120s) — no data arrived on the connection.",
          );
        }
        return { text: "ok", provider: "nvidia" as const, model: "z-ai/glm-5.2" };
      },
    } as LlmProvider;

    const result = await streamWithProvider(
      { provider: "nvidia", model: "z-ai/glm-5.2", messages: [{ role: "user", content: "hi" }] },
      () => {},
    );
    expect(result.text).toBe("ok");
    expect(calls).toBe(2);
  });

  // A stall on a live connection means the generation already happened and the
  // runtime was buffering it. A transparent same-route retry would replay the
  // whole thing and stall identically, so the router surfaces it and lets the
  // agent's recovery layer retry with a "smaller tool calls" nudge instead.
  it("does not transparently retry a stall on a live connection", async () => {
    let calls = 0;
    providers.nvidia = {
      ...originalNvidia,
      async stream() {
        calls += 1;
        throw new ProviderError(
          `nvidia stream stalled — ${STREAM_STALL_MARKER} for 240s after it had already started responding.`,
        );
      },
    } as LlmProvider;

    await expect(
      streamWithProvider(
        { provider: "nvidia", model: "z-ai/glm-5.2", messages: [{ role: "user", content: "hi" }] },
        () => {},
      ),
    ).rejects.toThrow(/stalled|No provider could stream/i);
    expect(calls).toBe(1);
  });
});
