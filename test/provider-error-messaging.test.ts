import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/llm/http.js";

// summarizeProviderError is not exported; exercise via thrown stream/complete
// paths would need network. Mirror the classification rules here by importing
// router internals through a thin re-export if available — otherwise test the
// public error surface that users see after failures.

// Prefer testing the exported helper if we add one; for now export a test seam.
import { formatProviderFailureForUser, isEmptyCompletionError } from "../src/llm/router.js";

describe("provider failure messaging", () => {
  it("maps auth errors to actionable key guidance", () => {
    const msg = formatProviderFailureForUser(
      new ProviderError("unauthorized", 401),
    );
    expect(msg).toMatch(/API key|providers/i);
    expect(msg).toContain("401");
  });

  it("maps 413 to compact guidance", () => {
    const msg = formatProviderFailureForUser(
      new ProviderError("too large", 413),
    );
    expect(msg).toMatch(/compact|input limit/i);
  });

  it("maps disconnects to free-tier / long-context guidance", () => {
    const msg = formatProviderFailureForUser(
      new Error("socket connection was closed unexpectedly"),
    );
    expect(msg).toMatch(/connection dropped|disconnect/i);
  });

  it("maps empty message to admission failure guidance", () => {
    const msg = formatProviderFailureForUser(new Error(""));
    expect(msg).toMatch(/unavailable|overloaded|admission/i);
  });

  it("maps 503 capacity language", () => {
    const msg = formatProviderFailureForUser(
      new ProviderError("bad gateway", 503),
    );
    expect(msg).toMatch(/unavailable|capacity|free-tier/i);
  });

  it("preserves the exact provider error alongside rate-limit guidance", () => {
    const msg = formatProviderFailureForUser(
      new ProviderError("Gemini quota exceeded; retry in 31 seconds", 429),
    );
    expect(msg).toContain("Model is rate limited (429)");
    expect(msg).toContain("Exact provider error: Gemini quota exceeded; retry in 31 seconds");
  });
});

describe("isEmptyCompletionError", () => {
  it("detects a provider that completed without a visible answer", () => {
    expect(
      isEmptyCompletionError(
        new ProviderError("bynara completed without a visible answer."),
      ),
    ).toBe(true);
  });

  it("detects the router-wrapped empty completion failure", () => {
    expect(
      isEmptyCompletionError(
        new Error(
          "No provider could stream the request. — bynara: bynara completed without a visible answer.",
        ),
      ),
    ).toBe(true);
  });

  it("does not treat auth, rate-limit, or generic failures as empty completions", () => {
    expect(isEmptyCompletionError(new ProviderError("unauthorized", 401))).toBe(false);
    expect(isEmptyCompletionError(new ProviderError("too large", 413))).toBe(false);
    expect(isEmptyCompletionError(new Error("socket connection was closed"))).toBe(false);
  });
});
