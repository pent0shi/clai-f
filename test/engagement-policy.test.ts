import { describe, expect, it } from "vitest";
import {
  actionFromUrl,
  EngagementPolicyEngine,
  engagementActionForToolCall,
  evaluateEngagementAction,
} from "../src/safety/engagement-policy.js";
import type { EngagementScope } from "../src/store/scope.js";

const scope: EngagementScope = {
  name: "local fixture",
  authorizedTargets: ["app.test", "127.0.0.1"],
  excludedTargets: ["admin.app.test"],
  allowedPhases: ["recon", "enumeration"],
  allowedPorts: [80, 443, 8080],
  allowedPaths: ["/api", "/health"],
  allowedMethods: ["GET", "POST"],
  maxRate: 2,
  maxConcurrency: 1,
  expiresAt: "2099-01-01T00:00:00.000Z",
};

describe("engagement target-aware policy matrix", () => {
  it("enforces target, exclusion, phase, port, path, and method", () => {
    expect(evaluateEngagementAction(scope, actionFromUrl({ url: "https://app.test/api/users", method: "POST" })).allowed).toBe(true);
    expect(evaluateEngagementAction(scope, actionFromUrl({ url: "https://admin.app.test/api" })).reason).toMatch(/excluded|not authorized/);
    expect(evaluateEngagementAction(scope, actionFromUrl({ url: "https://evil.test/api" })).allowed).toBe(false);
    expect(evaluateEngagementAction(scope, actionFromUrl({ url: "https://app.test/private" })).reason).toMatch(/path/);
    expect(evaluateEngagementAction(scope, actionFromUrl({ url: "https://app.test/api", method: "DELETE" })).reason).toMatch(/method/);
    expect(evaluateEngagementAction(scope, { ...actionFromUrl({ url: "https://app.test/api" }), phase: "exploitation" }).reason).toMatch(/phase/);
    expect(evaluateEngagementAction(scope, actionFromUrl({ url: "https://app.test:8443/api" })).reason).toMatch(/port/);
  });

  it("blocks every out-of-scope redirect hop and DNS rebinding address", () => {
    expect(evaluateEngagementAction(scope, actionFromUrl({
      url: "https://app.test/api",
      redirectChain: ["https://app.test/health", "https://evil.test/steal"],
    }))).toMatchObject({ allowed: false, reason: expect.stringMatching(/redirect/) });
    expect(evaluateEngagementAction(scope, actionFromUrl({
      url: "http://127.0.0.1:8080/api",
      resolvedAddresses: ["127.0.0.1", "10.0.0.9"],
    }))).toMatchObject({ allowed: false, reason: expect.stringMatching(/DNS/) });
  });

  it("enforces token-bucket rate and concurrency using a fake clock", () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const engine = new EngagementPolicyEngine(() => now);
    const action = actionFromUrl({ url: "https://app.test/api" });
    const first = engine.acquire(scope, action);
    expect(first.decision.allowed).toBe(true);
    expect(engine.acquire(scope, action).decision.reason).toMatch(/concurrency/);
    first.release();
    const second = engine.acquire(scope, action);
    expect(second.decision.allowed).toBe(true);
    second.release();
    expect(engine.acquire(scope, action).decision.reason).toMatch(/rate/);
    now += 500;
    // Half a second at 2/s replenishes one token.
    const replenished = engine.acquire(scope, action);
    expect(replenished.decision.allowed).toBe(true);
    replenished.release();
  });

  it("classifies active HTTP and adversarial shell.start capabilities by action", () => {
    expect(engagementActionForToolCall({ name: "http.fetch", args: { url: "https://app.test/api", method: "DELETE" } })).toMatchObject({
      phase: "exploitation",
      capability: "active-enumeration",
      method: "DELETE",
    });
    expect(engagementActionForToolCall({ name: "shell.start", args: { command: "hydra -l admin -P words.txt app.test" } })).toMatchObject({
      target: "app.test",
      phase: "exploitation",
      capability: "exploitation",
    });
    expect(engagementActionForToolCall({ name: "shell.start", args: { command: "launchctl load persistence.plist app.test" } })).toMatchObject({
      phase: "post-exploitation",
      capability: "persistence",
    });
    expect(engagementActionForToolCall({ name: "shell.exec", args: { command: "rm -rf /tmp/data app.test" } })).toMatchObject({
      phase: "post-exploitation",
      capability: "destructive",
    });
  });

  it("enforces the configured time window with an injected clock", () => {
    const expired = { ...scope, expiresAt: "2020-01-01T00:00:00Z" };
    expect(evaluateEngagementAction(expired, actionFromUrl({ url: "https://app.test/api" }), Date.parse("2026-01-01T00:00:00Z"))).toMatchObject({ allowed: false, reason: expect.stringMatching(/time window/) });
  });

  it("never blocks local-dev loopback GET/HEAD even with a remote engagement scope", () => {
    // Leftover pentest scope (remote targets only) must not block coding verify.
    const remoteOnly: EngagementScope = {
      authorizedTargets: ["evil-pentest.example"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    expect(
      evaluateEngagementAction(
        remoteOnly,
        actionFromUrl({ url: "http://localhost:5173/", method: "GET" }),
      ),
    ).toMatchObject({ allowed: true, reason: expect.stringMatching(/loopback|local/) });
    expect(
      evaluateEngagementAction(
        remoteOnly,
        actionFromUrl({ url: "http://127.0.0.1:3000/", method: "HEAD" }),
      ).allowed,
    ).toBe(true);
    // No engagement action at all for loopback http.fetch / curl verify.
    expect(
      engagementActionForToolCall({
        name: "http.fetch",
        args: { url: "http://localhost:5173/" },
      }),
    ).toBeUndefined();
    expect(
      engagementActionForToolCall({
        name: "shell.exec",
        args: {
          command:
            'curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/',
        },
      }),
    ).toBeUndefined();
    // Mutating loopback still goes through policy (not auto-skipped).
    expect(
      engagementActionForToolCall({
        name: "http.fetch",
        args: { url: "http://localhost:5173/api", method: "POST" },
      }),
    ).toMatchObject({ method: "POST", target: "localhost" });
  });
});
