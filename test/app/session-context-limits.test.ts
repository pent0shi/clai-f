import { describe, expect, it } from "vitest";
import { SessionContextLimits } from "../../src/app/controllers/session-context-limits.js";

describe("SessionContextLimits (session-only, no persistence)", () => {
  it("does not survive a fresh instance (restart resets to default)", () => {
    const first = new SessionContextLimits();
    first.set("groq", "llama-3.3-70b", 131_072);

    const second = new SessionContextLimits();
    expect(second.get("groq", "llama-3.3-70b")).toBeUndefined();
  });

  it("clear() removes the in-memory limit", () => {
    const limits = new SessionContextLimits();
    limits.set("groq", "llama-3.3-70b", 200_000);
    expect(limits.get("groq", "llama-3.3-70b")).toBe(200_000);

    limits.clear();
    expect(limits.get("groq", "llama-3.3-70b")).toBeUndefined();
  });

  it("scopes limits per provider/model route", () => {
    const limits = new SessionContextLimits();
    limits.set("groq", "llama-3.3-70b", 100_000);
    limits.set("gemini", "gemini-2.0-flash", 1_000_000);

    expect(limits.get("groq", "llama-3.3-70b")).toBe(100_000);
    expect(limits.get("gemini", "gemini-2.0-flash")).toBe(1_000_000);
    expect(limits.get("groq", "gemini-2.0-flash")).toBeUndefined();
  });

  it("rejects limits below the 20k floor", () => {
    const limits = new SessionContextLimits();
    limits.set("groq", "llama-3.3-70b", 5_000);
    expect(limits.get("groq", "llama-3.3-70b")).toBeUndefined();
  });
});
