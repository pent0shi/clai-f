// Deterministic interactive child used by interactive-session tests.
//
// Commands (one per line on stdin):
//   echo <text>        -> prints text immediately
//   delay <ms> <text>  -> prints text after ms
//   unsolicited <n>    -> prints n unsolicited lines, 10ms apart, with no input
//   binary             -> writes invalid UTF-8 bytes
//   ansi               -> writes SGR + OSC + CR + backspace sequences
//   secret <value>     -> prints the value split across two writes
//   err <text>         -> prints text on stderr
//   spawn              -> spawns a child that spawns a grandchild
//   tree <dir>         -> reports root/child/grandchild pids and heartbeats
//   ignore-term        -> installs a SIGTERM handler that refuses to exit
//   sig                -> reports the next signal it receives
//   exit <code>        -> exits with code
//
// It prints "ready>" on start and echoes a prompt after each command so tests
// can assert on quiet-interval behavior deterministically.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let ignoreTerm = false;
const children = [];
const heartbeatTimers = [];

const heartbeat = (path) => {
  const write = () => writeFileSync(path, String(Date.now()));
  write();
  const timer = setInterval(write, 25);
  heartbeatTimers.push(timer);
};

const GRANDCHILD_SCRIPT = `
  const { writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const path = join(process.argv[1], "grandchild.heartbeat");
  const write = () => writeFileSync(path, String(Date.now()));
  write();
  setInterval(write, 25);
`;
const CHILD_SCRIPT = `
  const { spawn } = require("node:child_process");
  const { writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const dir = process.argv[1];
  const path = join(dir, "child.heartbeat");
  const write = () => writeFileSync(path, String(Date.now()));
  write();
  setInterval(write, 25);
  const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(GRANDCHILD_SCRIPT)}, dir], { stdio: "ignore" });
  grandchild.once("spawn", () => process.send?.({ grandchild: grandchild.pid }));
`;

process.stdout.write("ready>");

const say = (text) => process.stdout.write(text);

const handle = (line) => {
  const [command, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(" ");
  switch (command) {
    case "":
      return say("prompt>");
    case "echo":
      return say(`${arg}\nprompt>`);
    case "delay": {
      const [ms, ...text] = rest;
      setTimeout(() => say(`${text.join(" ")}\nprompt>`), Number(ms) || 0);
      return;
    }
    case "unsolicited": {
      const count = Number(arg) || 1;
      for (let index = 0; index < count; index += 1) {
        setTimeout(() => say(`tick ${index}\n`), 10 * (index + 1));
      }
      return say("prompt>");
    }
    case "binary":
      process.stdout.write(Buffer.from([0xc3, 0x28, 0xff, 0xfe, 0x41]));
      return say("prompt>");
    case "ansi":
      return say("\u001b[31mred\u001b[0m\u001b]0;title\u0007a\bb\rline\nprompt>");
    case "secret": {
      const half = Math.ceil(arg.length / 2);
      process.stdout.write(arg.slice(0, half));
      setTimeout(() => say(`${arg.slice(half)}\nprompt>`), 5);
      return;
    }
    case "err":
      process.stderr.write(`${arg}\n`);
      return say("prompt>");
    case "spawn": {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `const {spawn}=require('node:child_process');` +
            `spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});` +
            `setInterval(()=>{},1000);`,
        ],
        { stdio: "ignore" },
      );
      children.push(child);
      return say(`spawned ${child.pid}\nprompt>`);
    }
    case "tree": {
      mkdirSync(arg, { recursive: true });
      heartbeat(join(arg, "root.heartbeat"));
      const child = spawn(process.execPath, ["-e", CHILD_SCRIPT, arg], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      children.push(child);
      child.once("message", ({ grandchild }) => {
        say(`tree root=${process.pid} child=${child.pid} grandchild=${grandchild}\nprompt>`);
      });
      return;
    }
    case "ignore-term":
      ignoreTerm = true;
      process.on("SIGTERM", () => say("term ignored\n"));
      return say("prompt>");
    case "sig":
      for (const signal of ["SIGINT", "SIGTSTP"]) {
        process.once(signal, () => say(`signal ${signal}\n`));
      }
      return say("prompt>");
    case "exit":
      return process.exit(Number(arg) || 0);
    default:
      return say(`unknown ${command}\nprompt>`);
  }
};

let pending = "";
process.stdin.on("data", (chunk) => {
  pending += chunk.toString("utf8");
  let newline = pending.indexOf("\n");
  while (newline >= 0) {
    handle(pending.slice(0, newline));
    pending = pending.slice(newline + 1);
    newline = pending.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  say("eof\n");
  if (!ignoreTerm) process.exit(0);
});
