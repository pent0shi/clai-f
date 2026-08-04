import { spawnSync } from "node:child_process";
import type { ClipboardPort } from "../ports/clipboard-port.js";

export interface InMemoryClipboard extends ClipboardPort {
  readonly lastText: string | undefined;
}

export function createInMemoryClipboardPort(): InMemoryClipboard {
  let last: string | undefined;
  return {
    get lastText() {
      return last;
    },
    async writeText(text: string) {
      last = text;
    },
    async readText() {
      return last;
    },
  };
}

export function createSystemClipboardPort(): InMemoryClipboard {
  let last: string | undefined;

  function writeSystem(text: string): void {
    const platform = process.platform;
    let attempts: Array<[string, string[]]> = [];
    if (platform === "darwin") {
      attempts = [["pbcopy", []]];
    } else if (platform === "linux") {
      attempts = [
        ["wl-copy", []],
        ["xclip", ["-selection", "clipboard"]],
        ["xsel", ["--clipboard", "--input"]],
      ];
    } else if (platform === "win32") {
      attempts = [["clip", []]];
    }

    for (const [cmd, args] of attempts) {
      try {
        const res = spawnSync(cmd, args, {
          input: text,
          timeout: 2000,
          stdio: ["pipe", "ignore", "ignore"],
        });
        if (res.status === 0) return;
      } catch {
        continue;
      }
    }
  }

  function readSystem(): string | undefined {
    const platform = process.platform;
    let attempts: Array<[string, string[]]> = [];
    if (platform === "darwin") {
      attempts = [["pbpaste", []]];
    } else if (platform === "linux") {
      attempts = [
        ["wl-paste", ["--no-newline"]],
        ["xclip", ["-selection", "clipboard", "-o"]],
        ["xsel", ["--clipboard", "--output"]],
      ];
    } else if (platform === "win32") {
      attempts = [["powershell", ["-command", "Get-Clipboard"]]];
    }

    for (const [cmd, args] of attempts) {
      try {
        const res = spawnSync(cmd, args, {
          timeout: 2000,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        if (res.status === 0 && typeof res.stdout === "string") {
          return res.stdout;
        }
      } catch {
        continue;
      }
    }
    return undefined;
  }

  return {
    get lastText() {
      return last;
    },
    async writeText(text: string) {
      last = text;
      writeSystem(text);
    },
    async readText() {
      const sysText = readSystem();
      if (sysText !== undefined) {
        last = sysText;
        return sysText;
      }
      return last;
    },
  };
}
