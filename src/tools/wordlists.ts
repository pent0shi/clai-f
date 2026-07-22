/**
 * Locate wordlist files for fuzzing tools. Searches known paths first, then
 * broadens to locate DB, full filesystem, and cached-credential sudo search so
 * wordlists are found regardless of install location or OS.
 *
 * All external searches run through async execFile (never execFileSync) so a
 * slow `find /` can never block the render loop, and sudo is only ever invoked
 * with `-n` (cached credentials) — it must NEVER inherit the TTY to prompt for
 * a password, which corrupts the OpenTUI screen and steals the keyboard.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../types.js";

const execFileAsync = promisify(execFile);

const IS_WIN = platform() === "win32";
const IS_MAC = platform() === "darwin";
function getHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

/**
 * Run a capture command without inheriting any std stream. Returns stdout on
 * success; on non-zero exit (e.g. `find` hitting permission-denied dirs) we
 * still recover whatever stdout was produced. Never throws.
 */
async function runCapture(
  command: string,
  argv: string[],
  timeoutMs: number,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, argv, {
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    return stdout ?? "";
  } catch (error) {
    const stdout = (error as { stdout?: string } | undefined)?.stdout;
    return typeof stdout === "string" ? stdout : "";
  }
}

// --- Known roots per OS ---

function knownRoots(): string[] {
  const home = getHome();
  const common = [
    join(home, "wordlists"),
    join(home, "SecLists"),
    join(home, "seclists"),
    join(home, ".wordlists"),
    join(home, "Documents", "wordlists"),
    join(home, "Documents", "SecLists"),
    join(home, "projects"),
    join(home, "github"),
    join(home, "repos"),
    join(home, "pentesting"),
    join(home, "pentest"),
  ];
  if (IS_WIN) {
    return [
      ...common,
      "C:\\SecLists",
      "C:\\Tools\\SecLists",
      "C:\\Tools\\wordlists",
      join(home, "Tools", "SecLists"),
    ];
  }
  if (IS_MAC) {
    return [
      ...common,
      "/opt/homebrew/share/seclists",
      "/opt/homebrew/share/wordlists",
      "/usr/local/share/seclists",
      "/usr/local/share/wordlists",
      "/opt/local/share/seclists",
      "/opt/local/share/wordlists",
      "/usr/share/wordlists",
      "/usr/share/seclists",
    ];
  }
  return [
    ...common,
    "/usr/share/wordlists",
    "/usr/share/seclists",
    "/usr/share/dirb/wordlists",
    "/usr/share/dirbuster/wordlists",
    "/usr/share/wfuzz/wordlist",
    "/opt/SecLists",
    "/opt/wordlists",
    "/var/wordlists",
    "/pentest",
  ];
}

// --- Aliases ---

const NAME_ALIASES: Record<string, string[]> = {
  common: ["common.txt", "common.txt.gz"],
  "common.txt": ["common.txt"],
  big: ["big.txt"],
  medium: ["directory-list-2.3-medium.txt"],
  small: ["directory-list-2.3-small.txt"],
  rockyou: ["rockyou.txt", "rockyou.txt.gz"],
  subdomains: ["subdomains-top1million-5000.txt", "subdomains-top1million-20000.txt"],
  "raft-small": ["raft-small-words.txt", "raft-small-directories.txt"],
  "raft-medium": ["raft-medium-words.txt", "raft-medium-directories.txt"],
};

function candidateFilenames(query: string): string[] {
  const lower = query.toLowerCase().trim();
  return NAME_ALIASES[lower] ?? [query];
}

// --- Search helpers ---

function parseLines(raw: string): string[] {
  return raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function buildFindNameExpr(filenames: string[]): string[] {
  return filenames.flatMap((f, i) => (i === 0 ? ["-name", f] : ["-o", "-name", f]));
}

// Quiet directory search: capped depth, timeout, stderr never inherited.
async function searchRoot(root: string, filenames: string[], maxDepth: number): Promise<string[]> {
  if (!existsSync(root)) return [];
  if (IS_WIN) {
    const namePattern = filenames.map((f) => `'${f.replace(/'/g, "''")}'`).join(",");
    const script =
      `Get-ChildItem -Path '${root.replace(/'/g, "''")}' -Recurse -File ` +
      `-Depth ${maxDepth} -ErrorAction SilentlyContinue ` +
      `| Where-Object { @(${namePattern}) -contains $_.Name } ` +
      `| Select-Object -First 20 -ExpandProperty FullName`;
    return parseLines(
      await runCapture("powershell.exe", ["-NoProfile", "-Command", script], 8_000),
    );
  }
  const nameExpr = buildFindNameExpr(filenames);
  return parseLines(
    await runCapture(
      "find",
      [root, "-maxdepth", String(maxDepth), "-type", "f", "(", ...nameExpr, ")"],
      8_000,
    ),
  );
}

// Query the locate/mlocate DB — fast, no root needed. POSIX only.
async function searchLocate(filenames: string[]): Promise<string[]> {
  if (IS_WIN) return [];
  const hits: string[] = [];
  for (const f of filenames) {
    hits.push(...parseLines(await runCapture("locate", ["-i", "-l", "20", f], 5_000)));
    if (hits.length > 0) break;
  }
  return hits;
}

// Full filesystem search. POSIX: find /, Windows: all drive letters.
async function searchFullFilesystem(filenames: string[]): Promise<string[]> {
  if (IS_WIN) {
    const namePattern = filenames.map((f) => `'${f.replace(/'/g, "''")}'`).join(",");
    const drives = parseLines(
      (
        await runCapture(
          "powershell.exe",
          ["-NoProfile", "-Command", "(Get-PSDrive -PSProvider FileSystem).Root -join ','"],
          3_000,
        )
      ).replace(/,/g, "\n"),
    );
    if (drives.length === 0) return [];
    const paths = drives.map((d) => `'${d.replace(/'/g, "''")}'`).join(",");
    const script =
      `Get-ChildItem -Path ${paths} -Recurse -File ` +
      `-Depth 6 -ErrorAction SilentlyContinue ` +
      `| Where-Object { @(${namePattern}) -contains $_.Name } ` +
      `| Select-Object -First 20 -ExpandProperty FullName`;
    return parseLines(
      await runCapture("powershell.exe", ["-NoProfile", "-Command", script], 15_000),
    );
  }
  const nameExpr = buildFindNameExpr(filenames);
  return parseLines(
    await runCapture(
      "find",
      ["/", "-maxdepth", "8", "-type", "f", "(", ...nameExpr, ")"],
      15_000,
    ),
  );
}

/**
 * Cached-credential sudo search only. We try `sudo -n find /` which succeeds
 * silently when a sudo timestamp is already valid and fails instantly (no
 * prompt) otherwise. We deliberately do NOT fall back to an interactive
 * `sudo find`: inheriting the TTY makes sudo print "Password:" straight to the
 * terminal, corrupting the TUI, freezing the keyboard, and never routing
 * through clai's secure modal. POSIX only.
 */
async function searchSudo(filenames: string[]): Promise<string[]> {
  if (IS_WIN) return [];
  const nameExpr = buildFindNameExpr(filenames);
  const findArgs = ["/", "-maxdepth", "8", "-type", "f", "(", ...nameExpr, ")"];
  return parseLines(await runCapture("sudo", ["-n", "find", ...findArgs], 15_000));
}


// --- Result builder ---

function found(hits: string[], source: string): ToolResult {
  return { ok: true, output: `${source}:\n${hits.join("\n")}`, exitCode: 0 };
}

// --- Main ---

export interface WordlistFindArgs {
  query: string;
  expand?: boolean | undefined;
}

export async function wordlistFind(args: WordlistFindArgs): Promise<ToolResult> {
  const query = args.query?.trim();
  if (!query) {
    return { ok: false, output: "wordlist.find requires a query, e.g. \"common.txt\" or \"rockyou\".", exitCode: 1 };
  }
  const filenames = candidateFilenames(query);
  const roots = knownRoots();

  // Pass 1: well-known install locations (shallow, fast).
  for (const root of roots) {
    const hits = await searchRoot(root, filenames, 6);
    if (hits.length > 0) return found(hits, "Found in a known wordlist location");
  }

  if (args.expand === false) {
    return {
      ok: false,
      output:
        `No match for "${query}" in known wordlist locations for ${platform()}.\n` +
        `Checked: ${roots.join(", ")}\n` +
        `Retry with expand=true to broaden the search, or pkg.install seclists.`,
      exitCode: 1,
    };
  }

  // Pass 2: broader user directories.
  const home = getHome();
  const broaderRoots = [
    join(home, "Downloads"), join(home, "Desktop"),
    join(home, "Documents"), join(home, "Projects"),
    join(home, "tools"), join(home, "Tools"),
    join(home, "github"), join(home, "repos"),
    join(home, "pentesting"), join(home, "pentest"),
    "/opt",
  ].filter((r) => !roots.includes(r));

  for (const root of broaderRoots) {
    const hits = await searchRoot(root, filenames, 4);
    if (hits.length > 0) return found(hits, "Found in user directory");
  }

  // Pass 3: locate database (fast indexed search, POSIX only).
  const locateHits = await searchLocate(filenames);
  if (locateHits.length > 0) return found(locateHits, "Found via locate database");

  // Pass 4: full filesystem search (find / or all Windows drives).
  const fsHits = await searchFullFilesystem(filenames);
  if (fsHits.length > 0) return found(fsHits, "Found via full filesystem search");

  // Pass 5: cached-credential sudo search (POSIX only, never prompts).
  const sudoHits = await searchSudo(filenames);
  if (sudoHits.length > 0) return found(sudoHits, "Found via elevated filesystem search");

  return {
    ok: false,
    output:
      `No wordlist matching "${query}" found after searching the entire filesystem.\n` +
      `Install one: pkg.install seclists (Linux/macOS) or clone https://github.com/danielmiessler/SecLists.\n` +
      `If credentials are not cached, an elevated search was skipped (clai never opens a raw sudo prompt).`,
    exitCode: 1,
  };
}
