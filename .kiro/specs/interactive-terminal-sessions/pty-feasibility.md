# PTY Feasibility Evidence

## Gate status

Task 0.1 remains blocked. No PTY dependency may be added and release targets must report `pty.available=false` while pipe and legacy execution remain available.

## Local matching-target results

Target: macOS arm64. Bun: 1.3.14. Node smoke host: 26.4.0, satisfying the declared Node 20+ range.

| Candidate | Node load/spawn/I/O/resize/tree cleanup/partial cleanup | Bun 1.3.14 compiled executable | Decision |
| --- | --- | --- | --- |
| `node-pty@1.0.0` | Pass after native build | Fail: Node ABI 147 is rejected; an ABI 137 rebuild loads and then crashes Bun with `SIGTRAP`/segmentation fault | Rejected |
| `node-pty@1.1.0` | Pass with the packaged macOS arm64 prebuild and executable `spawn-helper` | Fail: spawn succeeds but input is echoed without child command execution; round-trip output times out | Rejected |
| `node-pty@1.2.0-beta.14` | Pass with its packaged macOS arm64 prebuild | Fail: same compiled-Bun input/output timeout as `1.1.0`; child command execution does not begin | Rejected |

The `1.1.0` Bun install did not preserve execute permission on `prebuilds/darwin-arm64/spawn-helper`; Node spawn failed with `posix_spawnp failed` until the isolated artifact was corrected to mode `0755`. Distribution validation must therefore verify companion-file modes as well as checksums.

Reproduce the behavioral smoke with:

```sh
node scripts/pty-feasibility-smoke.mjs --module-root <node-pty-root> --expected-version <exact-version>
bun build scripts/pty-feasibility-smoke.mjs --compile --outfile <smoke-executable>
<smoke-executable> --module-root <node-pty-root> --expected-version <exact-version>
```

Matching Linux and Windows runner evidence is still absent. None of the reviewed exact candidates can advance to those matrices because the required Bun path already fails on macOS arm64.

## Sidecar manifest contract

A future passing candidate must produce one manifest per target at `pty/manifest.json`, relative to the executable or npm package root:

```json
{
  "schemaVersion": 1,
  "package": { "name": "node-pty", "version": "<exact>" },
  "target": { "platform": "darwin", "arch": "arm64" },
  "runtime": { "name": "bun", "version": "1.3.14", "nodeModuleAbi": "<abi-or-null>", "napi": "<version-or-null>" },
  "loaderRelativeRoot": "pty/node-pty",
  "files": [
    { "path": "<relative-path>", "sha256": "<lowercase-hex>", "bytes": 1, "mode": "0755" }
  ],
  "smoke": { "receipt": "pty/smoke.json", "sha256": "<lowercase-hex>" }
}
```

Every path is normalized, relative, and traversal-free. The file list includes native addons, helper executables, DLLs, and package JavaScript required by the lazy loader. Checksums and sizes cover installed bytes; POSIX modes are mandatory for executable companions. The smoke receipt records exact package/runtime versions, ABI metadata, OS/architecture, and passing load, spawn, input/output, resize, tree-cleanup, and partial-cleanup checks.

## Installation layout

- Raw release and shell/PowerShell installers place the executable and `pty/` atomically under the same versioned install root.
- npm includes `pty/` in package files and resolves it relative to the package entry point.
- Homebrew installs `pty/` under the formula `libexec` root and links only the launcher.
- Scoop places `pty/` beside the versioned executable before switching the current shim.
- Every installer verifies the manifest and all file checksums before activation.
- A target without a matching native smoke receipt omits the sidecar claim and reports PTY unavailable.
