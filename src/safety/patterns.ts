export const destructiveCommandPatterns = [
  // Catastrophic recursive deletes: root, home, a glob of root, or a
  // top-level system directory. A normal `rm -rf /tmp/foo` is NOT blocked —
  // it falls through to a confirmation like any other delete.
  /\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*r[a-zA-Z]*\s+(?:["']?)(?:\/|\/\*|~\/?|\$HOME\/?|\/(?:etc|usr|bin|sbin|var|lib|lib64|boot|dev|sys|proc|root|opt|private|home|System|Library|Applications|Users)(?:\/\*?)?)(?:["'\s;|&]|$)/i,
  /\bdel\s+\/f\s+\/s\s+\/q\s+[A-Z]:\\/i,
  /\bformat\s+[A-Z]:/i,
  /\bdd\s+if=.*\s+of=\/dev\//,
  // Raw block-device writes through redirection (`> /dev/sda`, `>> /dev/nvme0n1`).
  />>?\s*\/dev\/(?:[sh]d[a-z]\d*|nvme\d+n\d+(?:p\d+)?|disk\d+|mmcblk\d+)\b/i,
  /mkfs\.[a-z0-9]+\s+\/dev\//i,
  // Recursive permission/ownership destruction of the whole filesystem.
  /\b(?:chmod|chown|chgrp)\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*R[a-zA-Z]*\s+\S+\s+\/(?:\s|$)/,
  /\bchmod\s+(?:-[a-zA-Z]*\s+)*777\s+\/(?:\s|$)/,
  // `find / -delete` / `find / -exec rm` sweeps from the filesystem root.
  /\bfind\s+\/\s+[^|;&]*-(?:delete|exec\s+rm)\b/i,
  // Truncating a critical system file to zero.
  /\btruncate\s+(?:-[a-zA-Z]*\s+)*-s\s*0\s+\/(?:etc|boot|var\/lib)\//i,
  /:\(\)\s*\{\s*:\|:\s*&\s*}\s*;/,
  /\bshutdown\b.*\b(now|\/s|\/r)\b/i,
];

/**
 * Commands that pipe remote content into a shell or push local data into a
 * network sink. These are RECOVERABLE and routinely legitimate — `curl
 * https://sh.rustup.rs | sh` is a documented installer, and `base64 file | nc
 * target 4444` is a textbook authorized-exfiltration test on an engagement —
 * so they are CONFIRMED rather than hard-blocked. The operator is the right
 * authority; a hard block only pushed the model into retrying variants.
 */
export const exfiltrationPatterns = [
  /curl\s+.*\|\s*sh/i,
  /wget\s+.*\|\s*sh/i,
  /tar\s+.*\|\s*(curl|nc|netcat)/i,
  // Note: scp/cat of .ssh/.env is intentionally NOT blocked — pentest/VAPT
  // work routinely reads remote sensitive paths on in-scope targets.
  /curl\s+.*-d\s+@\/(etc\/passwd|etc\/shadow)/i,
  /base64\s+.*\|\s*(curl|wget|nc)/i,
];

export const networkScanTools = ['nmap', 'masscan', 'nikto', 'sqlmap', 'gobuster', 'ffuf', 'hydra', 'dirb', 'wfuzz', 'nuclei'];

const networkScanToolSet = new Set(networkScanTools);

/**
 * One parsed executable segment of a command line. Every safety decision that
 * needs to know "which programs does this command actually run" goes through
 * {@link splitCommandSegments} so a single shared representation is used
 * instead of per-rule substring matching.
 */
export interface CommandSegment {
  raw: string;
  tokens: string[];
  base: string;
  sub: string | undefined;
  elevated: boolean;
}

const SEGMENT_SPLIT_RE = /(?:\|\||&&|;|\||\n)/g;

/**
 * Split a command line on pipes / chaining operators and resolve the real
 * executable of each segment, seeing through env-var prefixes, `command`,
 * `exec`, `time`, and `sudo`/`doas` (including their value-taking flags).
 */
export function splitCommandSegments(command: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  for (const raw of command.split(SEGMENT_SPLIT_RE)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    let i = 0;
    let elevated = false;
    while (i < tokens.length && /^[A-Za-z_][\w]*=.*$/.test(tokens[i]!)) i += 1;
    while (
      i < tokens.length &&
      (tokens[i] === "command" || tokens[i] === "exec" || tokens[i] === "time")
    ) {
      i += 1;
    }
    if (i < tokens.length && (tokens[i] === "sudo" || tokens[i] === "doas")) {
      elevated = true;
      i += 1;
      while (i < tokens.length && tokens[i]!.startsWith("-")) {
        const flag = tokens[i]!;
        i += 1;
        if (/^-(?:u|g|p|C|h|U|r|t|T)$/.test(flag) && i < tokens.length) i += 1;
      }
    }
    const head = tokens[i];
    if (!head) continue;
    segments.push({
      raw: trimmed,
      tokens: tokens.slice(i),
      base: head.replace(/^.*[\\/]/, "").toLowerCase(),
      sub: tokens[i + 1],
      elevated,
    });
  }
  return segments;
}

export function isApprovedScannerSegment(segment: CommandSegment): boolean {
  return networkScanToolSet.has(segment.base);
}

/**
 * Commands that never mutate state and never expose secrets through their
 * default arguments. Powerful commands whose arguments can leak data
 * (cat, env, python, node, git, npm, pip, tee, xargs, curl, wget) are
 * intentionally NOT here — they fall through to `subcommandSafeMap` or
 * to the metacharacter-aware confirm path in classifier.ts.
 */
export const readOnlyShellCommands = new Set([
  // system info
  'whoami', 'hostname', 'uname', 'uptime', 'date', 'id', 'arch', 'sw_vers',
  'lsb_release', 'hostnamectl', 'locale', 'ulimit',
  'pwd', 'cd', 'test', 'true', 'false', 'basename', 'dirname',
  // file inspection (read-only listings; cat/head/tail can leak secrets so they
  // are subcommand-checked separately for known-safe paths)
  'ls', 'dir', 'wc', 'file', 'stat',
  'find', 'which', 'where', 'whereis', 'type', 'readlink', 'realpath',
  'tree', 'du', 'df', 'lsof', 'md5', 'md5sum', 'sha256sum', 'shasum',
  // networking info (state-changing CLIs like ip/nmcli/route/arp are NOT here —
  // they live in subcommandSafeMap so only their read verbs auto-run)
  'ifconfig', 'ipconfig', 'ping', 'traceroute', 'tracert', 'dig',
  'nslookup', 'host', 'whois', 'netstat', 'ss',
  'iwconfig',
  // process info
  'ps', 'top', 'htop', 'pgrep', 'lscpu', 'free', 'vmstat', 'iostat',
  // text processing (operate on stdin/files — safe by themselves)
  'echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'awk', 'sed',
  'sort', 'uniq', 'cut', 'tr', 'diff', 'comm', 'jq',
  // recon / scanning that classifier already gates separately
  'whatweb', 'wpscan',
  'sublist3r', 'amass', 'subfinder', 'httpx',
]);

/**
 * Subcommand allowlist for powerful CLIs. The classifier treats
 * `<cmd> <subcmd> …` as safe iff `subcommandSafeMap[cmd]` contains
 * `subcmd`. Anything else falls through to confirm.
 *
 * `config` is intentionally NOT here for git/npm/pnpm/yarn — `git config
 * --global ...` and `npm config set ...` mutate user-level state and
 * should always confirm. Read-only forms (`git config --get foo`,
 * `npm config get registry`) are caught by `mutatingArgPatterns` below
 * so they can still auto-execute when the args are clearly read-only.
 */
export const subcommandSafeMap: Record<string, Set<string>> = {
  git: new Set([
    'status', 'log', 'diff', 'show', 'branch', 'tag',
    'remote', 'rev-parse', 'describe', 'blame',
    'shortlog', 'reflog', 'stash', 'ls-files', 'ls-tree',
  ]),
  npm: new Set([
    'view', 'list', 'ls', 'outdated', 'audit', 'info',
    'search', 'whoami', 'help', 'ping',
  ]),
  pnpm: new Set([
    'list', 'ls', 'outdated', 'why', 'view', 'info', 'help',
  ]),
  yarn: new Set([
    'list', 'why', 'outdated', 'info', 'help',
  ]),
  pip: new Set(['show', 'list', 'freeze', 'check', 'help']),
  pip3: new Set(['show', 'list', 'freeze', 'check', 'help']),
  brew: new Set(['list', 'info', 'search', 'outdated', 'help', 'doctor', 'deps', 'services']),
  apt: new Set(['list', 'search', 'show', 'help']),
  dpkg: new Set(['-l', '-s', '-L', '--list', '--status', '--listfiles']),
  rpm: new Set(['-q', '-qa', '-qi', '-ql', '--query']),
  docker: new Set(['ps', 'images', 'inspect', 'logs', 'version', 'info', 'history']),
  kubectl: new Set(['get', 'describe', 'logs', 'version', 'cluster-info', 'api-resources', 'api-versions']),
  // Network configuration CLIs: only the read verbs are safe. `ip link set`,
  // `ip addr add`, `ip route del`, `nmcli con delete`, and `route delete`
  // change host networking and must confirm.
  ip: new Set(['show', 'list', 'sh', 'l', 'monitor', 'help']),
  nmcli: new Set(['show', 'list', 'status', 'help']),
  route: new Set(['show', 'list', 'get', 'print', '-n']),
  arp: new Set(['-a', '-n', '-e', '-v', 'show', 'list']),
};

/**
 * Second-token read verbs for the network CLIs above, so `ip addr show`,
 * `ip -br link`, `nmcli device status`, and `nmcli connection show` auto-run
 * while any other verb confirms. `undefined` means "no verb at all", which is
 * a plain listing (`ip addr`, `nmcli`) and therefore read-only.
 */
const NETWORK_OBJECT_WORDS: Record<string, Set<string>> = {
  ip: new Set([
    'addr', 'a', 'address', 'link', 'l', 'route', 'r', 'neigh', 'n',
    'neighbour', 'neighbor', 'rule', 'maddr', 'tunnel', 'netns', 'monitor',
  ]),
  nmcli: new Set([
    'device', 'dev', 'd', 'connection', 'con', 'c', 'general', 'g',
    'networking', 'n', 'radio', 'r', 'monitor', 'agent',
  ]),
};

const NETWORK_READ_VERBS = new Set([
  'show', 'list', 'sh', 'ls', 'l', 'status', 'get', 'print', 'monitor', 'help',
]);

/**
 * True when a network-configuration command mutates host state. `ip`, `nmcli`,
 * `route`, and `arp` are argument-shaped rather than subcommand-shaped, so the
 * read verbs are enumerated explicitly and everything else (set/add/del/
 * delete/flush/up/down/modify/replace/change) requires confirmation.
 */
export function commandHasStatefulSysadminArg(command: string): boolean {
  for (const segment of splitCommandSegments(command)) {
    const objects = NETWORK_OBJECT_WORDS[segment.base];
    if (segment.base === 'route' || segment.base === 'arp') {
      const words = segment.tokens
        .slice(1)
        .filter((token) => !token.startsWith('-'));
      const verb = words[0]?.toLowerCase();
      if (verb === undefined) continue;
      if (NETWORK_READ_VERBS.has(verb)) continue;
      return true;
    }
    if (!objects) continue;
    const words = segment.tokens
      .slice(1)
      .filter((token) => !token.startsWith('-'));
    const object = words[0]?.toLowerCase();
    if (object === undefined) continue;
    if (!objects.has(object)) {
      // Unknown object word for this CLI — be conservative and confirm.
      return true;
    }
    const verb = words[1]?.toLowerCase();
    if (verb === undefined) continue;
    if (NETWORK_READ_VERBS.has(verb)) continue;
    return true;
  }
  return false;
}

/**
 * Patterns that move an otherwise-safe-looking command into the
 * confirm bucket because their arguments mutate state, exfiltrate
 * data, or escape into another shell:
 *   - `sed -i …`            in-place file rewrite
 *   - `awk … system(...)`   shell-out via awk's system()
 *   - `awk … |getline …`    arbitrary command via getline
 *   - `find … -exec …`      run arbitrary commands
 *   - `find … -delete`      delete matched files
 *   - `git config --global` / `git config --system` write user/system git config
 *   - `npm config set …`    persist npm/yarn/pnpm config
 *   - `<cmd> --output-document=…` / `-o …` for fetchers (curl/wget) when
 *     not GET — handled separately, but pattern caught here for safety
 */
export const mutatingArgPatterns: RegExp[] = [
  /\bsed\b[^|]*\s-i(?:[^a-z]|$)/i,
  /\bawk\b[^|]*\bsystem\s*\(/i,
  /\bawk\b[^|]*\|\s*getline\b/i,
  /\bfind\b[^|]*\s-(?:exec|execdir|delete|ok|okdir)\b/i,
  /\bgit\s+config\s+(?:--global|--system|--add|--unset|--replace-all|[^-\s]+\s+\S)/i,
  /\bnpm\s+config\s+(?:set|delete|edit)\b/i,
  /\bpnpm\s+config\s+(?:set|delete|edit)\b/i,
  /\byarn\s+config\s+(?:set|delete)\b/i,
  /\bbrew\s+(?:install|uninstall|remove|upgrade|reinstall|cask|tap|untap|link|unlink|pin|unpin|cleanup)\b/i,
  /\bdocker\s+(?:run|exec|build|push|pull|rm|rmi|stop|kill|start|restart|cp|commit|login)\b/i,
  /\bkubectl\s+(?:apply|create|delete|edit|patch|replace|exec|cp|drain|rollout|scale|attach|run|label|annotate|cordon|uncordon)\b/i,
];

export function commandHasMutatingArg(command: string): boolean {
  return mutatingArgPatterns.some((pattern) => pattern.test(command));
}

/**
 * Base commands whose whole job is to MUTATE state — create/copy/move/delete
 * files, change ownership/permissions, write to disk, install packages, build
 * artifacts, or control services/processes. These always require confirmation
 * even when they appear without any obviously dangerous flag.
 *
 * The policy this powers is: benign/read-only commands auto-run, but anything
 * that installs, deletes, modifies, moves, or copies (or needs elevation) must
 * be confirmed first. Package managers and build tools are included because
 * they write to disk and pull remote code.
 */
export const mutatingCommandBases = new Set([
  // file mutation
  "mv",
  "cp",
  "rm",
  "rmdir",
  "mkdir",
  "touch",
  "ln",
  "link",
  "rename",
  "dd",
  "tee",
  "truncate",
  "shred",
  "install",
  "patch",
  "chmod",
  "chown",
  "chgrp",
  "chattr",
  "setfacl",
  "mkfs",
  "mkswap",
  "fallocate",
  "split",
  // archives that write to disk
  "unzip",
  "gunzip",
  "bunzip2",
  "unxz",
  "7z",
  // transfer / sync that writes
  "rsync",
  "scp",
  "sftp",
  // process / service / system control
  "mount",
  "umount",
  "crontab",
  "reboot",
  "halt",
  "poweroff",
  "useradd",
  "userdel",
  "usermod",
  "groupadd",
  "passwd",
  // package managers / installers
  "apt",
  "apt-get",
  "dpkg",
  "dnf",
  "yum",
  "rpm",
  "pacman",
  "zypper",
  "apk",
  "snap",
  "flatpak",
  "brew",
  "port",
  "choco",
  "winget",
  "scoop",
  "gem",
  "cargo",
  "go",
  "pip",
  "pip3",
  "pipx",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  // build systems (write artifacts)
  "make",
  "cmake",
  "ninja",
  "gradle",
  "mvn",
  "msbuild",
  // VCS / containers / orchestration whose mutating subcommands are not on
  // the read-only allowlist (status/log/diff/ps/images/etc. are checked and
  // allowed *before* this set, so only the mutating subcommands land here).
  "git",
  "docker",
  "kubectl",
  "podman",
]);

/**
 * Detect a redirection that WRITES TO A REAL FILE — the only kind that should
 * gate behind a confirmation. Discards and fd-duplications are NOT real
 * writes and must auto-run, because the agent uses them on nearly every
 * command:
 *   - `2>/dev/null`, `>/dev/null`, `&>/dev/null`   → discard (safe)
 *   - `2>&1`, `>&2`, `1>&2`                         → fd-dup (safe)
 *   - `> out.txt`, `>> log`, `&> out`              → real write (confirm)
 *
 * Command substitution `$(...)`/backticks and plain `sudo` are intentionally
 * NOT treated as writes here: they are extremely common and any actual
 * mutation is caught by {@link commandIsMutating} (which sees through a
 * leading `sudo`/`doas`). Keeping them out of the confirm path is what lets
 * the agent run ordinary commands without a prompt on every call.
 */
export function commandWritesOrEscalates(command: string): boolean {
  // Strip fd-duplications (2>&1, >&2, 1>&2, &>&1) — these never touch disk.
  const withoutDup = command.replace(/\d*>&\d+|&>&\d+/g, " ");
  // Find redirection operators and the target token that follows.
  const re = /(?:&?>>?)\s*('[^']*'|"[^"]*"|[^\s;|&<>()]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(withoutDup)) !== null) {
    const target = (match[1] ?? "").replace(/^['"]|['"]$/g, "");
    if (!target) continue;
    // Discards / terminal devices are not real file writes.
    if (/^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(target)) continue;
    return true;
  }
  return false;
}

/**
 * A bare version/help probe like `node --version`, `npm -v`, `go version`,
 * `python3 --version`, `docker --help`. These are read-only even though the
 * base command (node/npm/go/…) is otherwise a mutating/build tool, so they
 * must auto-run without a confirmation. We only treat a command as a probe
 * when its SOLE argument is a version/help token (and there are no
 * redirects / substitutions / chains that could do more), so `rm -v file` or
 * `npm version patch` are NOT misread as probes.
 */
const VERSION_HELP_TOKEN_RE =
  /^(?:--version|-version|-v|-V|--versions|version|--help|-help|-h|help|--usage)$/i;

export function isVersionOrHelpProbe(command: string): boolean {
  if (/[<>`$()]/.test(command)) return false;
  const segments = command
    .split(/(?:\|\||&&|;|\|)/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    const tokens = segment.split(/\s+/);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][\w]*=.*$/.test(tokens[i]!)) i += 1;
    if (
      i < tokens.length &&
      (tokens[i] === "sudo" ||
        tokens[i] === "doas" ||
        tokens[i] === "command" ||
        tokens[i] === "exec" ||
        tokens[i] === "time")
    ) {
      i += 1;
    }
    const args = tokens.slice(i + 1);
    return args.length === 1 && VERSION_HELP_TOKEN_RE.test(args[0]!);
  });
}

/**
 * Split a command line on pipes / chaining operators and report whether ANY
 * segment is a mutating command. A segment is mutating when its base command
 * is in {@link mutatingCommandBases} AND it is not a known read-only
 * subcommand of that base (so `git status` / `docker ps` / `npm list` are NOT
 * flagged, while `git push` / `docker run` / `npm install` are). In-place /
 * state-mutating ARGUMENTS (sed -i, find -exec, …) are handled separately by
 * {@link commandHasMutatingArg}, which callers check first.
 *
 * This lets a chain of purely read-only commands (`grep x foo | sort | head`)
 * auto-run, while a chain that includes a mutator (`cat a | tee b`) is flagged.
 */
export function commandIsMutating(command: string): boolean {
  for (const segment of splitCommandSegments(command)) {
    const { base, sub } = segment;
    if (!mutatingCommandBases.has(base)) continue;
    // A read-only subcommand of an otherwise-mutating CLI (git status,
    // docker ps, npm list) is NOT a mutation.
    const allow = subcommandSafeMap[base];
    if (allow && sub && (allow.has(sub) || allow.has(sub.replace(/^--/, "")))) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * True only when EVERY executable segment of the command is either an
 * approved network scanner or an already-read-only command, and at least one
 * segment is a scanner. This is what makes the scanner exemption monotonic:
 * a scanner token can never turn a mutating or unknown segment into `safe`,
 * so `nmap host && rm -rf build` or `nmap host > /etc/hosts` keep the risk
 * level they would have had without the scanner word.
 */
export function commandIsScannerOnly(command: string): boolean {
  const segments = splitCommandSegments(command);
  if (segments.length === 0) return false;
  let sawScanner = false;
  for (const segment of segments) {
    if (isApprovedScannerSegment(segment)) {
      sawScanner = true;
      continue;
    }
    if (readOnlyShellCommands.has(segment.base)) continue;
    const allow = subcommandSafeMap[segment.base];
    const sub = segment.sub;
    if (allow && sub && (allow.has(sub) || allow.has(sub.replace(/^--/, "")))) {
      continue;
    }
    return false;
  }
  return sawScanner;
}

/**
 * @deprecated Secret-path hard blocks were removed. Patterns retained only
 * for diagnostics / legacy tests — {@link isSecretPath} always returns false
 * so pentest reads of .ssh/.env on targets are never gated by the agent.
 */
export const secretPathPatterns: RegExp[] = [
  /\/\.ssh(\/|$)/,
  /\/\.gnupg(\/|$)/,
  /\/\.aws(\/|$)/,
  /\/\.kube(\/|$)/,
  /\/\.docker\/config\.json$/,
  /\/\.npmrc$/,
  /\/\.pypirc$/,
  /\/\.netrc$/,
  /\/\.env(\.[\w.-]+)?$/,
  /\/\.git-credentials$/,
  /\/\.clai\/keys\.json$/,
  /\/id_rsa(\.|$)/,
  /\/id_ed25519(\.|$)/,
  /\/id_ecdsa(\.|$)/,
  /\.pem$/,
  /\.p12$/,
  /\.pfx$/,
  /\/etc\/shadow$/,
  /\/etc\/gshadow$/,
];

/**
 * Always false — secret-path hard gates were removed so agents can freely
 * read/write/fetch paths used in pentest (e.g. remote .ssh, .env dumps).
 * Destructive deletes still go through the confirmation UI separately.
 */
export function isSecretPath(_path: string): boolean {
  return false;
}

/**
 * Shell metacharacters that change the semantics of a command. When any of
 * these appear, even a base command on the read-only allowlist falls
 * through to confirm, because the arguments could mutate state or exfil
 * data. Inside single/double quotes we still treat the command as
 * compound — better to over-confirm than under-confirm.
 */
const SHELL_METACHAR_RE = /(?:\|\||&&|\||;|`|\$\(|<\(|>\(|>>|>|<<|<|\bsudo\b)/;

export function containsShellMetacharacter(command: string): boolean {
  return SHELL_METACHAR_RE.test(command);
}
