import type { EngagementScope } from "../store/scope.js";
import type { ToolCall } from "../types.js";
import {
  isLoopbackScopeTarget,
  normalizeScopeTarget,
  targetInScope,
} from "../store/scope.js";

export type ActionCapability =
  | "passive"
  | "active-enumeration"
  | "authentication"
  | "exploitation"
  | "persistence"
  | "destructive";

export type EngagementPhase =
  | "recon"
  | "enumeration"
  | "authentication"
  | "exploitation"
  | "post-exploitation";

export interface EngagementAction {
  target: string;
  url?: string | undefined;
  port?: number | undefined;
  path?: string | undefined;
  method?: string | undefined;
  phase: EngagementPhase;
  capability: ActionCapability;
  redirectChain?: string[] | undefined;
  resolvedAddresses?: string[] | undefined;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  normalizedTarget: string;
  capability: ActionCapability;
  phase: EngagementPhase;
}

const methodAllowed = (method: string, scope: EngagementScope): boolean => {
  if (!scope.allowedMethods?.length) return true;
  return scope.allowedMethods.some((allowed) => allowed.toUpperCase() === method.toUpperCase());
};

const pathAllowed = (path: string, scope: EngagementScope): boolean => {
  if (!scope.allowedPaths?.length) return true;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return scope.allowedPaths.some((allowed) => {
    const prefix = allowed.startsWith("/") ? allowed : `/${allowed}`;
    return normalized === prefix || normalized.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
  });
};

/**
 * Local coding verify (curl/http.fetch to the machine's own loopback) must
 * never be gated by a leftover remote pentest engagement scope.
 * Read-only methods only — POST/PUT/etc. on loopback still go through policy.
 */
export function isLocalDevProbeAction(action: EngagementAction): boolean {
  const host = normalizeScopeTarget(action.target) || action.target;
  if (!isLoopbackScopeTarget(host)) return false;
  const method = (action.method ?? "GET").toUpperCase();
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

export function evaluateEngagementAction(
  scope: EngagementScope | undefined,
  action: EngagementAction,
  now = Date.now(),
): PolicyDecision {
  const target = normalizeScopeTarget(action.target);
  const deny = (reason: string): PolicyDecision => ({
    allowed: false,
    reason,
    normalizedTarget: target,
    capability: action.capability,
    phase: action.phase,
  });
  // Always allow local-dev GET/HEAD/OPTIONS to loopback — coding sessions
  // often have an unrelated remote scope still configured from a prior pentest.
  // Exception: if DNS resolution escaped loopback (rebinding), fall through
  // to normal scope checks on resolvedAddresses.
  if (isLocalDevProbeAction(action)) {
    const resolved = action.resolvedAddresses ?? [];
    const escaped = resolved.some((addr) => !isLoopbackScopeTarget(addr));
    if (!escaped) {
      return {
        allowed: true,
        reason: "local loopback probe — engagement scope does not apply",
        normalizedTarget: target || "localhost",
        capability: action.capability,
        phase: action.phase,
      };
    }
  }
  if (!scope || !isScopeActiveAt(scope, now)) return deny("engagement scope is missing, empty, or outside its time window");
  if (!targetInScope(target, scope)) return deny(`target is excluded or not authorized: ${target}`);
  if (scope.allowedPhases?.length && !scope.allowedPhases.includes(action.phase)) {
    return deny(`phase is not authorized: ${action.phase}`);
  }
  if (action.port !== undefined && scope.allowedPorts?.length && !scope.allowedPorts.includes(action.port)) {
    return deny(`port is not authorized: ${action.port}`);
  }
  if (!methodAllowed(action.method ?? "GET", scope)) return deny(`HTTP method is not authorized: ${action.method}`);
  if (!pathAllowed(action.path ?? "/", scope)) return deny(`path is not authorized: ${action.path}`);

  for (const redirect of action.redirectChain ?? []) {
    if (!targetInScope(redirect, scope)) return deny(`redirect destination is excluded or out of scope: ${normalizeScopeTarget(redirect)}`);
  }
  for (const address of action.resolvedAddresses ?? []) {
    if (!targetInScope(address, scope)) return deny(`DNS resolution escaped authorized assets: ${address}`);
  }
  return {
    allowed: true,
    reason: "authorized by engagement scope",
    normalizedTarget: target,
    capability: action.capability,
    phase: action.phase,
  };
}

function isScopeActiveAt(scope: EngagementScope, now: number): boolean {
  if (!scope.authorizedTargets?.length) return false;
  if (!scope.expiresAt) return true;
  const expires = Date.parse(scope.expiresAt);
  return Number.isNaN(expires) || now <= expires;
}

export interface PolicyLease {
  decision: PolicyDecision;
  release: () => void;
}

/** In-memory token bucket/concurrency enforcement; inject clock for deterministic tests. */
export class EngagementPolicyEngine {
  private tokens = 0;
  private lastRefill = 0;
  private active = 0;
  private scopeIdentity = "";

  constructor(private readonly now: () => number = Date.now) {}

  acquire(scope: EngagementScope | undefined, action: EngagementAction): PolicyLease {
    const decision = evaluateEngagementAction(scope, action, this.now());
    if (!decision.allowed || !scope) return { decision, release: () => undefined };
    const identity = JSON.stringify([scope.name, scope.updatedAt, scope.authorizedTargets, scope.maxRate, scope.maxConcurrency]);
    const rate = Math.max(0, scope.maxRate ?? Number.POSITIVE_INFINITY);
    const concurrency = Math.max(1, Math.floor(scope.maxConcurrency ?? Number.MAX_SAFE_INTEGER));
    const now = this.now();
    if (identity !== this.scopeIdentity) {
      this.scopeIdentity = identity;
      this.tokens = Number.isFinite(rate) ? rate : Number.MAX_SAFE_INTEGER;
      this.lastRefill = now;
      this.active = 0;
    }
    if (this.active >= concurrency) {
      return { decision: { ...decision, allowed: false, reason: "engagement concurrency limit reached" }, release: () => undefined };
    }
    if (Number.isFinite(rate)) {
      const elapsedSeconds = Math.max(0, now - this.lastRefill) / 1_000;
      this.tokens = Math.min(rate, this.tokens + elapsedSeconds * rate);
      this.lastRefill = now;
      if (this.tokens < 1) {
        return { decision: { ...decision, allowed: false, reason: "engagement rate limit reached" }, release: () => undefined };
      }
      this.tokens -= 1;
    }
    this.active += 1;
    let released = false;
    return {
      decision,
      release: () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
      },
    };
  }
}

export function actionFromUrl(input: {
  url: string;
  method?: string | undefined;
  phase?: EngagementPhase | undefined;
  capability?: ActionCapability | undefined;
  redirectChain?: string[] | undefined;
  resolvedAddresses?: string[] | undefined;
}): EngagementAction {
  const parsed = new URL(input.url);
  return {
    target: parsed.hostname,
    url: input.url,
    port: parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80,
    path: parsed.pathname || "/",
    method: input.method ?? "GET",
    phase: input.phase ?? "enumeration",
    capability: input.capability ?? (/^(?:GET|HEAD|OPTIONS)$/i.test(input.method ?? "GET") ? "passive" : "active-enumeration"),
    redirectChain: input.redirectChain,
    resolvedAddresses: input.resolvedAddresses,
  };
}

export function engagementActionForToolCall(call: ToolCall): EngagementAction | undefined {
  if (call.name === "pentest.webDiscover") {
    const url = String(call.args.baseUrl ?? "");
    return url ? actionFromUrl({ url, phase: "enumeration", capability: "active-enumeration" }) : undefined;
  }
  if (call.name === "pentest.apiEnumerate") {
    const url = String(call.args.specUrl ?? "");
    return url ? actionFromUrl({ url, phase: "enumeration", capability: "active-enumeration" }) : undefined;
  }
  if (call.name === "pentest.authCompare") {
    const url = String(call.args.url ?? "");
    return url ? actionFromUrl({ url, phase: "authentication", capability: "authentication" }) : undefined;
  }
  if (call.name === "pentest.scanStatus") {
    const target = String(call.args.target ?? "");
    return target ? { target, path: "/", method: "GET", phase: "recon", capability: "passive" } : undefined;
  }
  if (call.name === "http.fetch") {
    const url = typeof call.args.url === "string" ? call.args.url : "";
    if (!url) return undefined;
    // Loopback GET/HEAD is local app verify — skip engagement action entirely
    // so leftover remote scopes never block coding live-checks.
    try {
      const host = new URL(url).hostname;
      const method = typeof call.args.method === "string" ? call.args.method : "GET";
      if (
        isLoopbackScopeTarget(host) &&
        /^(?:GET|HEAD|OPTIONS)$/i.test(method)
      ) {
        return undefined;
      }
    } catch {
      /* fall through to normal action */
    }
    return actionFromUrl({
      url,
      method: typeof call.args.method === "string" ? call.args.method : "GET",
      phase: /^(?:GET|HEAD|OPTIONS)$/i.test(String(call.args.method ?? "GET")) ? "enumeration" : "exploitation",
    });
  }
  if (call.name === "net.scan" || call.name === "pentest.recon") {
    const target = String(call.args.target ?? call.args.host ?? "");
    if (!target) return undefined;
    const port = typeof call.args.port === "number" ? call.args.port : undefined;
    return { target, port, path: "/", method: "GET", phase: "recon", capability: "active-enumeration" };
  }
  if (call.name !== "shell.exec" && call.name !== "shell.start") return undefined;
  const command = String(call.args.command ?? "");
  const url = command.match(/https?:\/\/[^\s'"<>]+/i)?.[0];
  const hostCandidates = [...command.matchAll(/(?:^|\s)((?:[a-z0-9-]+\.)+[a-z]{2,}|(?:\d{1,3}\.){3}\d{1,3})(?=\s|$)/gi)]
    .map((match) => match[1])
    .filter((candidate): candidate is string => Boolean(candidate));
  const host = url ? new URL(url).hostname : hostCandidates.at(-1);
  if (!host) return undefined;
  const method =
    /\bcurl\b[^\n]*\s-X\s+([A-Z]+)/i.exec(command)?.[1] ?? "GET";
  // curl/wget/httpie to the machine's own loopback is local app verify — do not
  // create an engagement action (remote scope must not block coding probes).
  if (
    isLoopbackScopeTarget(host) &&
    /^(?:GET|HEAD|OPTIONS)$/i.test(method) &&
    // Only skip when every host in the command is loopback (no mixed remote).
    hostCandidates.every((h) => isLoopbackScopeTarget(h))
  ) {
    return undefined;
  }
  const destructive = /\b(?:rm\s+-rf|mkfs|dd\s+if=|shutdown|reboot|drop\s+(?:database|table)|delete\s+from)\b/i.test(command);
  const persistence = /\b(?:crontab|launchctl|systemctl\s+enable|schtasks|authorized_keys|startup|persistence)\b/i.test(command);
  const exploitation = /\b(?:sqlmap|hydra|metasploit|msfconsole|exploit|payload|reverse.shell|csrf|xss|union\s+select)\b/i.test(command);
  const authentication = /\b(?:login|auth|password|credential|jwt|session|hydra)\b/i.test(command);
  const phase: EngagementPhase = destructive || persistence
    ? "post-exploitation"
    : exploitation
      ? "exploitation"
      : authentication
        ? "authentication"
        : "enumeration";
  const capability: ActionCapability = destructive
    ? "destructive"
    : persistence
      ? "persistence"
      : exploitation
        ? "exploitation"
        : authentication
          ? "authentication"
          : "active-enumeration";
  return {
    target: host,
    ...(url ? { url, port: Number(new URL(url).port || (new URL(url).protocol === "https:" ? 443 : 80)), path: new URL(url).pathname } : {}),
    method,
    phase,
    capability,
  };
}
