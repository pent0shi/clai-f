# Implementation Plan: Interactive Terminal Sessions

## Overview

Implement persistent, conversation-owned terminal sessions as a separate TypeScript subsystem with pipe and optional PTY transports, exact-input policy, bounded cursor output, identity-safe cleanup, additive tools, and cross-platform release validation. The sequence deliberately preserves `shell.exec`, detached `JobManager`, and all existing one-shot shell/job contracts.

## Tasks

- [ ] 0. Prove PTY dependency, ABI, and release-package feasibility
  - [ ] 0.1 Complete the blocking PTY feasibility gate
    - Current evidence: `node-pty@1.0.0` is rejected because its ABI-137 native build crashes the Bun 1.3.14 compiled path; reviewed replacements `node-pty@1.1.0` and `node-pty@1.2.0-beta.14` are also rejected because compiled-Bun input/output does not execute. Keep PTY unavailable and the dependency absent. See `pty-feasibility.md`.
    - Treat `node-pty@1.0.0` as the initial exact candidate, not an assumed solution. In an isolated spike, verify install or reproducible native build, lazy load, spawn, input/output, resize, process-tree cleanup, and partial-initialization cleanup on Node.js 20+ and the Bun 1.3.14 compiled executable path.
    - Run packaged-layout smoke tests on matching macOS, Linux, and Windows OS/architecture runners; an Ubuntu cross-compile alone is not evidence that Darwin or Windows sidecars load.
    - Define the sidecar manifest, ABI/runtime metadata, checksums, loader-relative path, and installation layout for raw release downloads, npm, `install.sh`, `install.ps1`, Homebrew, and Scoop.
    - If candidate `1.0.0` fails, stop PTY-dependent work and update this spec to another reviewed exact version before changing `package.json`; do not float versions or substitute another PTY implementation. Record `pty.available=false` for targets without proof while retaining pipe and legacy behavior.
    - _Requirements: 2.5, 2.9, 2.10, 13.5, 13.8_

- [x] 1. Establish configuration, domain contracts, and registry foundations
  - [x] 1.1 Add the feature configuration and verified dependency boundary
    - After Task 0.1 passes, add its verified exact `node-pty` version to `optionalDependencies` in `package.json` and synchronize `package-lock.json`; do not import it from startup, pipe, shell, or job paths. If only pipe-mode work is proceeding, leave the unverified PTY dependency out and advertise PTY unavailable.
    - Implement `src/interactive-session/config.ts` with every documented default/range, per-operation override validation, 80x24 PTY defaults, and an environment kill switch that disables only interactive-session capability.
    - Return `INVALID_CONFIGURATION` before slot reservation or process launch, while keeping legacy tools available when disabled.
    - _Requirements: 2.6, 2.7, 3.3, 3.7, 5.2, 5.3, 6.8, 6.9, 9.1, 10.1, 10.2, 10.3, 11.2, 13.8_

  - [x] 1.2 Define interactive-session types and stable errors
    - Create `src/interactive-session/types.ts` for operations, states, termination reasons, requests/results, transport/output contracts, artifacts, process outcomes, and structured `StableError`.
    - Centralize construction in `sessionError()` with allowlisted bounded details, retryability rules, operation/session/state context, and no raw native error, command, input, environment, or output content.
    - Keep direct keyboard passthrough, controlling-terminal transfer, GUI interaction, reattachment, full screen emulation, and command rewriting out of the public contracts.
    - _Requirements: 1.1, 1.6, 4.9, 10.9, 12.1, 12.2, 15.1, 15.2, 15.3, 15.4, 15.5, 15.7_

  - [x] 1.3 Implement owner-scoped registry and per-session runtime primitives
    - Create `src/interactive-session/registry.ts` and `runtime.ts` with opaque non-reusable `its_` UUIDs, atomic per-owner live-slot reservation, immutable snapshots, bounded terminal history, and valid compare-and-transition state changes.
    - Add per-session mutation locking, FIFO input/runtime state, `FinalizeOnce`, timer/listener ownership, process outcome recording, and owner-mismatch behavior indistinguishable from a missing ID.
    - Keep interactive records separate from `JobManager` records and exclude commands, input, environment, prompts, and output from registry records.
    - _Requirements: 1.3, 1.4, 1.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 8.9, 13.4_

  - [x] 1.4 Write the property test for opaque identity and ownership
    - **Property 2: Session identity and ownership are non-disclosing**
    - Use `fast-check` with at least 100 cases to verify ID uniqueness/non-reuse, metadata independence, and uniform cross-owner `SESSION_NOT_FOUND` results.
    - **Validates: Requirements 1.3, 3.1, 3.2**

  - [x] 1.5 Write the property test for registry limits, ordering, and transitions
    - **Property 3: Registry limits, ordering, and state transitions hold**
    - Model randomized starts/exits/closes/failures across owners; assert atomic limits, no over-limit spawn reservation, valid transitions, live-first ordering, and the 50-summary bound.
    - **Validates: Requirements 1.4, 3.3, 3.4, 3.5**

- [x] 2. Add process identity and transport adapters without changing legacy execution
  - [x] 2.1 Extract and extend cross-platform process identity
    - Create `src/os/process-identity.ts` by extracting the current POSIX identity behavior from `src/tools/jobs.ts`, adding injected Linux/macOS/Windows providers and `match | mismatch | gone | unknown` comparison.
    - Hash persisted evidence, make `unknown` non-authorizing for recovered-process signals, and adapt `JobManager` to the extracted API without changing job liveness, stop, persistence, or public results.
    - Extend `src/os/process-tree.ts` behind its current API only where identity-aware descendant verification is required.
    - _Requirements: 11.4, 11.5, 11.9, 13.1, 13.2, 14.12, 14.13_

  - [x] 2.2 Implement transport interfaces and the pipe transport
    - Create `src/interactive-session/transport.ts` and `transport-pipe.ts` with launch confirmation, process identity, distinct stdout/stderr events, pause/resume, delivery certainty, EOF, control, resize capability, tree termination, and idempotent disposal.
    - Spawn with managed pipe stdin/stdout/stderr, never inherited host stdin; use dedicated POSIX process groups and existing Windows tree termination.
    - Ensure pipe mode does not probe or import PTY code and does not affect `shell.ts` or `jobs.ts` spawn options.
    - _Requirements: 2.4, 6.3, 7.6, 8.12, 13.5, 15.1, 15.2_

  - [x] 2.3 Implement lazy optional PTY capability and transport
    - Create `src/interactive-session/transport-node-pty.ts` with lazy dynamic import, platform-specific capability diagnostics, ConPTY support through the same adapter, 80x24 defaults, resize, terminal stream labeling, and resource-safe partial initialization.
    - Enforce `required`, `preferred`, and `pipe` selection before command launch; preferred fallback must launch exactly once through pipe and report `PTY_UNAVAILABLE` degradation.
    - Release any allocated native terminal resource when initialization fails before launch confirmation.
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 2.6, 2.8, 6.2, 7.5_

  - [x] 2.4 Implement exact text, control, and EOF transport mappings
    - Centralize transport/platform mappings for Enter and every named control, including unsupported combinations and pipe interrupt behavior.
    - Return delivery results that distinguish delivered, definitely not delivered, and unknown delivery; never retry or silently rewrite an action.
    - Keep interrupt non-closing unless the child exits, and make manager-level EOF stronger than control EOF.
    - _Requirements: 4.3, 4.4, 4.5, 4.6, 4.7, 4.9, 4.10, 14.7_

  - [x] 2.5 Write the property test for coherent transport selection and Start receipts
    - **Property 1: Start receipt and transport selection are coherent**
    - Generate terminal modes, dimensions, and capability outcomes; assert one launch at most, matching receipt fields, no dimensions for pipe, and no spawn on required-PTY failure.
    - **Validates: Requirements 1.2, 2.1, 2.2, 2.3, 2.4, 14.3**

- [x] 3. Foundation checkpoint - Validate registry, identity, and transport boundaries
  - Run the existing regression suite plus the Task 1 registry tests and Task 2 identity/adapter tests available at this stage. The manager-dependent Start-receipt property in Task 2.5 runs in Wave 11 after Task 6.1; do not proceed while failures, leaked processes, or changed legacy shell/job expectations remain.

- [x] 4. Build the canonical redacted output, views, and artifact pipeline
  - [x] 4.1 Implement streaming redaction and cursor-based output retention
    - Create `src/interactive-session/streaming-redactor.ts` and `output-store.ts` with bounded byte-stream matching for exact sensitive UTF-8 byte sequences across arbitrary chunks and beside invalid UTF-8, plus bounded decoded-text pattern redaction. Validate finite match-span bounds and reject oversized exact-secret registration before delivery; never persist or present raw overlap.
    - Assign cursors only after both redaction lanes, serialize observation-order appends, preserve unmatched binary bytes, retain stream labels and immutable events, provide wait subscriptions, and enforce a bounded ring window.
    - Implement contiguous cursor reads, `nextCursor`, `hasMore`, output eviction, exact `OUTPUT_GAP` metadata, model-visible page limits, and retained remainder for later reads.
    - Update activity only from accepted input or observed output; never order by wall clock.
    - _Requirements: 5.7, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 8.10, 8.13, 10.4_

  - [x] 4.2 Implement safe plain and encoded output views
    - Create `src/interactive-session/output-view.ts` with UTF-8 boundary-safe paging, explicit decoding-loss markers, base64 encoded events, ANSI/OSC/DCS/C0/C1 neutralization, and deterministic carriage-return/backspace linearization by dimensions.
    - Preserve canonical cursor intervals regardless of rendered length and ensure no host-terminal control effect reaches model, transcript, log, or UI output.
    - Do not add screen-grid or pixel-equivalent terminal emulation.
    - _Requirements: 6.11, 6.12, 7.1, 7.2, 7.4, 7.8, 15.5_

  - [x] 4.3 Implement bounded private artifact writing and persistence backpressure
    - Create `src/interactive-session/artifact-writer.ts` for owner-only directories/files, rotation, ordered chunk metadata, incremental digest, captured/dropped accounting, and bounded pending writes of canonical redacted bytes only.
    - Pause/resume transport reads on writer backpressure; apply the configured output-limit outcome or finalize with `PERSIST_FAILED`/`output-limit` rather than growing memory.
    - Drain final redacted output before writer and transport resources close.
    - _Requirements: 9.4, 9.5, 11.12, 12.3, 12.4, 12.5, 12.9_

  - [x] 4.4 Write the property test for output observation ordering
    - **Property 7: Cursor assignment preserves observation order**
    - Randomize PTY and interleaved pipe callbacks and assert contiguous ranges plus correct stream identity.
    - **Validates: Requirements 6.1, 6.2, 6.3**

  - [x] 4.5 Write the property test for gap-free cursor pagination
    - **Property 8: Cursor pagination is gap-free within retention**
    - Verify repeated reads reconstruct every retained canonical byte once, preserve order, respect page bounds, and report `hasMore` exactly.
    - **Validates: Requirements 6.4, 6.5, 6.6, 6.8, 6.10, 6.13, 14.5**

  - [x] 4.6 Write the property test for bounded retention and eviction metadata
    - **Property 9: Output retention remains bounded and reports eviction**
    - Generate output larger than the memory window and assert monotonic eviction plus exact earliest cursor, omitted count, and artifact reference.
    - **Validates: Requirements 6.7, 6.9, 14.5**

  - [x] 4.7 Write the property test for binary and UTF-8 boundaries
    - **Property 10: Binary and text boundaries preserve safe source data**
    - Split arbitrary bytes at every relevant chunk/page boundary; assert encoded round trips, complete plain code points, and explicit loss.
    - **Validates: Requirements 6.11, 6.12, 7.2**

  - [x] 4.8 Write the property test for inert deterministic presentation
    - **Property 11: Presented output cannot execute terminal controls**
    - Generate ANSI, OSC, DCS, controls, carriage returns, and backspaces; assert inert output and deterministic transforms.
    - **Validates: Requirements 7.1, 7.4, 14.7**

  - [x] 4.9 Write the property test for end-to-end secret non-disclosure
    - **Property 15: Sensitive data never reaches a persistence or presentation sink**
    - Inject canaries across every byte chunk split, including adjacent invalid UTF-8, and assert absence from store, journal, artifacts, telemetry inputs, transcript projections, previews, displays, errors, and both views; separately verify decoded-text pattern redaction and bounded overlap behavior.
    - **Validates: Requirements 7.3, 8.9, 8.10, 8.11, 8.13, 12.4, 12.7, 14.9**

  - [x] 4.10 Write the property test for artifact rotation and accounting
    - **Property 16: Artifact rotation and accounting are complete**
    - Generate streams and limits; reconstruct chunks, verify digest, capture cap, ordering, and captured-plus-dropped equality.
    - **Validates: Requirements 9.5, 12.5**

- [x] 5. Add contextual later-input policy and one-time exact approvals
  - [x] 5.1 Implement contextual input classification and approval-token vault
    - Create `src/interactive-session/input-policy.ts` with exact owner/session/action/bytes/submit context, shell-risk reuse, explicit REPL mutator patterns, safe navigation controls, confirm-by-default unknown submitted text, and blocked destructive/exfiltration input.
    - Implement keyed digest binding and short-lived one-use tokens consumed atomically before queue reservation; never expose tokens in tool schemas or persist payloads/digests.
    - Integrate existing confirmation, engagement-scope, permission, and secret-redaction ports with redacted previews and risk reasons.
    - _Requirements: 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.11, 13.6, 15.6_

  - [x] 5.2 Write the property test for exact-input policy gating
    - **Property 13: Exact-input policy gates every delivery**
    - Generate changed owners, IDs, bytes, kinds, submit modes, decisions, reuse, and concurrent replay; only the exact consumed token may queue confirmed input.
    - **Validates: Requirements 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 14.8**

  - [x] 5.3 Write the property test for policy monotonicity
    - **Property 14: Interactive command risk is monotonic**
    - Compare shell and interactive Start classifications and assert interactive risk is never lower and allocation never precedes permission.
    - **Validates: Requirements 8.1, 8.2, 13.6**

- [x] 6. Implement manager operations, ordered I/O, deadlines, and timers
  - [x] 6.1 Implement Start orchestration and side-effect-boundary retry
    - Create `src/interactive-session/manager.ts` to validate owner/request/config, enforce feature enablement, apply existing command/scope policy, resolve transport, reserve a slot/artifact/journal record, subscribe before launch confirmation, capture identity, transition state, and return the full receipt.
    - Bound Start by one absolute deadline; retry at most once only after a proven transient pre-spawn failure, never after PID/PTY confirmation, and finalize every allocated resource before returning failure.
    - Keep launch command/environment ephemeral and host stdin disabled.
    - _Requirements: 1.2, 2.8, 3.4, 7.3, 8.1, 8.2, 8.12, 10.1, 10.7, 10.8, 10.10, 12.8_

  - [x] 6.2 Implement ordered input acceptance, delivery, EOF, and backpressure
    - Add the FIFO writer drain to `runtime.ts`/`manager.ts`: policy before acceptance, atomic full-byte reservation, sequence assignment before write, exactly one delivery attempt, complete queued-byte accounting, and per-entry delivered-byte results.
    - Make EOF idempotently close logical input once, reject later input, reject new sends after `closing`, map ambiguous writes to nonretryable `INPUT_DELIVERY_UNKNOWN`, and settle queued entries on exit.
    - Isolate queues and failures per session and reject over-limit actions without sequence or queue mutation.
    - _Requirements: 4.1, 4.2, 4.7, 4.8, 4.9, 4.10, 9.1, 9.2, 9.3, 9.6, 9.7, 9.8_

  - [x] 6.3 Implement Send gathering and cursor-based Read
    - Select the validated caller cursor when supplied or the acceptance cursor otherwise. Start quiet detection from a separate output-generation baseline captured at delivery completion; only later output resets quiet, while the page may include earlier output from the selected cursor.
    - Return gathered pages alongside nonretryable post-delivery `DEADLINE_EXCEEDED`, cap blocking Read at 30 seconds, make nonblocking Read immediate, and unsubscribe all completed/cancelled waiters.
    - Treat operation cancellation as wait cleanup only and keep the session live; owner cancellation joins shared finalization. Do not replay input or automatically retry any Send/Read operation.
    - _Requirements: 5.1, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 6.13, 10.10_

  - [x] 6.4 Implement nonblocking Status/List and race-safe Resize
    - Serve immutable Status snapshots without waiting; implement owner-filtered live-first List capped at 50.
    - Validate dimensions before mutation, serialize PTY resize against close/exit, return applied values or terminal-state error, and return `UNSUPPORTED_OPERATION` for pipe without state change.
    - _Requirements: 1.4, 1.5, 2.7, 7.5, 7.6, 7.7_

  - [x] 6.5 Implement idle/lifetime timers and operation isolation
    - Use an injected monotonic clock in `runtime.ts`; reset idle deadlines only on accepted input/observed output and keep lifetime fixed from confirmed launch.
    - Route expiry through the shared finalization path with the correct termination reason; isolate operation deadlines and cancellation across sessions.
    - _Requirements: 9.6, 10.2, 10.3, 10.4, 10.5, 10.6_

  - [x] 6.6 Write the property test for FIFO at-most-once input
    - **Property 4: Accepted input is FIFO and at-most-once**
    - Randomize completion schedules and at least 100 concurrent sends; assert sequence/write order, exact encoding, and one attempt.
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.10, 9.3, 14.4**

  - [x] 6.7 Write the property test for atomic EOF and backpressure
    - **Property 5: EOF and backpressure acceptance are atomic**
    - Generate queue capacities, EOF races, exits, and partial/unknown results; assert all-or-nothing acceptance and exact delivered-byte settlement.
    - **Validates: Requirements 4.7, 4.8, 9.1, 9.2, 9.8**

  - [x] 6.8 Write the fake-clock property test for quiet/deadline semantics
    - **Property 6: Quiet gathering obeys one absolute deadline**
    - Generate output before and after delivery completion, explicit/default cursors, exit, deadline, wait, operation-cancellation, and owner-cancellation schedules; assert quiet starts at the delivery baseline, operation cancellation leaves the session live, owner cancellation finalizes once, and the absolute deadline never extends.
    - **Validates: Requirements 5.1, 5.4, 5.6, 5.8, 5.9, 5.10, 6.13, 14.6**

  - [x] 6.9 Write the property test for resize races
    - **Property 12: Resize cannot revive or mutate an incompatible session**
    - Interleave PTY/pipe resize with close and exit; assert applied-or-terminal results and no state revival.
    - **Validates: Requirements 7.5, 7.7**

  - [x] 6.10 Write the property test for per-session I/O isolation
    - **Property 17: Sessions isolate mutable I/O state**
    - Generate interleaved operations across IDs and assert independent queues, cursors, deadlines, waiters, errors, and finalization.
    - **Validates: Requirements 9.6**

  - [x] 6.11 Write the property test for independent idle and lifetime invariants
    - **Property 19: Activity and lifetime timers have independent invariants**
    - Use arbitrary monotonic schedules to verify activity updates, idle reset, and fixed lifetime expiry.
    - **Validates: Requirements 10.4, 10.5, 10.6**

  - [x] 6.12 Write the property test for retry side-effect boundaries
    - **Property 20: Automatic retries stop at the side-effect boundary**
    - Inject failures before/after spawn and delivery; assert at most two safe launch attempts, one post-confirmation attempt, no input retry, and no rewriting.
    - **Validates: Requirements 10.7, 10.8, 10.10, 14.14, 15.7**

- [x] 7. Core behavior checkpoint - Validate output, policy, I/O, deadline, and timer properties
  - Run every Task 4 through Task 6 unit/property test plus targeted legacy safety, artifact, cancellation, shell, and job regressions; do not proceed while any mandatory property or compatibility assertion fails.

- [x] 8. Implement identity-safe cleanup and startup recovery
  - [x] 8.1 Implement idempotent graceful/forceful cleanup
    - Create `src/interactive-session/cleanup.ts` using `FinalizeOnce`: commit `closing` before signaling, reject/settle input, gracefully terminate then force once, retain final output, flush redaction/artifacts, and verify root/descendant absence or identity mismatch within one close deadline.
    - Never signal on identity mismatch/unknown recovered identity; return `CLEANUP_FAILED` for verified survivors, and release timers, waiters, listeners, queues, tokens, transport, writer, process, and registry live ownership once.
    - Make Close idempotently join cleanup and return the recorded result for terminal sessions.
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.10, 11.11, 11.12_

  - [x] 8.2 Implement private recovery journal and startup reconciliation
    - Create `src/interactive-session/recovery-journal.ts` with atomic owner-only live records containing only opaque/redacted cleanup evidence.
    - Reconcile before tools are enabled: terminate only identity matches, mark gone/mismatch terminal without signaling, report unknown as unverified, fail unconfirmed starts, and never reattach a session.
    - Remove or terminalize every recovered record and integrate journal deletion into final cleanup.
    - _Requirements: 8.9, 11.9, 12.3, 15.4_

  - [x] 8.3 Write the property test for close races and single finalization
    - **Property 18: Closing rejects later input and finalizes once**
    - Model close, exit, operation cancellation, owner cancellation, idle/lifetime timeout, owner teardown, shutdown, reset, history rebind, and disposal interleavings; assert operation cancellation leaves the session live, old-owner fencing precedes rebind, `closing` precedes signals, one cleanup owner wins, later input is rejected, and repeated Close is stable.
    - **Validates: Requirements 5.8, 5.10, 9.7, 11.1, 11.10, 11.11, 11.13, 14.11**

  - [x] 8.4 Write the property test for identity-safe complete cleanup
    - **Property 21: Cleanup is identity-safe and resource-complete**
    - Generate liveness/identity outcomes and termination reasons; assert only matching trees are signaled and every resource is released at most once.
    - **Validates: Requirements 11.4, 11.6, 14.13**

  - [x] 8.5 Write cleanup and recovery integration tests
    - Use deterministic root/child/grandchild heartbeat or port evidence to verify graceful escalation, final output drain, verified survivors, cancellation, timeout, owner/app teardown races, PID-reuse protection, and all recovery outcomes.
    - Cover allocated-resource failure paths, including PTY partial initialization and persistence failure, without leaking processes or native handles.
    - _Requirements: 2.8, 11.3, 11.5, 11.6, 11.7, 11.8, 11.9, 11.12, 12.8, 14.11, 14.12, 14.13_

- [x] 9. Wire telemetry, additive tools, and application lifecycle
  - [x] 9.1 Implement bounded metadata-only telemetry
    - Create `src/interactive-session/telemetry.ts` and instrument every manager operation with HMAC-redacted ID, duration, result, state, byte counts, queue depth, retry count, transport, termination reason, and allocation-cleanup verification.
    - Pass explicit bounded fields to existing `auditLog`; exclude raw IDs, commands, cwd, environment, inputs, outputs, native errors, previews, and artifact content.
    - _Requirements: 12.6, 12.7, 12.8_

  - [x] 9.2 Add seven schemas and handlers without changing existing tool contracts
    - Add `src/tools/interactive-session-tools.ts`; append strict `terminal.start`, `terminal.send`, `terminal.read`, `terminal.status`, `terminal.list`, `terminal.resize`, and `terminal.close` definitions in `definitions.ts` and handlers in `registry.ts`.
    - Require `ToolRunOptions.sessionId`, add `interactiveSession` to `ToolResult` in `src/types.ts` without changing existing fields, emit concise ANSI-free `output`, and preserve page-plus-error results.
    - Gate registration/capability with configuration and the kill switch; forbid all seven inside `tool.batch` and do not rename or alter legacy tools.
    - _Requirements: 1.1, 1.3, 13.1, 13.7, 13.8_

  - [x] 9.3 Integrate conversation ownership through app ports/controllers
    - Add `src/app/ports/interactive-sessions-port.ts` and `src/app/adapters/current-interactive-sessions-adapter.ts` around one process-wide manager, with separate `cancelOwner`, synchronous owner fencing, tracked `beginCloseOwner`, and `closeAll` semantics.
    - Update `SessionController.cancelAll()` to await both job and interactive owner cancellation with aggregated results. In the existing synchronous `reset()`, `loadHistory()`, and `dispose()` paths, capture and fence the old owner and start its one tracked close before rebinding/releasing the ID; application shutdown later awaits those promises.
    - Keep manager instances injectable for isolated tests, and test history rebind to the same/different ID plus reset/dispose races.
    - _Requirements: 5.8, 5.10, 9.6, 11.6, 11.7, 11.13, 15.6_

  - [x] 9.4 Integrate renderer, classic REPL, and one-shot shutdown
    - In `src/tui-v2/bootstrap/start-tui-v2.ts`, use the existing `RendererLifecycle` reverse-order async disposers: register final history persistence before interactive `closeAll` so shutdown executes session cleanup first, persistence second, and renderer destruction/service disposal last.
    - Route classic `src/repl.ts` and `src/index.ts` one-shot shutdown/finally paths through the same idempotent close-all boundary, and await previously tracked owner-close promises.
    - Aggregate/report interactive cleanup failures without skipping renderer restoration, final history persistence, or existing idempotent job shutdown behavior; do not hand the host terminal to children.
    - _Requirements: 11.8, 11.13, 13.8, 15.1, 15.2_

  - [x] 9.5 Write the property test for stable error completeness
    - **Property 22: Stable errors are complete and non-secret**
    - Generate failures for every operation and assert declared codes, bounded actionable fields, retryability/state/session rules, secret exclusion, and exact omission metadata.
    - **Validates: Requirements 10.9, 12.1, 12.2, 12.9**

  - [x] 9.6 Write the property test for telemetry minimization
    - **Property 23: Telemetry is bounded metadata only**
    - Generate operation inputs/outcomes containing canaries and assert required metadata plus exclusion of all raw sensitive fields.
    - **Validates: Requirements 12.6, 12.7**

  - [x] 9.7 Write the property test for legacy transport isolation
    - **Property 24: Legacy execution never allocates an interactive transport**
    - Exercise every existing shell/job tool with the feature enabled, disabled, and PTY unavailable; assert no interactive/PTY factory calls and unchanged arguments/results.
    - **Validates: Requirements 13.1, 13.4, 13.5, 13.7, 13.8**

  - [x] 9.8 Write the property test for safety controls across operation order
    - **Property 25: Safety controls cannot be bypassed by operation order**
    - Generate operation/cancellation/teardown sequences and assert policy before launch/delivery, redaction before persistence, enforced limits, and cleanup reachability.
    - **Validates: Requirements 15.6**

- [ ] 10. Complete PTY sidecar release support and cross-platform verification
  - [ ] 10.1 Materialize and install the verified PTY sidecar set per release target
    - Extend `scripts/build.ts` and target-native release jobs to package the Task 0.1 verified exact native artifact, companion files, and capability manifest beside the compiled executable at the loader-tested relative path. Do not claim a target based only on cross-compilation.
    - Update GitHub release assets/checksums, npm package contents, `install/install.sh`, `install/install.ps1`, generated Homebrew formula, and Scoop manifest/bucket generation so each installation method places and verifies the complete sidecar set atomically.
    - Do not add alternate PTY packages or shell out to terminal wrappers; targets without a verified artifact must advertise `pty.available=false` while pipe and legacy tools remain usable.
    - _Requirements: 2.5, 2.9, 2.10, 13.5, 13.8_

  - [ ] 10.2 Enforce capability truth in release validation and native CI matrices
    - Extend `scripts/validate-release.ts`, `.github/workflows/ci.yml`, and `.github/workflows/release.yml` to validate exact dependency/lock data, sidecar manifest/checksums, ABI and runtime metadata, and pipe fallback on Node 20+ macOS, Linux, and Windows.
    - Build or obtain native artifacts reproducibly and execute load/spawn/resize/I/O/cleanup smoke tests using the packaged executable on matching target OS/architecture runners; the current Ubuntu cross-build may assemble binaries but cannot issue Darwin/Windows PTY proof.
    - Install and smoke-test the applicable raw installer/package-manager output, keep assets/checksums coherent, and fail any release that claims PTY support without a matching native smoke receipt.
    - _Requirements: 2.5, 2.9, 2.10, 13.8, 14.3, 14.12_

  - [x] 10.3 Add the deterministic interactive child and operation integration suite
    - Create `test/fixtures/interactive-child.mjs` for prompt/echo, delayed and unsolicited output, binary/control behavior, signals, EOF, resize observation, TERM resistance, and descendant evidence.
    - Add integration tests for Start, Send, Read, Status, List, Resize, Close, pipe/PTY selection, every control, explicit/default Send cursors, cursor/page boundaries, output before/after delivery quiet baselining, operation versus owner cancellation, limits, binary redaction, artifact backpressure, and final output drain.
    - Use no Mimikatz, Metasploit, or other external security tool.
    - _Requirements: 5.9, 5.10, 6.13, 8.13, 14.1, 14.3, 14.5, 14.6, 14.7, 14.10, 14.16_

  - [x] 10.4 Add supported-platform PTY, Python REPL, identity, and process-tree tests
    - On macOS, Linux, and Windows, test PTY capability/fallback, real identity capture, and verified parent/child/grandchild disappearance with heartbeat or port evidence.
    - Run a Python REPL round trip using `python3` or `python`; skip only with an explicit capability reason.
    - _Requirements: 14.2, 14.3, 14.12, 14.13_

  - [x] 10.5 Add policy, secret-canary, and failure-boundary integration tests
    - Verify safe/confirm/block later-input paths, exact token replay rejection, secrets absent from registry/journal/artifacts/telemetry/transcripts/previews/displays/errors, invalid configuration edges, output/persistence failures, and retry boundaries.
    - _Requirements: 8.3, 8.9, 8.10, 8.11, 8.13, 14.8, 14.9, 14.10, 14.14_

  - [ ] 10.6 Run and preserve full regression/build validation
    - Run targeted interactive-session Vitest files with `vitest run`, then `npm run typecheck`, full `npm test`, `npm run build`, `npm run release:verify`, matching-target packaged capability smoke validation, and installer/package-manager layout smoke tests.
    - Explicitly preserve expected behavior in `shell-bounded.test.ts`, `shell-interactive.test.ts`, `shell-launch-retry.test.ts`, `jobs-durable.test.ts`, `jobs-resource-hygiene.test.ts`, `jobs-session-scope.test.ts`, `process-tree.test.ts`, safety/engagement, artifact/history redaction, cancellation, and lifecycle suites.
    - Verify detached jobs still accept at most one stdin payload and close it, one-shot output/artifact/timeout/cancellation/tree-cleanup behavior is unchanged, and no legacy operation allocates PTY resources.
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.8, 14.15_

- [ ] 11. Final checkpoint - Require complete release evidence
  - Require all mandatory unit, property, race, integration, cross-platform, installer/package, legacy regression, typecheck, build, and release-capability validations to pass with no unexplained skips before declaring implementation complete.

## Notes

- All implementation, unit, property, race, integration, platform, compatibility, and release-validation tasks are mandatory for completion. Capability-dependent cases may skip only with an explicit reason and passing fallback assertions; they are not optional MVP work.
- Every correctness property from the design has its own mandatory property-test subtask with requirement traceability.
- Keep comments concise and focused on non-obvious safety, race, or platform invariants; avoid unrelated refactors.
- Existing shell and detached-job public contracts are regression boundaries, not migration targets.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["0.1", "1.2"] },
    { "id": 1, "tasks": ["1.1", "1.3", "2.1"] },
    { "id": 2, "tasks": ["2.2", "4.1", "5.1"] },
    { "id": 3, "tasks": ["2.3", "4.2", "4.3"] },
    { "id": 4, "tasks": ["2.4"] },
    { "id": 5, "tasks": ["1.4", "1.5"] },
    { "id": 6, "tasks": ["3"] },
    { "id": 7, "tasks": ["6.1"] },
    { "id": 8, "tasks": ["6.2"] },
    { "id": 9, "tasks": ["6.3"] },
    { "id": 10, "tasks": ["6.4", "6.5"] },
    { "id": 11, "tasks": ["2.5", "4.4", "4.5", "4.6", "4.7", "4.8", "4.9", "4.10", "5.2", "5.3", "6.6", "6.7", "6.8", "6.9", "6.10", "6.11", "6.12"] },
    { "id": 12, "tasks": ["7"] },
    { "id": 13, "tasks": ["8.1"] },
    { "id": 14, "tasks": ["8.2"] },
    { "id": 15, "tasks": ["8.3", "8.4", "8.5"] },
    { "id": 16, "tasks": ["9.1", "9.2"] },
    { "id": 17, "tasks": ["9.3"] },
    { "id": 18, "tasks": ["9.4"] },
    { "id": 19, "tasks": ["9.5", "9.6", "9.7", "9.8"] },
    { "id": 20, "tasks": ["10.1"] },
    { "id": 21, "tasks": ["10.2"] },
    { "id": 22, "tasks": ["10.3"] },
    { "id": 23, "tasks": ["10.4", "10.5"] },
    { "id": 24, "tasks": ["10.6"] },
    { "id": 25, "tasks": ["11"] }
  ]
}
```
