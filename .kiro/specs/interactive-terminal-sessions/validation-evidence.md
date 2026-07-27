# Validation Evidence

Date: 2026-07-27
Host: macOS arm64, Node 26.4.0, Bun 1.3.14

## Passing local gates

| Command | Result |
| --- | --- |
| `npx vitest run test/interactive-session` | 14 files, 103 tests passed |
| `npm run typecheck -- --pretty false` | Passed |
| `npm test` | 316 files, 2,389 tests passed |
| `npm run build` | Passed |
| `npm run release:verify` | Passed; exact dependencies and synchronized lockfile |
| `npx vitest run test/interactive-session/cleanup-recovery.integration.test.ts` | 9 tests passed, including allocated PTY partial-initialization cleanup |
| `npx vitest run test/interactive-session/cleanup-recovery.integration.test.ts test/interactive-session/safety-order.test.ts test/interactive-session/platform.integration.test.ts` | 3 files, 13 tests passed before the additional PTY cleanup case |

The full suite includes the named shell, job, process-tree, safety, engagement, artifact/history redaction, cancellation, lifecycle, and legacy interactive-transport isolation regressions required by Task 10.6.

The first full-suite run exposed an output-drain race where process exit could precede pipe stream closure. Cleanup now waits within its existing absolute close budget for the transport output-drain boundary before final redaction and artifact closure. The final post-change full-suite run passed all 2,389 tests.

## Remaining release gates

Task 10.6 remains open because no passing PTY candidate exists for the Bun 1.3.14 compiled path. Consequently, matching-target packaged PTY capability smoke receipts and raw/npm/Homebrew/Scoop installer layout smokes cannot truthfully pass.

Task 11 remains open pending:

- a reviewed exact PTY candidate that passes Task 0.1;
- target-native macOS, Linux, and Windows PTY receipts;
- sidecar manifest/checksum/ABI validation in release CI;
- installer and package-manager layout smoke receipts.

Pipe mode and all legacy execution paths passed local regression validation.
