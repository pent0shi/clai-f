import net from "node:net";

export type HostKind = "ip" | "cidr" | "hostname";

export interface ParsedHost {
  kind: HostKind;
  value: string;
}

const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const SHORT_HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const SHELL_METACHAR_RE = /[\s;`$<>|&"'\\]/;

/**
 * Parse a network target as IP, CIDR, or hostname. Throws on shell-injection
 * attempts. The output is safe to pass to spawn() with `shell: false`.
 */
export function parseHost(raw: string): ParsedHost {
  const value = raw.trim();
  if (!value) {
    throw new Error(`Invalid host: empty value`);
  }
  if (SHELL_METACHAR_RE.test(value)) {
    throw new Error(`Invalid host "${value}": contains shell metacharacters`);
  }
  // CIDR: <ip>/<bits>
  if (value.includes("/")) {
    const [addr, maskRaw] = value.split("/");
    if (!addr || !maskRaw) {
      throw new Error(`Invalid CIDR: ${value}`);
    }
    const mask = Number(maskRaw);
    if (!Number.isInteger(mask)) {
      throw new Error(`Invalid CIDR mask: ${maskRaw}`);
    }
    const family = net.isIP(addr);
    if (family === 4) {
      if (mask < 0 || mask > 32) {
        throw new Error(`Invalid IPv4 CIDR mask: ${maskRaw}`);
      }
      return { kind: "cidr", value };
    }
    if (family === 6) {
      if (mask < 0 || mask > 128) {
        throw new Error(`Invalid IPv6 CIDR mask: ${maskRaw}`);
      }
      return { kind: "cidr", value };
    }
    throw new Error(`Invalid CIDR address: ${addr}`);
  }
  if (net.isIP(value)) {
    return { kind: "ip", value };
  }
  if (HOSTNAME_RE.test(value) || SHORT_HOSTNAME_RE.test(value)) {
    return { kind: "hostname", value: value.toLowerCase() };
  }
  throw new Error(`Invalid host: ${value}`);
}

/**
 * Validate an nmap-compatible port specification. Accepts:
 *   - single port: "80"
 *   - csv: "80,443,8080"
 *   - ranges: "1-1000"
 *   - mixed: "22,80,443,8000-9000"
 */
export function parsePortSpec(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error("Invalid port spec: empty");
  if (SHELL_METACHAR_RE.test(value)) {
    throw new Error(`Invalid port spec "${value}": shell metacharacters`);
  }
  if (!/^[\d,\-]+$/.test(value)) {
    throw new Error(`Invalid port spec: ${value}`);
  }
  for (const part of value.split(",")) {
    if (part.includes("-")) {
      const [lo, hi] = part.split("-").map((n) => Number(n));
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
        throw new Error(`Invalid port range: ${part}`);
      }
      if (lo === undefined || hi === undefined) {
        throw new Error(`Invalid port range: ${part}`);
      }
      if (lo < 1 || lo > 65535 || hi < 1 || hi > 65535 || lo > hi) {
        throw new Error(`Invalid port range: ${part}`);
      }
    } else {
      const n = Number(part);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`Invalid port: ${part}`);
      }
    }
  }
  return value;
}

export type ScanType = "syn" | "tcp" | "udp" | "ping";
export type TimingTemplate = "T0" | "T1" | "T2" | "T3" | "T4" | "T5";

export interface ScanProfile {
  scanType?: ScanType | undefined;
  topPorts?: number | undefined;
  serviceDetect?: boolean | undefined;
  scripts?: string[] | undefined;
  timing?: TimingTemplate | undefined;
  udp?: boolean | undefined;
}

const SCAN_PROFILE_KEYS = new Set([
  "scanType",
  "topPorts",
  "serviceDetect",
  "scripts",
  "timing",
  "udp",
]);

/** Normalize provider/model JSON into the exact safe scan-profile contract. */
export function normalizeScanProfile(raw: unknown): ScanProfile | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid profile: expected an object");
  }
  const input = raw as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !SCAN_PROFILE_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`Invalid profile field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
  const profile: ScanProfile = {};

  if (input.scanType !== undefined) {
    if (typeof input.scanType !== "string") {
      throw new Error("Invalid profile.scanType: expected syn, tcp, udp, or ping");
    }
    const scanType = input.scanType.toLowerCase();
    if (scanType !== "syn" && scanType !== "tcp" && scanType !== "udp" && scanType !== "ping") {
      throw new Error(`Invalid profile.scanType: ${input.scanType}`);
    }
    profile.scanType = scanType;
  }
  if (input.topPorts !== undefined) {
    const topPorts =
      typeof input.topPorts === "string" && /^\d+$/.test(input.topPorts.trim())
        ? Number(input.topPorts)
        : input.topPorts;
    if (
      typeof topPorts !== "number" ||
      !Number.isInteger(topPorts) ||
      topPorts < 1 ||
      topPorts > 65535
    ) {
      throw new Error("Invalid profile.topPorts: expected an integer from 1 to 65535");
    }
    profile.topPorts = topPorts;
  }
  for (const key of ["serviceDetect", "udp"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      throw new Error(`Invalid profile.${key}: expected a boolean`);
    }
    profile[key] = value;
  }
  if (input.timing !== undefined) {
    if (typeof input.timing !== "string") {
      throw new Error("Invalid profile.timing: expected T0 through T5");
    }
    const timing = input.timing.toUpperCase();
    if (!/^T[0-5]$/.test(timing)) {
      throw new Error(`Invalid profile.timing: ${input.timing}`);
    }
    profile.timing = timing as TimingTemplate;
  }
  if (input.scripts !== undefined) {
    const scripts = Array.isArray(input.scripts)
      ? input.scripts
      : typeof input.scripts === "string"
        ? input.scripts.split(",")
        : input.scripts === true
          ? ["default"]
          : input.scripts === false
            ? []
            : undefined;
    if (!scripts || scripts.some((script) => typeof script !== "string")) {
      throw new Error(
        "Invalid profile.scripts: expected an array of safe script names",
      );
    }
    profile.scripts = scripts
      .map((script) => script.trim())
      .filter((script) => script.length > 0);
  }
  return profile;
}

const SAFE_SCRIPT_RE = /^[a-z0-9_-]+(?:,[a-z0-9_-]+)*$/i;

/**
 * nmap scan-type flags that require raw sockets, i.e. root on Linux/macOS
 * and Administrator (+ Npcap) on Windows. The net.scan / pentest.recon
 * runners use this to decide when to wrap the scan in sudo / elevation and
 * when to fall back to an unprivileged TCP connect scan.
 */
const ROOT_SCAN_FLAGS = new Set([
  "-sS",
  "-sU",
  "-sO",
  "-sN",
  "-sF",
  "-sX",
  "-sA",
  "-sW",
  "-sM",
  "-sY",
  "-sZ",
  "-O",
]);

/** True when an nmap argv contains a scan type that needs root/Administrator. */
export function nmapScanNeedsPrivilege(argv: readonly string[]): boolean {
  return argv.some((token) => ROOT_SCAN_FLAGS.has(token));
}

/**
 * Rewrite a privileged nmap argv into an equivalent that runs WITHOUT root:
 * SYN/FIN/Xmas/etc. stealth variants become a TCP connect scan (-sT), and
 * flags that simply cannot run unprivileged (-O OS detection, -sU UDP,
 * -sO protocol) are dropped. Used as the automatic fallback when sudo /
 * elevation is declined or unavailable.
 */
export function toConnectScanArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  let haveConnect = false;
  for (const token of argv) {
    if (ROOT_SCAN_FLAGS.has(token)) {
      // These have no unprivileged equivalent — drop them.
      if (token === "-O" || token === "-sU" || token === "-sO") continue;
      // Every other raw-socket scan collapses to a single TCP connect scan.
      if (!haveConnect) {
        out.push("-sT");
        haveConnect = true;
      }
      continue;
    }
    out.push(token);
  }
  if (!haveConnect && !out.includes("-sT") && !out.includes("-sn")) {
    out.unshift("-sT");
  }
  return out;
}

/** True when argv already skips host discovery (-Pn). */
export function nmapArgvHasPn(argv: readonly string[]): boolean {
  return argv.some((t) => t === "-Pn" || t === "-P0" || t === "-PN");
}

/**
 * Last non-flag token that looks like a single host (IP/hostname), not a
 * CIDR/range. Used to decide when -Pn is safe/default for port scans.
 */
export function isNmapSingleHostTarget(argv: readonly string[]): boolean {
  for (let i = argv.length - 1; i >= 0; i -= 1) {
    const token = argv[i]!;
    if (!token || token.startsWith("-")) continue;
    // Skip values of previous flags (e.g. --top-ports 100).
    const prev = argv[i - 1];
    if (
      prev &&
      (prev === "-p" ||
        prev === "--top-ports" ||
        prev === "-T" ||
        prev === "--max-retries" ||
        prev === "--host-timeout" ||
        prev === "-oN" ||
        prev === "-oX" ||
        prev === "-oG" ||
        prev === "-iL" ||
        prev === "--script" ||
        prev === "--script-args")
    ) {
      continue;
    }
    if (token.includes("/")) return false; // CIDR
    // nmap ranges like 192.168.1.1-50 or 10.0.0.1,10.0.0.2
    if (/,/.test(token)) return false;
    if (/^\d+\.\d+\.\d+\.\d+-\d+/.test(token)) return false;
    return true;
  }
  return false;
}

/** Insert -Pn once near the front of argv (after any scan-type flags). */
export function withNmapSkipDiscovery(argv: readonly string[]): string[] {
  if (nmapArgvHasPn(argv)) return [...argv];
  // Don't force -Pn on pure host-discovery (-sn) sweeps — that would scan every IP.
  if (argv.includes("-sn") || argv.includes("-sL")) return [...argv];
  return ["-Pn", ...argv];
}

/** nmap reported success but host discovery found nothing / host "down". */
export function looksLikeNmapNoHostsUp(output: string): boolean {
  return /(?:0 hosts? up|host seems down|note:\s*host seems down|all \d+ scanned (?:ports|hosts) on .* are in ignored states)/i.test(
    output,
  );
}

/** Convert a structured scan profile into safe argv for nmap. */
export function profileToNmapArgs(rawProfile: ScanProfile = {}): string[] {
  const profile = normalizeScanProfile(rawProfile) ?? {};
  const args: string[] = [];
  // Default to a STEALTH SYN scan (-sS): it is quieter than a full TCP
  // connect, completes faster, and is the professional default. It needs
  // raw sockets (root on Linux/macOS, Administrator + Npcap on Windows), so
  // the net.scan / pentest.recon runners wrap it in sudo / elevation and
  // automatically fall back to a TCP connect scan (-sT) when privilege can't
  // be obtained. Pass scanType:"tcp" to force an unprivileged connect scan.
  if (profile.scanType === "tcp") args.push("-sT");
  else if (profile.scanType === "ping") args.push("-sn");
  else if (profile.scanType !== "udp") args.push("-sS"); // "syn" or unspecified
  if (profile.udp || profile.scanType === "udp") args.push("-sU");
  if (profile.serviceDetect) args.push("-sV");
  if (profile.timing) {
    if (!/^T[0-5]$/.test(profile.timing)) {
      throw new Error(`Invalid timing template: ${profile.timing}`);
    }
    args.push(`-${profile.timing}`);
  }
  if (typeof profile.topPorts === "number") {
    if (profile.topPorts <= 0) {
      // Model sent 0 or negative — treat as "not specified", don't crash
    } else if (
      !Number.isInteger(profile.topPorts) ||
      profile.topPorts > 65535
    ) {
      throw new Error(`Invalid topPorts: ${profile.topPorts}`);
    } else {
      args.push("--top-ports", String(profile.topPorts));
    }
  }
  if (profile.scripts && profile.scripts.length > 0) {
    const PLACEHOLDER_SCRIPTS = new Set([
      "safe-script-name",
      "script-name",
      "safe_script_name",
    ]);
    const filtered = profile.scripts.filter(
      (s) => !PLACEHOLDER_SCRIPTS.has(s),
    );
    if (filtered.length > 0) {
      const joined = filtered.join(",");
      if (!SAFE_SCRIPT_RE.test(joined)) {
        throw new Error(`Invalid scripts list: ${joined}`);
      }
      args.push("--script", joined);
    }
  }
  return args;
}

/**
 * Structured allow-list for the legacy free-form `flags` string on net.scan.
 * Value is the flag's arity. Anything not listed is rejected: the legacy path
 * must never be able to write files (-oN/-oA/--append-output/--stylesheet),
 * read attacker-chosen input (-iL/--resume/--datadir/--servicedb), pick
 * arbitrary targets (-iR), or load NSE scripts (--script*, which must go
 * through the structured `profile.scripts` field and its safe-name regex).
 */
const LEGACY_NMAP_FLAGS: Record<string, "none" | "value" | "script"> = {
  "-sS": "none", "-sT": "none", "-sU": "none", "-sV": "none", "-sn": "none",
  "-sL": "none", "-sA": "none", "-sW": "none", "-sF": "none", "-sX": "none",
  "-sN": "none", "-sM": "none", "-sY": "none", "-sZ": "none", "-sO": "none",
  "-Pn": "none", "-P0": "none", "-PN": "none", "-PE": "none", "-PP": "none",
  "-PM": "none", "-PR": "none", "-PS": "value", "-PA": "value", "-PU": "value",
  "-O": "none", "-A": "none", "-n": "none", "-R": "none", "-6": "none",
  "-F": "none", "-r": "none", "-v": "none", "-vv": "none", "-vvv": "none",
  "-d": "none", "-dd": "none",
  "--open": "none", "--reason": "none", "--traceroute": "none",
  "--osscan-guess": "none", "--osscan-limit": "none",
  "--version-all": "none", "--version-light": "none", "--version-trace": "none",
  "--defeat-rst-ratelimit": "none", "--defeat-icmp-ratelimit": "none",
  "--disable-arp-ping": "none", "--system-dns": "none",
  "--privileged": "none", "--unprivileged": "none", "--resolve-all": "none",
  "--badsum": "none", "--packet-trace": "none", "--fuzzy": "none",
  "-p": "value", "--exclude-ports": "value", "--top-ports": "value",
  "--port-ratio": "value", "--min-rate": "value", "--max-rate": "value",
  "--min-parallelism": "value", "--max-parallelism": "value",
  "--min-hostgroup": "value", "--max-hostgroup": "value",
  "--max-retries": "value", "--host-timeout": "value",
  "--scan-delay": "value", "--max-scan-delay": "value",
  "--initial-rtt-timeout": "value", "--min-rtt-timeout": "value",
  "--max-rtt-timeout": "value", "--version-intensity": "value",
  "--mtu": "value", "--data-length": "value", "--ttl": "value",
  "--source-port": "value", "-g": "value", "-e": "value",
  "--dns-servers": "value", "--exclude": "value",
  "--script": "script",
};

const LEGACY_TIMING_RE = /^-T[0-5]$/;
const LEGACY_FLAG_VALUE_RE = /^[A-Za-z0-9_.,:@/+-]+$/;

function legacyFlagArity(flag: string): "none" | "value" | "script" | undefined {
  if (LEGACY_TIMING_RE.test(flag)) return "none";
  return LEGACY_NMAP_FLAGS[flag];
}

/**
 * For backwards compatibility with the legacy `flags` string. Every token is
 * validated by NAME against {@link LEGACY_NMAP_FLAGS} and every value by
 * shape, so an unrecognized, file-writing, file-reading, or script-loading
 * flag is rejected before nmap is spawned (and before any privilege
 * escalation), in both the split (`-oN out`) and equals (`-oN=out`) forms.
 */
export function parseLegacyFlags(raw: string): string[] {
  const value = raw.trim();
  if (!value) return [];
  const tokens = value.split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (!/^[A-Za-z0-9_./@:=,-]+$/.test(token)) {
      throw new Error(`Invalid flag token: ${token}`);
    }
    if (!token.startsWith("-")) {
      throw new Error(
        `Invalid flag token: ${token}. The legacy flags string accepts nmap flags only — pass the target in "target" and ports in "ports".`,
      );
    }
    const eq = token.indexOf("=");
    const name = eq > 0 ? token.slice(0, eq) : token;
    const inlineValue = eq > 0 ? token.slice(eq + 1) : undefined;
    const arity = legacyFlagArity(name);
    if (!arity) {
      throw new Error(
        `Rejected nmap flag "${name}": not on the net.scan allow-list. Use the structured "profile" (scanType/topPorts/serviceDetect/scripts/timing) instead; output, input-file, script, and datadir flags are never allowed here.`,
      );
    }
    if (arity === "none") {
      if (inlineValue !== undefined) {
        throw new Error(`Flag ${name} does not take a value`);
      }
      out.push(name);
      continue;
    }
    const flagValue = inlineValue ?? tokens[i + 1];
    if (flagValue === undefined || flagValue.startsWith("-")) {
      throw new Error(`Flag ${name} requires a value`);
    }
    if (arity === "script") {
      // NSE script selection goes through the same safe-name regex as the
      // structured profile.scripts field: comma-separated script/category
      // names only, so a path, glob, or .nse file can never be loaded here.
      if (!SAFE_SCRIPT_RE.test(flagValue)) {
        throw new Error(
          `Invalid --script value "${flagValue}": use comma-separated script or category names (no paths, globs, or .nse files).`,
        );
      }
      if (inlineValue === undefined) i += 1;
      out.push(inlineValue === undefined ? name : token);
      if (inlineValue === undefined) out.push(flagValue);
      continue;
    }
    if (!LEGACY_FLAG_VALUE_RE.test(flagValue)) {
      throw new Error(`Invalid value for ${name}: ${flagValue}`);
    }
    if (inlineValue === undefined) i += 1;
    out.push(name, flagValue);
  }
  return out;
}
