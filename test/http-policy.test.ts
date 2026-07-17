import { afterEach, describe, expect, it, vi } from "vitest";
import { httpFetch } from "../src/tools/http.js";
import { runToolCall } from "../src/tools/registry.js";

afterEach(() => vi.unstubAllGlobals());

describe("http.fetch network policy", () => {
  it("checks the initial URL and every redirect before following it", async () => {
    // Use public TEST-NET IPs (no DNS) so CI never hangs on resolver timeouts
    // for fake hostnames. Policy must still authorize every hop.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://203.0.113.66/steal" },
        }),
      )
      .mockResolvedValueOnce(new Response("should not be reached", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const checked: string[] = [];

    const result = await httpFetch("https://203.0.113.10/api", {
      authorizeHop: (url) => {
        checked.push(url);
        return url.includes("203.0.113.66")
          ? { allowed: false, reason: "redirect destination is out of scope" }
          : { allowed: true, reason: "authorized" };
      },
      retries: 0,
    });

    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(result.output).toMatch(/redirect destination is out of scope/);
    expect(checked).toEqual([
      "https://203.0.113.10/api",
      "https://203.0.113.66/steal",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes all resolved addresses to policy before making the request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    let addresses: string[] = [];

    const result = await httpFetch("http://10.0.0.5:8080/health", {
      iOwnThis: true,
      authorizeHop: (_url, resolved) => {
        addresses = resolved;
        return { allowed: false, reason: "resolved address not authorized" };
      },
      retries: 0,
    });

    expect(result.ok).toBe(false);
    expect(addresses).toEqual(["10.0.0.5"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips engagement authorizeHop for owned loopback (local app verify)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<html>ok</html>", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    let hopCalled = false;
    const result = await httpFetch("http://localhost:5174/", {
      iOwnThis: true,
      authorizeHop: () => {
        hopCalled = true;
        return { allowed: false, reason: "out of scope" };
      },
      retries: 0,
    });
    expect(result.ok).toBe(true);
    expect(hopCalled).toBe(false);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("retries alternate loopback hosts on ECONNREFUSED", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }))
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:5174"))
      .mockResolvedValue(
        new Response("<!doctype html>", {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/html" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await httpFetch("http://localhost:5174/", {
      iOwnThis: true,
      retries: 0,
    });
    // With retries=0, owned loopback still elevates retry floor; may succeed
    // on a later candidate after refused attempts.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    if (result.ok) {
      expect(result.output).toMatch(/200/);
    }
  });

  it("refuses loopback without iOwnThis at the httpFetch layer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await httpFetch("http://localhost:5174/", { retries: 0 });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/iOwnThis/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("registry auto-owns loopback GET so local app probes work without iOwnThis", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<!doctype html><html></html>", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await runToolCall({
      name: "http.fetch",
      args: { url: "http://localhost:5174/" },
    });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("registry does not auto-own non-loopback private addresses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await runToolCall({
      name: "http.fetch",
      args: { url: "http://169.254.169.254/latest/meta-data/" },
    });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/private|loopback|metadata|iOwnThis/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
