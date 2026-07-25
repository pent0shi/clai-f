import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSseFrameAssembler,
  openAiCompatibleStream,
  readStreamLines,
} from "../src/llm/http.js";

/** LLM-011: abort surfaces as an error, readers are released, error frames throw. */

function sseResponse(frames: string[], onCancel?: () => void): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function stubFetch(response: Response): void {
  vi.stubGlobal("fetch", vi.fn(async () => response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const baseOptions = {
  provider: "test",
  providerId: "openai" as const,
  baseUrl: "https://example.invalid/v1",
  apiKey: "k",
  model: "gpt-4o-mini",
  messages: [{ role: "user" as const, content: "hi" }],
};

describe("openAiCompatibleStream error frames", () => {
  it("throws when the gateway sends an error frame mid-stream", async () => {
    stubFetch(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
        'data: {"error":{"message":"upstream overloaded","type":"overloaded_error"}}\n\n',
      ]),
    );
    await expect(
      openAiCompatibleStream({ ...baseOptions, onToken: () => {} }),
    ).rejects.toThrow(/stream error: upstream overloaded/);
  });

  it("still tolerates malformed keepalive frames", async () => {
    stubFetch(
      sseResponse([
        "data: {not json}\n\n",
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const result = await openAiCompatibleStream({
      ...baseOptions,
      onToken: () => {},
    });
    expect(result.text).toBe("ok");
  });

  it("releases the response body on the success path", async () => {
    const response = sseResponse([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    stubFetch(response);
    await openAiCompatibleStream({ ...baseOptions, onToken: () => {} });
    await new Promise((resolve) => setImmediate(resolve));
    // The reader lock used to be held past [DONE], keeping the socket alive.
    expect(response.body?.locked).toBe(false);
  });
});

describe("readStreamLines caller abort", () => {
  it("throws instead of ending cleanly when the caller aborts", async () => {
    const controller = new AbortController();
    const response = sseResponse([
      "data: one\n",
      "data: two\n",
    ]);
    const lines: string[] = [];
    await expect(
      (async () => {
        for await (const line of readStreamLines(response, {
          signal: controller.signal,
        })) {
          lines.push(line);
          controller.abort();
        }
      })(),
    ).rejects.toThrow();
  });

  it("throws when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = sseResponse(["data: one\n"]);
    await expect(
      (async () => {
        for await (const _line of readStreamLines(response, {
          signal: controller.signal,
        })) {
          // no-op
        }
      })(),
    ).rejects.toThrow();
  });
});


describe("multi-line SSE frames", () => {
  it("reassembles a payload split across several data: lines", async () => {
    stubFetch(
      sseResponse([
        'data: {"choices":[{"delta":\n',
        'data: {"content":"split"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const tokens: string[] = [];
    const result = await openAiCompatibleStream({
      ...baseOptions,
      onToken: (token) => tokens.push(token),
    });
    expect(result.text).toBe("split");
    expect(tokens.join("")).toBe("split");
  });

  it("drops an unterminated fragment instead of corrupting the next frame", () => {
    const frames = createSseFrameAssembler();
    expect(frames.pushLine('data: {"choices":[{"delta":')).toBeUndefined();
    // Blank line terminates the malformed event.
    expect(frames.pushLine("")).toBeUndefined();
    expect(frames.pushLine('data: {"ok":true}')).toBe('{"ok":true}');
  });

  it("passes single-line frames straight through", () => {
    const frames = createSseFrameAssembler();
    expect(frames.pushLine('data: {"a":1}')).toBe('{"a":1}');
    expect(frames.pushLine("data: [DONE]")).toBe("[DONE]");
    expect(frames.pushLine(": keepalive comment")).toBeUndefined();
  });
});
