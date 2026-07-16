/**
 * Run elevation-sensitive commands without hijacking the TTY.
 * Used when requestSecret is available (OpenTUI secret modal) so sudo never
 * prints "Password:" on the alternate screen or freezes keyboard/mouse.
 */

import { commandAvailable } from "../os/pkgmgr.js";
import type { ToolResult } from "../types.js";
import type { BackgroundSpawnSpec } from "./jobs.js";
import type { ToolRunOptions } from "./tool-types.js";
import {
  looksInteractiveStdin,
  spawnArgv,
} from "./shell.js";

/** True when the command is a simple leading-sudo form we can re-run with -S. */
export function extractSimpleSudoCommand(
  command: string,
): { inner: string } | undefined {
  const c = command.trim();
  // sudo [flags…] rest — only when not already -S / -n / --non-interactive
  if (!/^(?:\/\S+\/)?sudo\b/i.test(c)) return undefined;
  if (/\bsudo\s+(?:-[a-zA-Z]*[Sn]|--non-interactive|--stdin)\b/i.test(c)) {
    return undefined;
  }
  // Drop leading env assignments: FOO=bar sudo …
  const withoutEnv = c.replace(/^(?:[A-Za-z_][\w]*=\S+\s+)+/, "");
  const m = withoutEnv.match(
    /^(?:\/\S+\/)?sudo(?:\s+(?:-[^A-Z\s][^\s]*|--(?!non-interactive|stdin)\S+))*(?:\s+(.+))?$/i,
  );
  const inner = m?.[1]?.trim();
  if (!inner) return undefined;
  // Multi-stage pipelines with sudo in the middle — leave to caller.
  if (/[|&;]/.test(command) && !/^\s*sudo\b/i.test(withoutEnv)) {
    return undefined;
  }
  return { inner };
}

/**
 * Format a password for `sudo -S` stdin.
 * Strips only trailing newlines from the secret modal (passwords may contain spaces).
 */
export function formatSudoStdinPassword(password: string): string {
  return `${password.replace(/[\r\n]+$/g, "")}\n`;
}

export type PreparedElevation =
  | { prepared: true; spec: BackgroundSpawnSpec }
  | { prepared: false; result: ToolResult };

/**
 * Authenticate before reporting a privileged background job as started, then
 * return a shell:false spawn specification whose secret exists only as stdin.
 */
export async function preparePrivilegedBackgroundArgv(
  command: string,
  argv: string[],
  options: {
    signal?: AbortSignal | undefined;
    onOutput?: ToolRunOptions["onOutput"];
    requestSecret?: ToolRunOptions["requestSecret"];
    title?: string | undefined;
    prompt?: string | undefined;
  },
  dependencies: {
    available?: ((command: string) => Promise<boolean>) | undefined;
    runAuth?: (typeof spawnArgv) | undefined;
    isRoot?: (() => boolean) | undefined;
  } = {},
): Promise<PreparedElevation> {
  const isRoot = dependencies.isRoot ?? (() => process.getuid?.() === 0);
  if (isRoot()) {
    return { prepared: true, spec: { command, argv: [...argv] } };
  }
  const available = dependencies.available ?? commandAvailable;
  if (!(await available("sudo"))) {
    return {
      prepared: false,
      result: {
        ok: false,
        exitCode: 1,
        output: "This background command requires administrator access, but sudo is unavailable.",
      },
    };
  }
  if (!options.requestSecret) {
    return {
      prepared: false,
      result: {
        ok: false,
        exitCode: 1,
        output:
          "This background command requires administrator access, but no secure password prompt is available. " +
          "Run it from the interactive TUI or choose an explicitly unprivileged operation.",
      },
    };
  }

  const password = await options.requestSecret({
    title: options.title ?? "Administrator access",
    prompt:
      options.prompt ??
      "Enter your password for sudo. It is sent only to sudo stdin and is never stored. Esc cancels.",
  });
  if (password === undefined) {
    return {
      prepared: false,
      result: {
        ok: false,
        exitCode: 130,
        output: "Administrator authentication cancelled; no background job was started.",
      },
    };
  }

  const stdinText = formatSudoStdinPassword(password);
  const runAuth = dependencies.runAuth ?? spawnArgv;
  let auth: ToolResult;
  try {
    auth = await runAuth({
      command: "sudo",
      argv: ["-S", "-p", "", "-v"],
      stdinText,
      timeoutMs: 30_000,
      signal: options.signal,
      onOutput: options.onOutput,
      noArtifact: true,
      interactiveStdin: false,
    });
  } catch (error) {
    return {
      prepared: false,
      result: {
        ok: false,
        exitCode: 1,
        output: `sudo authentication could not start: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  if (options.signal?.aborted || auth.exitCode === 130) {
    return {
      prepared: false,
      result: {
        ok: false,
        exitCode: 130,
        output: auth.output || "Administrator authentication aborted; no background job was started.",
      },
    };
  }
  if (!auth.ok) {
    return {
      prepared: false,
      result: {
        ok: false,
        exitCode: auth.exitCode ?? 1,
        output: `sudo authentication failed; no background job was started.\n${(auth.output ?? "").trim().slice(0, 400)}`.trim(),
      },
    };
  }

  return {
    prepared: true,
    spec: {
      command: "sudo",
      argv: ["-S", "-p", "", command, ...argv],
      stdinText,
      display: ["sudo", command, ...argv].join(" "),
    },
  };
}

/** Prepare a simple leading-sudo shell command for detached execution. */
export async function prepareElevatedBackgroundCommand(
  shellCommand: string,
  options: Parameters<typeof preparePrivilegedBackgroundArgv>[2],
  dependencies?: Parameters<typeof preparePrivilegedBackgroundArgv>[3],
): Promise<PreparedElevation | undefined> {
  if (!looksInteractiveStdin(shellCommand)) return undefined;
  const simple = extractSimpleSudoCommand(shellCommand);
  if (!simple) {
    return {
      prepared: false,
      result: {
        ok: false,
        exitCode: 1,
        output:
          "This background command needs an interactive password prompt. Rephrase it as a simple leading `sudo <command>` so clai can forward the secure modal value only through stdin.",
      },
    };
  }
  return preparePrivilegedBackgroundArgv(
    "sh",
    ["-c", simple.inner],
    options,
    dependencies,
  );
}

/**
 * If the command needs a password TTY and we have a secret UI, authenticate
 * via requestSecret + sudo -S. Returns undefined when the normal path should
 * run. Returns a ToolResult when handled (success or clear failure).
 *
 * Important: we pipe the password into the *real* command with `sudo -S`.
 * Caching via `sudo -S -v` then `sudo -n …` fails on macOS/OpenTUI because
 * child processes are detached / non-TTY and the sudo timestamp ticket does
 * not carry over — you get "Administrator access confirmed" then
 * "sudo: a password is required".
 */
export async function tryRunElevatedWithoutTty(
  command: string,
  options: {
    cwd?: string | undefined;
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
    onOutput?: ToolRunOptions["onOutput"];
    requestSecret?: ToolRunOptions["requestSecret"];
  },
): Promise<ToolResult | undefined> {
  if (!options.requestSecret) return undefined;
  if (!looksInteractiveStdin(command)) return undefined;

  const simple = extractSimpleSudoCommand(command);
  if (!simple) {
    return {
      ok: false,
      exitCode: 1,
      output:
        "This command needs an interactive password prompt, which would freeze the UI. " +
        "Rephrase as a simple `sudo <command>` (clai will use a secure password modal), " +
        "use `sudo -n` if credentials are cached, or avoid elevation.",
    };
  }

  const password = await options.requestSecret({
    title: "Administrator access",
    prompt:
      "Enter your password for sudo. It is sent only to sudo and is never stored. Esc cancels.",
  });
  if (password === undefined) {
    return {
      ok: false,
      exitCode: 130,
      output:
        "Administrator authentication cancelled. Re-run and enter your password, or run without sudo.",
    };
  }

  const stdinPassword = formatSudoStdinPassword(password);

  // Validate the password first so we can show a clear error without starting
  // a long-running elevated command.
  const auth = await spawnArgv({
    command: "sudo",
    argv: ["-S", "-p", "", "-v"],
    stdinText: stdinPassword,
    timeoutMs: 30_000,
    signal: options.signal,
    onOutput: options.onOutput,
    noArtifact: true,
    interactiveStdin: false,
  });
  if (options.signal?.aborted || auth.exitCode === 130) {
    return auth.ok
      ? auth
      : {
          ok: false,
          exitCode: 130,
          output: auth.output || "Administrator authentication aborted.",
        };
  }
  if (!auth.ok) {
    return {
      ok: false,
      exitCode: auth.exitCode ?? 1,
      output:
        `sudo authentication failed.\n${(auth.output ?? "").trim().slice(0, 400)}`.trim(),
    };
  }

  // Re-send the password on the real run. Do NOT use `sudo -n` after -v:
  // detached non-TTY children often cannot use the timestamp ticket.
  return spawnArgv({
    command: "sudo",
    argv: ["-S", "-p", "", "sh", "-c", simple.inner],
    stdinText: stdinPassword,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onOutput: options.onOutput,
    interactiveStdin: false,
  });
}
