import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

interface PackageManifest {
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
}

const packagePath = resolve("package.json");
const manifest = JSON.parse(await readFile(packagePath, "utf8")) as PackageManifest;
const groups = [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.overrides];
for (const group of groups) {
  for (const [name, version] of Object.entries(group ?? {})) {
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error(`Release dependency is not exact: ${name}@${version}`);
    }
  }
}

const [assetArg, sidecarArg] = process.argv.slice(2);
if (assetArg) {
  const asset = resolve(assetArg);
  const info = await stat(asset);
  if (!info.isFile() || info.size === 0) throw new Error(`Release asset is empty: ${asset}`);
  const digest = createHash("sha256").update(await readFile(asset)).digest("hex");
  if (sidecarArg) {
    const expected = (await readFile(resolve(sidecarArg), "utf8")).trim().split(/\s+/, 1)[0];
    if (digest !== expected) throw new Error(`SHA256 mismatch for ${asset}`);
  }
  console.log(`Verified release asset ${asset} (${info.size} bytes, sha256=${digest})`);
}

const lock = JSON.parse(await readFile(resolve("package-lock.json"), "utf8")) as {
  packages?: Record<string, { version?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>;
};
const root = lock.packages?.[""];
if (!root || root.version !== manifest.version) throw new Error("package-lock root version does not match package.json");
for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
  const declared = manifest[field] ?? {};
  const locked = root[field] ?? {};
  for (const [name, version] of Object.entries(declared)) {
    if (locked[name] !== version) throw new Error(`package-lock root mismatch: ${name}@${locked[name] ?? "missing"} != ${version}`);
  }
}
console.log(`Release inputs verified for ${manifest.version}: exact dependencies and synchronized lockfile`);
