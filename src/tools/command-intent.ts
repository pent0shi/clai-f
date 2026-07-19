/**
 * Detect commands that are likely long-running servers, listeners, or
 * watch processes. These should be started as background jobs rather
 * than blocking the REPL.
 */

const LONG_RUNNING_PATTERNS: RegExp[] = [
  // Listeners / bind shells. Match nc/ncat with a listen flag in any flag
  // cluster form: -l, -lvnp, -nvlp, -p 4444 -l, etc.
  /\bnc(?:at)?\b[^|&;\n]*\s-[a-z]*l/i,
  /\bsocat\b.*\bLISTEN\b/i,

  // Python HTTP servers
  /\bpython3?\s+(-m\s+)?http\.server\b/i,
  /\bpython3?\s+(-m\s+)?SimpleHTTPServer\b/i,

  // Node/JS dev servers
  /\bnpm\s+run\s+dev\b/i,
  /\byarn\s+dev\b/i,
  /\bpnpm\s+dev\b/i,
  /\bbun\s+dev\b/i,
  /\bnpm\s+start\s*$/i,
  /\bnode\s+server\b/i,
  /\bnodemon\b/i,
  // Vite must be the invoked executable, not a package/path/argument token.
  // Applying this regex per shell segment keeps `.vite-tmp`, `npm install vite`,
  // and `cat vite.config.ts` in the foreground while still catching
  // `vite`, `npx vite`, and `/path/to/vite --host`.
  /^(?:(?:command|exec)\s+)?(?:(?:npx|bunx|pnpm\s+exec|yarn\s+exec|npm\s+exec)(?:\s+--yes)?\s+)?(?:\S*\/)?vite(?:@\S+)?(?:\s+(?!build\b|--help\b|--version\b).*)?$/i,
  /\bnext\s+dev\b/i,
  /\bnuxt\s+dev\b/i,

  // Log followers / watchers
  /\btail\s+.*-[fF]\b/i,
  /\bjournalctl\s+.*-f\b/i,
  /\bwatch\s+/i,
  /\bcargo\s+watch\b/i,

  // Docker
  /\bdocker\s+logs\s+.*-f\b/i,
  /\bdocker\s+compose\s+up\b/i,
  /\bdocker-compose\s+up\b/i,

  // Python/Ruby/Go servers
  /\buvicorn\b/i,
  /\bgunicorn\b/i,
  /\bflask\s+run\b/i,
  /\brails\s+(?:server|s)\b/i,
  /\bsinatra\b/i,

  // Other dev servers
  /\bphp\s+-S\b/i,
  /\bnginx\s*$/i,
  /\bapache2?\s*$/i,

  // Tunnel / proxy
  /\bngrok\s+http\b/i,
  /\bssh\s+.*-[DLRN]\b/i,
  /\bchisel\s+(server|client)\b/i,

  // Network listeners
  /\btcpdump\b/i,
  /\bwireshark\b/i,
  /\btshark\b.*-i\b/i,

  // Databases / services run in the foreground (these block until killed)
  /\bneo4j\s+console\b/i,
  /\bmongod\b/i,
  /\bredis-server\b/i,
  /\bmysqld\b/i,
  /\bpostgres\b/i,
  /\belasticsearch\b/i,
  /\bjava\s+-jar\b/i,
];

/**
 * Detect explicit job-control backgrounding (a bare ` & ` or trailing ` &`,
 * NOT `&&`, NOT the `2>&1` fd-dup). A command that backgrounds a process
 * keeps the piped stdout open, so running it via the blocking shell executor
 * hangs the agent until the timeout — route it to the job manager instead.
 */
function backgroundsAProcess(command: string): boolean {
  return /(?:^|[^&\d>])\s&(?:\s|$)/.test(command);
}

/**
 * One-shot project scaffolders — finish and exit. Must stay in the
 * foreground even when the command string mentions `vite` / `next`.
 */
const SCAFFOLD_FOREGROUND_PATTERNS: RegExp[] = [
  /\bnpm\s+create\b/i,
  /\bnpm\s+init\b/i,
  /\byarn\s+create\b/i,
  /\bpnpm\s+create\b/i,
  /\bbun\s+create\b/i,
  /\bnpx\s+(?:--yes\s+)?create-[\w-]+/i,
  /\bnpmx?\s+create-[\w-]+/i,
  /\bdeno\s+run\b.*\bcreate\b/i,
  // Non-JS one-shot project creators (must stay foreground)
  /\bcargo\s+new\b/i,
  /\bcargo\s+init\b/i,
  /\bgo\s+mod\s+init\b/i,
  /\bpoetry\s+new\b/i,
  /\bdjango-admin\s+startproject\b/i,
  /\brails\s+new\b/i,
  /\bcomposer\s+create-project\b/i,
  /\bmix\s+new\b/i,
  /\bflutter\s+create\b/i,
  /\bdotnet\s+new\b/i,
];

export function looksLikeOneShotScaffolder(command: string): boolean {
  return SCAFFOLD_FOREGROUND_PATTERNS.some((p) => p.test(command));
}

/**
 * Package-manager operations finish on their own even when an argument is
 * named after a server (`npm install vite`, `pnpm add postgres`, etc.). Keep
 * these segments in shell.exec; a later `&& npm run dev` segment is evaluated
 * independently and will still be backgrounded.
 */
const PACKAGE_OPERATIONS: Record<string, ReadonlySet<string>> = {
  npm: new Set(["i", "install", "add", "ci", "uninstall", "remove", "view", "info", "list", "ls", "pack", "publish", "audit", "outdated", "update"]),
  yarn: new Set(["add", "install", "remove", "info", "list", "pack", "publish", "audit", "outdated", "upgrade"]),
  pnpm: new Set(["add", "install", "i", "remove", "rm", "view", "info", "list", "ls", "pack", "publish", "audit", "outdated", "update"]),
  bun: new Set(["add", "install", "remove", "rm", "update", "outdated"]),
};

const OPTIONS_WITH_VALUE = new Set([
  "--workspace", "-w", "--prefix", "--cwd", "--config", "--userconfig",
  "--registry", "--cache", "--user", "-u", "--group", "-g",
]);

function baseCommand(token: string | undefined): string {
  return (token ?? "").replace(/^.*[\\/]/, "").toLowerCase();
}

/** Recognize finite package operations after common env/sudo/corepack wrappers. */
function looksLikeForegroundPackageOperation(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  while (/^[A-Za-z_][\w]*=.*/.test(tokens[index] ?? "")) index += 1;

  if (baseCommand(tokens[index]) === "env") {
    index += 1;
    while (tokens[index]?.startsWith("-") || /^[A-Za-z_][\w]*=.*/.test(tokens[index] ?? "")) {
      const option = tokens[index++]!;
      if (OPTIONS_WITH_VALUE.has(option)) index += 1;
    }
  }
  if (baseCommand(tokens[index]) === "sudo") {
    index += 1;
    while (tokens[index]?.startsWith("-")) {
      const option = tokens[index++]!;
      if (OPTIONS_WITH_VALUE.has(option)) index += 1;
    }
  }
  if (baseCommand(tokens[index]) === "corepack") index += 1;

  const manager = baseCommand(tokens[index]);
  const operations = PACKAGE_OPERATIONS[manager];
  if (!operations) return false;
  index += 1;
  while (tokens[index]?.startsWith("-")) {
    const option = tokens[index++]!;
    const optionName = option.split("=", 1)[0]!;
    if (OPTIONS_WITH_VALUE.has(optionName) && !option.includes("=")) index += 1;
  }
  return operations.has((tokens[index] ?? "").toLowerCase());
}

/** Split enough shell structure to classify executable segments independently. */
function commandSegments(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||;|\n|\|)\s*/g)
    .map((segment) => segment.replace(/^\\\s*/, "").trim())
    .filter(Boolean);
}

/**
 * Returns true if the command appears to be a long-running process that
 * should not block the foreground shell. This is a heuristic — false
 * negatives are safer than false positives.
 */
export function looksLongRunning(command: string): boolean {
  if (backgroundsAProcess(command)) return true;

  return commandSegments(command).some((segment) => {
    if (looksLikeOneShotScaffolder(segment)) return false;
    if (looksLikeForegroundPackageOperation(segment)) return false;
    return LONG_RUNNING_PATTERNS.some((pattern) => pattern.test(segment));
  });
}

/**
 * Finite commands that commonly exceed an interactive timeout or produce a
 * large stream. They run as durable jobs: the agent receives a stable id,
 * session-state reminders keep the job visible, and shell.tail can harvest
 * output incrementally without re-running the command.
 */
const LONG_FINITE_JOB_PATTERNS: readonly RegExp[] = [
  /^(?:\S*\/)?(?:nmap|masscan)\b/i,
  /^(?:\S*\/)?(?:ffuf|feroxbuster|gobuster|dirsearch|wfuzz|nikto|nuclei|sqlmap)\b/i,
  /^(?:\S*\/)?find\s+/i,
];

const ENV_OPTIONS_WITH_VALUE = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]);
const SUDO_OPTIONS_WITH_VALUE = new Set(["-C", "--close-from", "-D", "--chdir", "-g", "--group", "-h", "--host", "-p", "--prompt", "-R", "--chroot", "-T", "--command-timeout", "-u", "--user"]);
const TIMEOUT_OPTIONS_WITH_VALUE = new Set(["-k", "--kill-after", "-s", "--signal"]);

function skipWrapperOptions(
  tokens: string[],
  index: number,
  optionsWithValue: ReadonlySet<string>,
): number {
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "--") return index + 1;
    if (!token.startsWith("-") || token === "-") break;
    index += 1;
    const optionName = token.split("=", 1)[0]!;
    if (optionsWithValue.has(optionName) && !token.includes("=")) index += 1;
  }
  return index;
}

/** Remove common execution wrappers before classifying the real executable. */
function unwrapFiniteCommand(segment: string): string {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  for (let pass = 0; pass < 12 && index < tokens.length; pass += 1) {
    while (/^[A-Za-z_][\w]*=.*/.test(tokens[index] ?? "")) index += 1;
    const wrapper = baseCommand(tokens[index]);
    if (wrapper === "env") {
      index = skipWrapperOptions(tokens, index + 1, ENV_OPTIONS_WITH_VALUE);
      continue;
    }
    if (wrapper === "sudo") {
      index = skipWrapperOptions(tokens, index + 1, SUDO_OPTIONS_WITH_VALUE);
      continue;
    }
    if (wrapper === "command" || wrapper === "exec") {
      index = skipWrapperOptions(tokens, index + 1, new Set());
      continue;
    }
    if (wrapper === "timeout" || wrapper === "gtimeout") {
      index = skipWrapperOptions(tokens, index + 1, TIMEOUT_OPTIONS_WITH_VALUE);
      // GNU timeout requires a duration before the command.
      if (index < tokens.length) index += 1;
      continue;
    }
    break;
  }
  return tokens.slice(index).join(" ");
}

export function looksLikeLongFiniteCommand(command: string): boolean {
  return commandSegments(command).some((segment) => {
    const executable = unwrapFiniteCommand(segment);
    return LONG_FINITE_JOB_PATTERNS.some((pattern) => pattern.test(executable));
  });
}
