import { describe, expect, it } from "vitest";
import { toolCheckHandler } from "../src/tools/capabilities.js";

describe("tool.check soft-missing for built-in covered bins", () => {
  it("does not hard-fail when dig/whois are absent from the request set", async () => {
    // We only request dig+whois; even if both missing, ok=true because
    // dns.lookup / whois.lookup cover them natively.
    const result = await toolCheckHandler({
      tools: ["dig", "whois", "nslookup"],
    });
    // Either found (optional ok) or soft-missing (○) — never hard fail.
    expect(result.ok).toBe(true);
    expect(result.output).not.toMatch(/Hard-missing \(required\):.*dig/i);
    expect(result.output).not.toMatch(/Hard-missing \(required\):.*whois/i);
  });
});
