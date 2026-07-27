import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const moduleRoot = resolve(args.get("--module-root") ?? "node_modules/node-pty");
const expectedVersion = args.get("--expected-version") ?? "1.0.0";
const timeoutMs = Number(args.get("--timeout-ms") ?? 10_000);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else files.push(path);
  }
  return files;
}

async function nativeArtifacts() {
  const files = (await filesUnder(moduleRoot)).filter((path) => /\.(node|dll|so|dylib)$/i.test(path));
  return await Promise.all(
    files.map(async (path) => ({
      path: path.slice(moduleRoot.length + 1),
      sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
    })),
  );
}

function waitFor(label, check, timeout = timeoutMs) {
  return new Promise((resolveWait, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const value = check();
      if (value !== undefined) {
        clearInterval(timer);
        resolveWait(value);
      } else if (Date.now() - startedAt >= timeout) {
        clearInterval(timer);
        reject(new Error(`PTY smoke timed out waiting for ${label}; output=${JSON.stringify(output.slice(-500))}`));
      }
    }, 10);
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const packageManifest = JSON.parse(await readFile(join(moduleRoot, "package.json"), "utf8"));
assert(packageManifest.version === expectedVersion, `Expected node-pty ${expectedVersion}, received ${packageManifest.version}`);
const loaded = await import(pathToFileURL(join(moduleRoot, "lib/index.js")).href);
const ptyModule = typeof loaded.spawn === "function" ? loaded : loaded.default;
assert(typeof ptyModule?.spawn === "function", "node-pty has no spawn export");

const shell = platform() === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";
const options = {
  cwd: process.cwd(),
  env: { ...process.env, TERM: "xterm-256color", CLAI_PTY_VALUE: "round-trip" },
  cols: 80,
  rows: 24,
  name: "xterm-256color",
};
let pty;
let childPid;
let output = "";
let exited = false;
try {
  pty = ptyModule.spawn(shell, [], options);
  assert(Number.isInteger(pty.pid) && pty.pid > 0, "PTY spawn returned no process ID");
  pty.onData((data) => {
    output += data;
  });
  pty.onExit(() => {
    exited = true;
  });

  pty.resize(100, 31);
  if (platform() === "win32") {
    pty.write("echo __CLAI_IO__%CLAI_PTY_VALUE%\r");
    await waitFor("input/output", () => (output.includes("__CLAI_IO__round-trip") ? true : undefined));
  } else {
    pty.write("printf '__CLAI_IO__%s\\n' \"$CLAI_PTY_VALUE\"; stty size | sed 's/^/__CLAI_SIZE__/'\r");
    await waitFor("input/output", () => (output.includes("__CLAI_IO__round-trip") ? true : undefined));
    await waitFor("resize", () => (output.includes("__CLAI_SIZE__31 100") ? true : undefined));
    pty.write("sh -c 'sleep 30 & child=$!; echo __CLAI_CHILD__$child; wait $child'\r");
    childPid = await waitFor("child process", () => {
      const matches = [...output.matchAll(/__CLAI_CHILD__(\d+)/g)];
      const parsed = Number(matches.at(-1)?.[1]);
      return parsed > 0 ? parsed : undefined;
    });
  }

  if (platform() === "win32") {
    execFileSync("taskkill", ["/pid", String(pty.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    process.kill(-pty.pid, "SIGTERM");
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    if (!exited) process.kill(-pty.pid, "SIGKILL");
  }
  await waitFor("process exit", () => (exited ? true : undefined));
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert(!isAlive(pty.pid), "PTY root process survived tree cleanup");
  if (childPid) assert(!isAlive(childPid), "PTY child process survived tree cleanup");

  let partialExited = false;
  const partial = ptyModule.spawn(shell, [], options);
  partial.onExit(() => {
    partialExited = true;
  });
  partial.kill();
  await waitFor("partial initialization cleanup", () => (partialExited ? true : undefined));
  assert(!isAlive(partial.pid), "Partially initialized PTY survived cleanup");

  const receipt = {
    schemaVersion: 1,
    candidate: `node-pty@${packageManifest.version}`,
    runtime: process.versions.bun ? "bun" : "node",
    runtimeVersion: process.versions.bun ?? process.version,
    nodeModuleAbi: process.versions.modules ?? null,
    platform: platform(),
    arch: arch(),
    checks: {
      lazyLoad: true,
      spawn: true,
      inputOutput: true,
      resize: platform() === "win32" ? "not-observable" : true,
      processTreeCleanup: true,
      partialInitializationCleanup: true,
    },
    nativeArtifacts: await nativeArtifacts(),
  };
  assert(receipt.nativeArtifacts.length > 0, "No native PTY artifact was found");
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  if (pty && isAlive(pty.pid)) {
    try {
      pty.kill();
    } catch {}
  }
}
