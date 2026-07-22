import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentrouterProvider,
  AUTHORIZED_USER_AGENTS,
} from "../src/llm/agentrouter.js";

describe("AgentRouter model discovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const baseTime = Date.now();

  it("requires API key and calls fetch on agentrouter models endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "claude-haiku-4-5-20251001" }, { id: "gpt-5" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(Date, "now").mockReturnValue(baseTime);

    const result = await agentrouterProvider.listModels!({ apiKey: "sk-testkey" });
    expect(result).toEqual([
      "claude-haiku-4-5-20251001",
      "gpt-5",
    ]);

    expect(fetchMock).toHaveBeenCalled();
    const fetchCallArgs = fetchMock.mock.calls[0];
    expect(String(fetchCallArgs[0])).toContain("/models");
    const options = fetchCallArgs[1] as RequestInit;
    expect(options.headers).toMatchObject({
      "authorization": "Bearer sk-testkey",
      "User-Agent": AUTHORIZED_USER_AGENTS[0],
    });
  });

  it("throws when no API key is configured", async () => {
    await expect(agentrouterProvider.listModels!({})).rejects.toThrow(
      "AgentRouter API key is required",
    );
  });

  it("caches the models list", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "claude-haiku-4-5-20251001" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    // Bypass cache by setting time to 5 hours after baseTime
    const time = baseTime + 5 * 60 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(time);
    await agentrouterProvider.listModels!({ apiKey: "sk-testkey" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call within TTL (10 seconds later)
    vi.spyOn(Date, "now").mockReturnValue(time + 10000);
    const result = await agentrouterProvider.listModels!({ apiKey: "sk-testkey" });
    expect(result).toEqual(["claude-haiku-4-5-20251001"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rotates to the next authorized client identity on an unauthorized_client 401", async () => {
    const seenUas: string[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      const ua = (init.headers as Record<string, string>)["User-Agent"];
      seenUas.push(ua);
      // First identity is rejected by the client gate; the next one works.
      if (ua === AUTHORIZED_USER_AGENTS[0]) {
        return new Response(
          JSON.stringify({
            error: { message: "unauthorized client detected, contact support" },
            message: "UNAUTHENTICATED",
            success: false,
            type: "unauthorized_client_error",
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ data: [{ id: "glm-5.2" }, { id: "gpt-5.5" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    // Well past the cache TTL so this forces a real fetch.
    vi.spyOn(Date, "now").mockReturnValue(baseTime + 100 * 60 * 60 * 1000);

    const result = await agentrouterProvider.listModels!({ apiKey: "sk-testkey" });
    expect(result).toEqual(["glm-5.2", "gpt-5.5"]);
    expect(seenUas[0]).toBe(AUTHORIZED_USER_AGENTS[0]);
    expect(seenUas[1]).toBe(AUTHORIZED_USER_AGENTS[1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not rotate on a generic invalid-key 401 (fails fast)", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: "invalid api key" } }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Date, "now").mockReturnValue(baseTime + 200 * 60 * 60 * 1000);

    await expect(
      agentrouterProvider.listModels!({ apiKey: "sk-badkey" }),
    ).rejects.toThrow();
    // A bad key must not fan out across every identity.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
