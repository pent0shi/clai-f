import { execSync } from "node:child_process";
import { platform } from "node:os";
import type { ToolResult } from "../types.js";

export interface ToolAvailability {
  name: string;
  available: boolean;
  path?: string | undefined;
  version?: string | undefined;
  installHint?: string | undefined;
}

const VERSION_COMMANDS: Record<string, string[]> = {
  nmap: ["nmap", "--version"],
  ffuf: ["ffuf", "-V"],
  curl: ["curl", "--version"],
  python3: ["python3", "--version"],
  python: ["python", "--version"],
  node: ["node", "--version"],
  go: ["go", "version"],
  dig: ["dig", "-v"],
  whois: ["whois", "--version"],
  gobuster: ["gobuster", "version"],
  nikto: ["nikto", "-Version"],
  sqlmap: ["sqlmap", "--version"],
  hydra: ["hydra", "-h"],
  rg: ["rg", "--version"],
  jq: ["jq", "--version"],
  git: ["git", "--version"],
  docker: ["docker", "--version"],
  kubectl: ["kubectl", "version", "--client", "--short"],
  tesseract: ["tesseract", "--version"],
};

const INSTALL_HINTS: Record<string, string> = {
  nmap: "pkg.install nmap",
  ffuf: "go install github.com/ffuf/ffuf/v2@latest",
  gobuster: "go install github.com/OJ/gobuster/v3@latest",
  nikto: "pkg.install nikto",
  sqlmap: "pkg.install sqlmap",
  hydra: "pkg.install hydra",
  rg: "pkg.install ripgrep",
  jq: "pkg.install jq",
  dig: "pkg.install dnsutils (or bind-utils)",
  subfinder:
    "go install github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest",
  httpx: "go install github.com/projectdiscovery/httpx/cmd/httpx@latest",
  nuclei: "go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest",
  tesseract: "pkg.install tesseract",
};

/** True if path is only a project-local node_modules/.bin shim (not global). */
export function isProjectLocalNodeBin(path: string): boolean {
  return /(?:^|[/\\])node_modules[/\\]\.bin[/\\]/i.test(path);
}

function findCommand(name: string): string | undefined {
  try {
    const cmd =
      platform() === "win32" ? `where.exe ${name}` : `command -v ${name}`;
    // Sanitize PATH: drop node_modules/.bin entries so tool.check reports
    // real system installs, not an unrelated project's local vite/npm bins
    // (e.g. clai's node_modules while scaffolding on Desktop).
    const env = { ...process.env };
    if (env.PATH) {
      env.PATH = env.PATH.split(platform() === "win32" ? ";" : ":")
        .filter((p) => p && !/node_modules[/\\]\.bin$/i.test(p))
        .join(platform() === "win32" ? ";" : ":");
    }
    const result = execSync(cmd, {
      timeout: 3_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
    });
    const found = result.trim().split("\n")[0]?.trim();
    if (found && isProjectLocalNodeBin(found)) return undefined;
    return found;
  } catch {
    return undefined;
  }
}

function getVersion(name: string): string | undefined {
  const spec = VERSION_COMMANDS[name];
  if (!spec) return undefined;
  try {
    const result = execSync(spec.join(" "), {
      timeout: 5_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Take the first non-empty line containing a version-like pattern
    const lines = result.split("\n").filter(Boolean);
    for (const line of lines) {
      const ver = /(\d+\.\d+[.\w-]*)/.exec(line);
      if (ver?.[1]) return ver[1];
    }
    return lines[0]?.trim().slice(0, 60);
  } catch {
    return undefined;
  }
}

export async function checkTool(name: string): Promise<ToolAvailability> {
  const path = findCommand(name);
  if (!path) {
    return {
      name,
      available: false,
      installHint: INSTALL_HINTS[name],
    };
  }
  const version = getVersion(name);
  return {
    name,
    available: true,
    path,
    version,
  };
}

export async function checkTools(names: string[]): Promise<ToolAvailability[]> {
  return Promise.all(names.map((name) => checkTool(name)));
}

export async function toolCheckHandler(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // Canonical: tools: string[] | "a,b". Aliases for single-tool mistakes
  // models make from older schemas / prompts (name, binary, tool).
  const toolsRaw =
    args.tools ??
    args.name ??
    args.binary ??
    args.tool;
  let names: string[];
  if (Array.isArray(toolsRaw)) {
    names = toolsRaw.filter((t): t is string => typeof t === "string");
  } else if (typeof toolsRaw === "string") {
    names = toolsRaw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  } else {
    return {
      ok: false,
      output:
        'tool.check expects { "tools": ["nmap", "ffuf", ...] } or { "tools": "nmap,ffuf" }',
      exitCode: 1,
    };
  }

  if (names.length === 0) {
    return { ok: false, output: "No tool names provided.", exitCode: 1 };
  }
  if (names.length > 20) {
    return {
      ok: false,
      output: "tool.check accepts at most 20 tools per call.",
      exitCode: 1,
    };
  }

  const results = await checkTools(names);
  // Project-local CLIs: missing globally is fine for scaffold (use npx / local bin after install).
  const LOCAL_OPTIONAL = new Set([
    "vite",
    "next",
    "nuxt",
    "tsc",
    "eslint",
    "prettier",
    "webpack",
    "parcel",
  ]);
  /**
   * Interchangeable tool families. Missing one member is soft (○) when any
   * other member in this check (or on PATH) is available — e.g. yarn ✗ with
   * npm ✓ must not fail the whole tool.check (models often spray npm+yarn+pnpm).
   */
  const SUBSTITUTE_FAMILIES: string[][] = [
    ["npm", "yarn", "pnpm", "bun"],
    ["pip", "pip3", "poetry", "uv", "pipenv"],
    ["python", "python3"],
    ["node", "nodejs"],
  ];

  function familyOf(name: string): string[] | undefined {
    const n = name.toLowerCase();
    return SUBSTITUTE_FAMILIES.find((f) => f.includes(n));
  }

  function substituteAvailable(name: string): boolean {
    const family = familyOf(name);
    if (!family) return false;
    if (results.some((r) => family.includes(r.name.toLowerCase()) && r.available)) {
      return true;
    }
    // Substitute may not be in the requested list — probe PATH lightly
    for (const alt of family) {
      if (alt === name.toLowerCase()) continue;
      if (findCommand(alt)) return true;
    }
    return false;
  }

  function isSoftMissing(name: string): boolean {
    const n = name.toLowerCase();
    if (LOCAL_OPTIONAL.has(n)) return true;
    // Alternate package managers are always soft when missing: work proceeds with
    // whichever manager is present; never hard-fail the whole check for yarn alone.
    if (["yarn", "pnpm", "bun", "pipenv", "poetry", "uv"].includes(n)) return true;
    if (substituteAvailable(n)) return true;
    return false;
  }

  const lines = results.map((r) => {
    if (r.available) {
      const ver = r.version ? ` (${r.version})` : "";
      return `✓ ${r.name}${ver} — ${r.path}`;
    }
    const hint = r.installHint ? ` — install: ${r.installHint}` : "";
    if (LOCAL_OPTIONAL.has(r.name.toLowerCase())) {
      return (
        `○ ${r.name} — not on global PATH (ok for scaffold: use npx / project bin after install; ` +
        `project-local node_modules/.bin is ignored)${hint}`
      );
    }
    if (isSoftMissing(r.name)) {
      const fam = familyOf(r.name);
      const alts = fam
        ? fam.filter((x) => x !== r.name.toLowerCase()).join("/")
        : "an alternative";
      return `○ ${r.name} — not found (optional; ${alts} can substitute)${hint}`;
    }
    return `✗ ${r.name} — not found${hint}`;
  });

  // Fail only when a hard-required tool is missing. node+npm ✓ with yarn ○ is ok=true.
  const hardMissing = results.filter((r) => !r.available && !isSoftMissing(r.name));
  const ok = hardMissing.length === 0;
  const footer =
    hardMissing.length > 0
      ? `\n\nHard-missing (required): ${hardMissing.map((r) => r.name).join(", ")}. ` +
        `Install or use a substitute before relying on them.`
      : results.some((r) => !r.available)
        ? `\n\nNote: ○ = optional/substitute available — overall check OK. Proceed with the tools marked ✓.`
        : "";
  return {
    ok,
    output: lines.join("\n") + footer,
    exitCode: ok ? 0 : 1,
  };
}
