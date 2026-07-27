# Design Document: Interactive Terminal Sessions

## Overview

This feature adds persistent, agent-controlled terminal processes without changing the existing foreground shell or detached-job contracts. The implementation is a new application-owned `InteractiveSessionManager` behind seven additive tools. It owns process lifetime, exact-input policy, ordered writes, cursor-based output, artifacts, and teardown. Existing `shell.exec`, `shell.start`, `shell.jobs`, `shell.tail`, and `shell.stop` continue to use `shell.ts` and `JobManager` unchanged.

The central design rule is that an interactive session is not a background job with writable stdin. It has stronger ownership, policy, ordering, output, and cleanup requirements and therefore has a separate registry and lifecycle.

```text
Agent tool call
  -> tools/registry.ts (schema validation + owner context)
  -> InteractiveSessionToolAdapter
  -> InteractiveInputPolicy / existing command policy
  -> InteractiveSessionManager
       -> SessionRegistry
       -> SessionRuntime (one serialized mutation lane per session)
       -> SessionTransport (PTY or pipe)
       -> OutputStore -> StreamingSecretRedactor -> ArtifactWriter
       -> CleanupCoordinator -> ProcessIdentity + process-tree adapter
       -> SessionTelemetry -> auditLog(metadata only)
```

## Design Decisions

### Separate session and job domains

`JobManager` remains the durable, detached, one-input background-job implementation. Interactive sessions use new records, IDs, artifacts, tools, and registries. Shared low-level primitives may be extracted from `src/tools/jobs.ts`—process identity, rotating redacted writing, and process-tree verification—but neither manager delegates lifecycle to the other.

This preserves all existing one-shot and detached-job behavior and prevents installation of PTY support from changing legacy spawn options.

### PTY dependency and capability strategy

`node-pty` is the candidate PTY adapter and must be added only as an exact optional dependency. Version `1.0.0` is the initial reviewed candidate, but it is not considered feasible merely because it installs on the development host. Before PTY implementation depends on it, the Task 0 feasibility gate must prove all of the following against the repository's supported Node.js 20+ path and Bun 1.3.14 compiled-executable path on every release OS/architecture: install or reproducible native build, lazy load from the packaged layout, spawn, input/output, resize, process-tree cleanup, and artifact/signature packaging. If `1.0.0` fails that gate, PTY work stops until this spec and lockfile name a different reviewed exact version; implementation must not silently float or substitute a package. Pipe-mode foundations may proceed independently.

After the gate passes, the manifest uses the verified exact version:

```json
{
  "optionalDependencies": {
    "node-pty": "<verified-exact-version>"
  }
}
```

`node-pty` is loaded only inside `NodePtyTransportFactory` through a lazy dynamic import. It is never imported from the pipe path or legacy shell/job modules. The optional placement is deliberate:

- macOS and Linux use the package's native pseudoterminal implementation.
- Windows uses ConPTY through the same adapter.
- An install/build/native-load failure produces a platform-specific capability result, not an application startup failure.
- `required` returns `PTY_UNAVAILABLE` before process launch.
- `preferred` falls back once to `PipeTransport` and reports degraded transport; it does not first attempt to launch the command in a failed PTY.
- `pipe` never imports or probes `node-pty`.

The release pipeline must treat the native module and any required companion files as a target-specific sidecar set rather than assuming Bun embeds them. The current release workflow cross-compiles all executables on Ubuntu and cannot by itself prove that Darwin or Windows native modules load. Therefore each advertised PTY target must build or obtain the pinned native artifact reproducibly and execute the packaged executable plus sidecar smoke test on a matching OS/architecture runner. `scripts/build.ts` may assemble the target layout, but capability truth comes only from that matching-target smoke. `scripts/validate-release.ts` rejects a release that claims PTY support but lacks the exact sidecar manifest, checksums, ABI/runtime metadata, or passing smoke receipt.

Distribution is part of feasibility: GitHub release assets, checksum files, `install/install.sh`, `install/install.ps1`, generated Homebrew and Scoop manifests, and npm packaging must install the sidecar set at the path resolved by `NodePtyTransportFactory`. Existing raw-binary installs may remain available only when they truthfully advertise `pty.available=false`. If a target cannot ship and load a verified native artifact, pipe mode and all existing tools remain available.

No fallback PTY package and no shelling out to `script`, `winpty`, or PowerShell is used. Multiple PTY implementations would create incompatible control, resize, and teardown semantics.

### Process-wide owner, conversation-scoped access

One `InteractiveSessionManager` exists per clai process, analogous to the existing process-wide `jobManager`. Tool handlers receive that instance through `createInteractiveSessionHandlers(manager)`; production registers a single current-runtime instance while tests instantiate isolated managers.

Every operation requires `ToolRunOptions.sessionId`. The manager treats it as the conversation owner. A missing owner is `INVALID_REQUEST`; it never falls back to `"unknown"`. Registry lookup is `(ownerId, sessionId)`, and any mismatch returns `SESSION_NOT_FOUND`, avoiding an ownership oracle.

The application lifecycle uses a small `InteractiveSessionsPort`:

```ts
export interface InteractiveSessionsPort {
  cancelOwner(ownerId: string): Promise<CloseOwnerResult>;
  beginCloseOwner(ownerId: string, reason: "conversation-teardown"): Promise<CloseOwnerResult>;
  closeAll(reason: "app-shutdown"): Promise<CloseAllResult>;
}
```

Operation cancellation and owner cancellation are intentionally separate. Aborting one `terminal.send` or blocking `terminal.read` removes that operation's waiter/timers and returns `CANCELLED`; it does not close the child. `SessionController.cancelAll()` performs owner cancellation and awaits both `JobsPort.cancelAll()` and `InteractiveSessionsPort.cancelOwner()`, aggregating both results without short-circuiting either cleanup.

Reset, history load/switch, and `dispose()` capture the old owner ID, synchronously fence it in the process-wide manager, and start one tracked `beginCloseOwner` promise before rebinding or releasing that ID. Because the current `SessionController.reset()`, `loadHistory()`, and `dispose()` APIs are synchronous, fencing is synchronous even though teardown is awaited later by cancellation or application shutdown. No new operation can enter the fenced owner while its cleanup is pending.

The existing `RendererLifecycle` already runs asynchronous disposers in reverse registration order before renderer destruction. The composition root registers final history persistence before interactive `closeAll`, so reverse execution closes sessions first and persists history second; controller/service disposal remains in renderer destruction. Classic `repl.ts` and one-shot entry points use the same idempotent close-all boundary in their `finally` paths. Cleanup failures are aggregated into shutdown diagnostics without skipping renderer restoration or legacy job cleanup.

## Module Layout and Responsibilities

```text
src/interactive-session/
  types.ts                 Public domain types and StableError codes
  config.ts                Defaults, range validation, rollout flag
  manager.ts               Operation orchestration and owner checks
  registry.ts              IDs, state machine, owner index, bounded terminal history
  runtime.ts               Per-session locks, writer queue, timers, finalization promise
  transport.ts             SessionTransport and factory interfaces
  transport-pipe.ts        child_process pipe adapter
  transport-node-pty.ts    lazy node-pty adapter and capability probe
  output-store.ts          cursors, retention, pages, output wait subscriptions
  output-view.ts           UTF-8 decoding and ANSI/control neutralization
  streaming-redactor.ts    chunk-safe secret filtering over bytes
  artifact-writer.ts       private rotation, bounds, digest, backpressure
  input-policy.ts          context-aware later-input classification and token vault
  cleanup.ts               graceful/forceful identity-safe teardown
  telemetry.ts             bounded metadata events
  recovery-journal.ts      live-only, redacted crash reconciliation records
src/os/
  process-identity.ts      Cross-platform capture/compare; extracted from jobs.ts
src/app/ports/
  interactive-sessions-port.ts
src/app/adapters/
  current-interactive-sessions-adapter.ts
src/tools/
  interactive-session-tools.ts
```

`src/os/process-tree.ts` remains the single tree-signal abstraction. It is extended behind its current API with identity-aware descendant enumeration where needed; existing callers and semantics do not change.

## Core Interfaces

### Session transport

```ts
export type SessionTransportKind = "pty" | "pipe";
export type OutputStream = "terminal" | "stdout" | "stderr";

export interface TransportOutput {
  readonly stream: OutputStream;
  readonly bytes: Uint8Array;
  readonly observedAt: number;
}

export type DeliveryResult =
  | { status: "delivered"; deliveredBytes: number }
  | { status: "not-delivered"; deliveredBytes: 0; cause: unknown }
  | { status: "unknown"; deliveredBytes: number; cause: unknown };

export interface SessionTransport {
  readonly kind: SessionTransportKind;
  readonly pid: number;
  readonly processGroupId?: number;
  readonly identity: ProcessIdentity;
  write(bytes: Uint8Array): Promise<DeliveryResult>;
  control(action: ControlInput): Promise<DeliveryResult>;
  closeInput(): Promise<DeliveryResult>;
  resize?(dimensions: TerminalDimensions): Promise<void>;
  pauseOutput(): void;
  resumeOutput(): void;
  requestTreeTermination(kind: "graceful" | "forceful"): Promise<TreeSignalOutcome>;
  onOutput(listener: (event: TransportOutput) => void): Unsubscribe;
  onExit(listener: (outcome: ProcessOutcome) => void): Unsubscribe;
  dispose(): Promise<void>;
}

export interface SessionTransportFactory {
  capability(platform: NodeJS.Platform): Promise<PtyCapability>;
  startPipe(request: LaunchRequest): Promise<LaunchResult>;
  startPty(request: LaunchRequest & { dimensions: TerminalDimensions }): Promise<LaunchResult>;
}
```

A launch is confirmed only after pipe `spawn` or a successful `node-pty.spawn` return with a PID and registered output/exit handlers. Host stdin is never inherited. Pipe uses `stdio: ["pipe", "pipe", "pipe"]`; PTY owns its native master. POSIX children use a dedicated process group. Windows cleanup uses tree-aware termination.

`PipeTransport` keeps stdout/stderr distinct. `NodePtyTransport` reports one `terminal` stream. Both adapters expose output pausing so artifact backpressure cannot grow unbounded.

### Session record and runtime

```ts
export type SessionState =
  | "starting"
  | "running"
  | "closing"
  | "exited"
  | "failed"
  | "closed";

export interface InteractiveSessionRecord {
  readonly id: string;
  readonly ownerId: string;
  state: SessionState;
  readonly transport: SessionTransportKind;
  readonly startedAt: number;
  lastActivityAt: number;
  endedAt?: number;
  dimensions?: TerminalDimensions;
  degradedReason?: "PTY_UNAVAILABLE";
  processOutcome?: ProcessOutcome;
  terminationReason?: TerminationReason;
  artifact: ArtifactReceipt;
  earliestCursor: number;
  latestCursor: number;
}

interface SessionRuntime {
  readonly record: InteractiveSessionRecord;
  readonly transport: SessionTransport;
  readonly output: OutputStore;
  readonly input: OrderedInputQueue;
  readonly mutation: AsyncMutex;
  readonly finalizeOnce: FinalizeOnce;
  readonly timers: SessionTimers;
}
```

Records contain no raw command, input, environment value, prompt, or output. The launch command exists only in the ephemeral launch request and is redacted for a confirmation preview before display.

The registry uses full `crypto.randomUUID()` values with an `its_` prefix. It retains a process-lifetime `issuedIds` set and regenerates on collision, so IDs are opaque and non-reusable. A per-owner lock makes live-slot reservation atomic. `starting`, `running`, and `closing` count against the live limit. Terminal summaries are retained in memory at most 50 per owner; live records are never evicted.

### State machine

Allowed transitions are enforced by one compare-and-transition method:

```text
starting -> running | exited | failed
running  -> closing | exited | failed
closing  -> closed  | exited | failed
terminal -> same terminal state only; outcome metadata may be enriched
```

The first terminal state is immutable. A natural exit observed before `closing` commits becomes `exited`. Once `closing` is committed, the cleanup owner decides the terminal state: verified requested teardown becomes `closed`, a process exit already observed by that owner may become `exited`, and cleanup/persistence failure becomes `failed`. Late exit, timeout, or finalizer observations may add exit code, signal, end time, and reason but cannot replace the chosen terminal state. Launch failures are `failed`; terminal records never return to a live state.

## Operation Semantics

### Start

1. Validate all configuration and request fields before reserving a slot.
2. Classify the command with the existing `classifyShellCommand`, engagement scope, permissions, and plan policy. Interactive risk is never lower than the equivalent shell command.
3. Resolve transport capability without allocating a process.
4. Under the owner registry lock, enforce the live limit, mint an ID, create private artifact resources, and reserve a `starting` record.
5. Write a minimal live recovery record without command or environment data.
6. Allocate the selected transport and subscribe output/exit listeners before returning launch confirmation.
7. Capture process identity, atomically update the recovery journal, transition to `running`, arm timers, and return the start receipt.

Start has an absolute deadline. A retry is permitted at most once only when the adapter reports a transient launch failure before spawn confirmation and proves no process was created. Once a PID/PTY is returned, no retry occurs. Any allocated resource on failure is finalized before Start returns.

### Send and ordered input

The public input union is:

```ts
export type SessionInput =
  | { kind: "text"; text: string; submit: "enter" | "none" }
  | { kind: "control"; control: ControlInput }
  | { kind: "eof" };
```

Policy evaluation happens before input acceptance. Under the per-session mutation lock, acceptance:

- verifies `running` and input-open state;
- checks the complete encoded byte size against queued-byte backpressure;
- assigns the next integer `InputSequence`;
- reserves queued bytes atomically;
- captures the send page's starting cursor; and
- enqueues exactly one immutable action.

One drain loop writes actions in sequence order. No delivery call is retried. A definite pre-write failure reports delivered bytes as zero. Any ambiguous adapter result becomes `INPUT_DELIVERY_UNKNOWN`, `retryable:false`, and retains the adapter's definite delivered-byte count. Exit rejects every undelivered entry with its delivered-byte count. Once Close commits `closing`, new sends fail with `SESSION_CLOSING`.

For text input, `submit:none` is exactly `Buffer.from(text, "utf8")`. `submit:enter` appends one adapter-provided Enter sequence—`\r` for PTY and `\n` for pipe—without altering the text. The platform adapter owns this mapping so it can be tested explicitly.

Control mappings are centralized and table-driven:

| Control | POSIX PTY | Windows PTY | Pipe |
|---|---|---|---|
| interrupt | `0x03` | `0x03` | tree `SIGINT`/platform equivalent |
| eof | `0x04` | `0x1a` then Enter | `stdin.end()` |
| suspend | `0x1a` | unsupported | POSIX `SIGTSTP`, otherwise unsupported |
| escape/tab/backspace | `0x1b`/`0x09`/`0x7f` | same | same bytes |
| arrows | ANSI arrow sequence | ANSI arrow sequence | same bytes |

`EOF_Input` is stronger than control `eof`: it performs the transport-specific EOF action once and permanently marks the manager's input direction closed. On a PTY, which has no portable half-close, it sends the platform EOF sequence and logically closes further manager input. On a pipe it calls `stdin.end()`. Duplicate EOF is idempotent; later input returns `INPUT_CLOSED`.

After the write settles, Send chooses its page cursor: the validated caller-supplied cursor when present, otherwise the cursor captured at action acceptance. Delivery completion records a separate quiet-baseline output generation and starts the Quiet Interval; only output observed after that baseline resets quiet detection. The fixed deadline still begins at operation start and never extends. This permits the returned page to include output between acceptance and delivery without falsely extending quiet time. A post-delivery deadline returns both the page and nonretryable `DEADLINE_EXCEEDED`; callers continue with `Read(nextCursor)` rather than replaying input. Operation cancellation removes only the Send wait and leaves the session live unless owner cancellation, exit, timeout, or Close concurrently owns finalization.

### Read, Status, List, Resize, and Close

- `Read` requires an explicit cursor. Nonblocking reads only retained data. Blocking reads subscribe to output-store version changes and cap wait at 30 seconds. Cancellation removes the waiter.
- `Status` reads an immutable registry snapshot and never waits on transport, output, or cleanup locks.
- `List` filters by owner, sorts live records before terminal records and then descending `startedAt`, and returns at most 50 summaries.
- `Resize` validates dimensions before lookup mutation. Under the session mutation lock, PTY resize either applies once or observes terminal/closing state. Pipe returns `UNSUPPORTED_OPERATION` without state mutation.
- `Close` commits `closing` before any signal and then joins `finalizeOnce`. Closing an already terminal record returns its recorded result without signaling. The hard deadline bounds graceful wait, forceful wait, final output drain, writer close, and absence verification.

## Output, Cursors, and Storage

### Canonical safe byte stream

Cursors address a session's canonical safe byte stream, not raw child bytes and not a rendered view. Each observed chunk passes through `StreamingSecretRedactor` first. Only emitted redacted bytes receive cursor ranges and may enter memory or disk. This gives plain and encoded views one stable source and ensures raw sensitive bytes are never durable.

`StreamingSecretRedactor` has two bounded streaming lanes before cursor assignment. A byte matcher redacts the UTF-8 byte encodings of exact sensitive values across arbitrary chunk splits and still matches when those bytes are adjacent to invalid UTF-8. A streaming UTF-8 decoder separately applies existing textual `redactSecrets` patterns to valid decoded text. Both lanes retain only the configured maximum match-span overlap (default 4096 bytes), and no retained raw overlap is persisted or presented. Exact sensitive values whose byte length exceeds that bound are rejected at policy/config registration before input delivery; pattern rules must declare and validate a finite maximum match span. On close, pending overlap is finalized through both redaction lanes before emission. Bytes not matched as sensitive and not part of valid UTF-8 remain byte-preserved, so encoded output and artifacts retain binary data safely without bypassing known-secret matching.

```ts
export interface OutputEvent {
  readonly startCursor: number; // inclusive canonical-safe byte offset
  readonly endCursor: number;   // exclusive
  readonly stream: OutputStream;
  readonly observedAt: number;
  readonly bytes: Uint8Array;
}

export interface OutputPage {
  readonly events: PresentedOutputEvent[];
  readonly requestedCursor: number;
  readonly nextCursor: number;
  readonly hasMore: boolean;
  readonly earliestAvailableCursor: number;
  readonly latestCursor: number;
  readonly view: "plain" | "encoded";
  readonly decodingLoss: boolean;
  readonly omittedBytes?: number;
  readonly artifact: ArtifactReference;
}
```

The store serializes appends in callback observation order. Cursor assignment is monotonic and never uses wall-clock ordering. A ring of immutable byte chunks retains at most the configured memory window. Eviction advances `earliestAvailableCursor`; it never renumbers later bytes.

A page covers a contiguous canonical cursor interval. `nextCursor` is the exclusive source end even when rendering changes visible length. The page builder stops before its configured visible-byte limit and before an incomplete UTF-8 code point for plain view. Encoded view uses base64 per event and a transport-safe alphabet. Repeated paging from returned cursors reconstructs all retained canonical bytes without duplicates.

If a requested cursor is before retention, Read returns `OUTPUT_GAP` plus the exact earliest cursor, omitted canonical byte count, and artifact reference. It does not silently advance the request.

### Plain and encoded views

`encoded` is base64 with stream/cursor metadata and cannot execute terminal controls. Decoding it yields the canonical redacted bytes.

`plain` uses a bounded linearizer, not a terminal emulator:

- UTF-8 decoding uses replacement markers and sets `decodingLoss` when necessary.
- SGR is removed.
- CSI, OSC, DCS, device, cursor, title, clipboard, hyperlink, and other escape sequences are replaced with inert textual markers or omitted according to a fixed table.
- NUL and unsafe C0/C1 controls are rendered as visible tokens.
- carriage return and backspace are represented by deterministic line-update markers; they never move the host cursor.
- no host-terminal control byte survives presentation to the model, transcript, log, or UI.

The same bytes and dimensions always produce identical text. The component does not maintain a screen grid, alternate screen, pixel state, or cursor-addressable replay.

### Artifact writer and output backpressure

Each session gets `${getArtifactDir()}/interactive-${opaqueId}/` mode `0700` and rotated chunk files mode `0600` where permission controls exist. Chunk names contain only the opaque ID and index. The default artifact capture limit is 64 MiB, rotation is 1 MiB, and both are validated configuration.

`BoundedArtifactWriter` receives only canonical redacted bytes. It tracks ordered chunks, captured bytes, dropped bytes, redaction status, and incremental SHA-256 over captured bytes. A bounded pending-write queue pauses transport output when the filesystem stream applies backpressure. On drain it resumes. If pending bytes reach the configured output-persistence queue limit, persistence fails, or capture reaches the configured terminate outcome, the manager stops the session with `output-limit`; it does not accumulate additional memory. Finalization drains captured output before closing transport listeners and the writer.

## Policy and Exact-Payload Confirmation

Start continues through the existing runner command policy. Later input requires context that the current pure `classifyToolCall` does not have, so it is governed inside a dedicated `InteractiveInputPolicy` immediately before manager acceptance. Generic classification marks `terminal.send` as "contextual policy handled by session boundary" and does not grant permission itself.

The contextual classifier receives:

- owner and session ID;
- redacted launch kind/fingerprint and terminal type;
- exact input kind, submit behavior, and bytes;
- current engagement scope and session permissions.

Navigation controls, interrupt, and empty/no-op actions may be safe. Submitted shell text reuses `classifyShellCommand`. Known Python, Node, PowerShell, and database REPL mutators have explicit high-risk patterns. Unknown submitted text defaults to `confirm`, never `safe`; destructive/exfiltration patterns block. This makes interactive risk equal to or stricter than the same visible shell action.

Confirmation is internal to one tool execution; approval tokens are intentionally absent from the model-visible schema:

1. The policy adapter computes a keyed HMAC over `(ownerId, sessionId, actionKind, exactBytes, submitBehavior, decision)` using an application-random key.
2. It shows the confirmation port a redacted action description and risk reason.
3. Approval mints a random, short-lived token stored only in `ApprovalTokenVault` with that digest.
4. Manager acceptance presents the token.
5. The vault atomically validates owner/session/digest and deletes the token before queue reservation or delivery.

A changed byte, control, submit behavior, owner, or session invalidates the token. Reuse and concurrent replay fail. Raw payload and digest are not persisted, logged, placed in registry records, or returned to the model.

## Process Identity, Cleanup, and Recovery

### Identity

`src/os/process-identity.ts` extracts the current process-identity code from `jobs.ts` and adds Windows support:

- Linux: `/proc/<pid>/stat` start time plus boot ID when available.
- macOS: `ps -p <pid> -o lstart=`.
- Windows: process creation time from the native/CIM process query adapter, with a mocked abstraction in unit tests.

The raw evidence is hashed before persistence. Comparison returns `match`, `mismatch`, `gone`, or `unknown`; `unknown` never authorizes signaling a recovered PID. Existing jobs call the extracted POSIX behavior without a contract change.

### Cleanup algorithm

`CleanupCoordinator.close(runtime, reason, deadline)` is idempotent:

1. Acquire `finalizeOnce`; all other callers join its promise.
2. Commit `closing` and the first cleanup reason.
3. Reject new and queued-undelivered input.
4. Capture output while requesting graceful tree termination.
5. Wait up to `min(graceMs, remainingDeadline)`.
6. If the verified tree remains, request forceful termination once.
7. Continue accepting final output until transport exit/close, then flush the redactor and artifact writer.
8. Verify root/tree absence or process-identity mismatch. Never signal after identity mismatch.
9. Clear idle/lifetime/operation timers, waiters, listeners, queues, transport, token entries, and journal record.
10. Transition once to `closed`, `exited`, or `failed`, and retain only the bounded summary.

If a verified descendant remains at deadline, return `CLEANUP_FAILED` and retain a failed terminal summary. Errors name opaque IDs and outcome metadata, never command content.

### Recovery journal

Interactive sessions cannot be reattached after restart. A private, atomic `interactive-sessions/registry-v1.json` stores only live cleanup evidence: opaque ID, redacted owner identifier, PID, process group, hashed identity, platform, start time, and artifact reference. It contains no command, cwd, input, environment, or output.

At startup, reconciliation runs before tools are enabled. A record with matching root identity is terminated and verified. `gone` or `mismatch` is marked terminal without signaling. `unknown` is not signaled and is reported as cleanup-unverified. Starting records without a confirmed PID are marked launch-failed. Every record is removed or rewritten terminal; none becomes a reattachable live session.

## Configuration

Add a nested `interactiveSessions` configuration resolved by `src/interactive-session/config.ts`. Validation returns `INVALID_CONFIGURATION` before launch.

| Field | Default | Allowed |
|---|---:|---:|
| enabled | true | boolean; environment kill switch may disable |
| liveSessionLimit | 4 | 1..32 |
| quietIntervalMs | 250 | 25..5000 |
| startDeadlineMs | 10000 | 100..120000 |
| sendDeadlineMs | 30000 | 100..120000 |
| closeDeadlineMs | 10000 | 100..120000 |
| gracefulCloseMs | 2000 | 0..30000 |
| pageBytes | 12000 | 1024..1048576 |
| memoryWindowBytes | 1048576 | 65536..16777216 |
| queuedInputBytes | 65536 | 1024..1048576 |
| artifactCaptureBytes | 67108864 | 1048576..1073741824 |
| artifactChunkBytes | 1048576 | 65536..16777216 |
| persistenceQueueBytes | 1048576 | 65536..16777216 |
| idleTimeoutMs | disabled | 1000..86400000 |
| lifetimeTimeoutMs | disabled | 1000..604800000 |

Per-operation timeout overrides are permitted only within the same bounds. Dimensions are integers from 2 through 1000. PTY defaults to 80x24.

Timers use an injected monotonic `Clock`; wall time is used only for receipts. Accepted input and observed output update `lastActivityAt`. Idle deadlines reset from that activity; lifetime deadlines never reset. Timer callbacks enter the same `finalizeOnce` path as explicit Close.

## Tool Contracts

Seven additive tools are defined in `src/tools/definitions.ts`; existing definitions are not edited except by appending these entries. They are forbidden inside `tool.batch` because ordering, confirmation, waits, and ownership must remain explicit.

### `terminal.start`

```ts
{
  command: string;
  cwd?: string;
  terminalMode?: "required" | "preferred" | "pipe"; // preferred
  columns?: number;
  rows?: number;
  idleTimeoutMs?: number;
  lifetimeTimeoutMs?: number;
  deadlineMs?: number;
}
```

Returns session ID, state, transport, optional dimensions, degraded reason, cursor, and redacted artifact reference.

### `terminal.send`

```ts
{
  id: string;
  kind: "text" | "control" | "eof";
  text?: string;
  submit?: "enter" | "none";
  control?: "interrupt" | "eof" | "suspend" | "escape" | "tab" |
            "backspace" | "up" | "down" | "left" | "right";
  cursor?: number;
  quietMs?: number;
  deadlineMs?: number;
  view?: "plain" | "encoded";
}
```

Dependent fields are strictly validated. `cursor` defaults to the cursor captured at action acceptance, so prior output is not replayed. The result includes input sequence, delivery status/bytes, output page, state, and optional stable error.

### `terminal.read`

```ts
{
  id: string;
  cursor: number;
  waitMs?: number; // 0 means nonblocking, max 30000
  view?: "plain" | "encoded";
}
```

### `terminal.status`, `terminal.list`, `terminal.resize`, `terminal.close`

```ts
// status
{ id: string }
// list
{}
// resize
{ id: string; columns: number; rows: number }
// close
{ id: string; deadlineMs?: number }
```

The implementation extends `ToolResult` additively:

```ts
export interface ToolResult {
  // existing fields unchanged
  interactiveSession?: InteractiveSessionToolResult;
}

export interface StableError {
  code: StableErrorCode;
  message: string;
  retryable: boolean;
  operation: SessionOperation;
  sessionId?: string;
  state?: SessionState;
  details?: Record<string, string | number | boolean>;
}
```

`output` remains a concise, ANSI-free JSON/text projection for current providers and transcripts. Structured consumers use `interactiveSession`. A deadline or output-gap result can carry both a page and an error.

## Stable Errors and Retryability

All errors are constructed through `sessionError()` so code, operation, message, retryability, state, and allocated ID are consistent. Details use an allowlist; command, input, output, environment, and raw native errors are excluded.

Retryability describes whether a new, caller-decided operation can be useful; it never triggers an automatic retry. `INPUT_DELIVERY_UNKNOWN`, any failure after input delivery, `CANCELLED`, `OUTPUT_GAP`, `INPUT_REJECTED`, closing/input-closed errors, and post-launch deadline errors are nonretryable. `BACKPRESSURE` and `LIMIT_REACHED` may be retryable after state changes. `LAUNCH_FAILED` is retryable only when no process side effect was possible. `PERSIST_FAILED` is retryable only before launch. Cleanup failure is nonretryable and requires operator diagnostics.

## Observability

`SessionTelemetry` calls existing `auditLog` with an explicit metadata object rather than a generic object dump. Each operation records operation, HMAC-redacted session ID, duration, result code, state, input/output byte counts, queue depth, automatic retry count, termination reason, transport, and allocation-cleanup verification when applicable.

It never passes raw input, output, commands, cwd, environment, confirmation previews, artifact content, native exception text, or raw session IDs. Fields and strings are bounded before calling `auditLog`; existing log rotation remains unchanged.

## Race and Concurrency Model

- An owner registry mutex protects ID issuance and live-slot reservation.
- Each session has one mutation mutex for state checks, input acceptance, EOF, resize, and closing transition.
- One FIFO writer drain owns transport input; accepted actions never write concurrently.
- Output ingestion has one append chain and does not take the mutation mutex, avoiding a chatty process blocking Close.
- Waiters subscribe to an output generation counter and are removed on completion/cancel.
- `finalizeOnce` is the sole terminal cleanup promise.
- Different sessions share no locks, queues, cursor state, or operation deadlines.
- Registry snapshots are immutable, allowing Status and List to remain nonblocking.

This model resolves Send/EOF/Close, Resize/Close, output/eviction/read, and exit/timeout/shutdown races without a global I/O lock.

## Rollout and Fallback

1. Land the subsystem behind `interactiveSessions.enabled` and keep legacy tools unchanged.
2. Enable pipe integration/property tests on all CI jobs first.
3. Enable PTY capability and fixture tests per target only after the exact native sidecar passes release smoke tests.
4. Publish capability in diagnostics and Start errors; do not claim PTY when load/spawn smoke fails.
5. Keep an environment kill switch that disables only the seven new tools at runtime. Existing shell/jobs remain operational.
6. Never auto-migrate detached jobs, never rewrite a failed command, and never retry delivered input.

## Testing Strategy

All tests and correctness-property tasks in this section are mandatory release gates, not optional MVP work. A capability-dependent test may skip only with an explicit machine-readable reason; its unavailable-capability and fallback assertions must still pass. Testing uses Vitest and the existing exact `fast-check` dependency. Property tests run at least 100 cases and include a comment tag in this format:

```ts
// Feature: interactive-terminal-sessions, Property 4: Accepted input is FIFO and at-most-once
```

### Unit and property tests

- Registry state model, owner isolation, limits, ID collision handling, and sorting.
- Transport selection and capability fallback with fake factories.
- Ordered writer queue under randomized completion schedules and 100+ concurrent sends.
- Cursor/page/eviction/UTF-8/non-UTF-8 behavior with arbitrary byte arrays.
- ANSI neutralization, carriage return/backspace determinism, encoded round trips, and streaming redaction across every chunk split.
- Fake-clock quiet/deadline/idle/lifetime schedules.
- Token binding, one-time consumption, and policy monotonicity.
- Artifact rotation, digest, dropped-byte accounting, and stalled-writer backpressure.
- Model-based state transitions and randomized cleanup races.
- Error and telemetry field/exclusion invariants.

### Deterministic integration fixtures

Add a small Node fixture under `test/fixtures/interactive-child.mjs` supporting prompt, echo, delayed output, unsolicited output, binary bytes, signal reporting, child/grandchild spawning, EOF, TERM resistance, and heartbeat/port evidence. It has no external security-tool dependency.

Integration tests cover all seven operations, pipe and PTY, each control mapping, explicit/default Send cursor selection, quiet baselining after delivery, operation cancellation that leaves the session live, owner cancellation that closes it once, final output drain, writer failure, owner/app cleanup, recovery-journal identity outcomes, and secret canaries across binary/UTF-8 chunk boundaries plus registry, artifact, telemetry, transcript, preview, display, and errors.

A Python REPL test runs on macOS, Linux, and Windows when `python3` or `python` capability is present and otherwise records an explicit skip reason. Platform CI also verifies parent/child/grandchild disappearance. PID reuse is deterministic through a fake `ProcessIdentityProvider`; each platform separately smoke-tests real identity capture.

### Regression validation

The existing suites remain unchanged and run in the same CI job, especially:

- `shell-bounded.test.ts`
- `shell-interactive.test.ts`
- `shell-launch-retry.test.ts`
- `jobs-durable.test.ts`
- `jobs-resource-hygiene.test.ts`
- `jobs-session-scope.test.ts`
- `process-tree.test.ts`
- `safety.test.ts`, `engagement-policy.test.ts`, and artifact/history redaction tests
- cancellation and application lifecycle contract tests

Build validation includes `npm run typecheck`, targeted `vitest run` files, full `npm test`, `npm run build`, and matching-target packaged PTY capability smoke tests. Release validation also installs each produced target package through the shell installer, PowerShell installer, Homebrew formula, or Scoop manifest applicable to that target and verifies that capability reporting matches the installed sidecar layout. No watch mode or development server is used in automated validation.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties bridge human-readable requirements and machine-verifiable correctness guarantees.*

Property reflection consolidated overlapping prework properties: cursor continuity includes `nextCursor`, `hasMore`, and repeated-page completeness; input FIFO includes sequence assignment and no retry; cleanup-once includes all competing termination triggers; secret non-disclosure combines all presentation and persistence sinks. Example, edge, smoke, and external-platform criteria remain in the test strategy rather than being forced into property tests.

### Property 1: Start receipt and transport selection are coherent

For any valid Start request and PTY capability result, a successful launch returns exactly one session whose reported transport matches `required`, `preferred`, or `pipe` selection rules, whose dimensions are present only for PTY, and whose receipt contains an opaque ID, valid state, cursor, and redacted artifact reference; an unsuccessful selection spawns no process.

**Validates: Requirements 1.2, 2.1, 2.2, 2.3, 2.4, 14.3**

### Property 2: Session identity and ownership are non-disclosing

For all generated sensitive launch metadata, owners, and sessions, generated Session IDs are unique within the application lifetime and independent of process IDs, commands, paths, secrets, and counters, and every operation by a different owner returns `SESSION_NOT_FOUND` without revealing whether the ID exists.

**Validates: Requirements 1.3, 3.1, 3.2**

### Property 3: Registry limits, ordering, and state transitions hold

For any sequence of starts, exits, closes, and failures across owners, live records never exceed each owner's configured limit, over-limit starts perform no spawn, every state transition belongs to the allowed transition relation, and List returns at most 50 owner records ordered live-first and then by descending start time.

**Validates: Requirements 1.4, 3.3, 3.4, 3.5**

### Property 4: Accepted input is FIFO and at-most-once

For any finite set of concurrently accepted text or control actions targeting one running session, each action receives one increasing Input Sequence before delivery, transport delivery occurs in ascending sequence order, each action is attempted at most once, and exact text encoding appends either no terminator or exactly one transport Enter as requested.

**Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.10, 9.3, 14.4**

### Property 5: EOF and backpressure acceptance are atomic

For any session state, queued-byte count, and candidate action, acceptance either reserves the entire action within the backpressure bound or changes no queue/sequence state; EOF closes input at most once, all later input is rejected without writes, and input accepted before exit is either delivered with an exact count or rejected with its exact delivered-byte count.

**Validates: Requirements 4.7, 4.8, 9.1, 9.2, 9.8**

### Property 6: Quiet gathering obeys one absolute deadline

For any generated output schedule, quiet interval, operation deadline, process-exit time, and cancellation time, Send or blocking Read completes at the earliest applicable stop condition; quiet detection begins at delivery completion, only later output resets it, the absolute deadline never extends, operation cancellation removes only that operation's wait state, and owner cancellation joins the one session finalizer.

**Validates: Requirements 5.1, 5.4, 5.6, 5.8, 5.9, 5.10, 14.6**

### Property 7: Cursor assignment preserves observation order

For any interleaving of PTY or pipe output chunks, canonical redacted cursor ranges are contiguous, monotonic, and ordered by callback observation, with PTY labeled `terminal` and pipe data retaining its `stdout` or `stderr` identity.

**Validates: Requirements 6.1, 6.2, 6.3**

### Property 8: Cursor pagination is gap-free within retention

For any retained canonical byte sequence, valid explicit or acceptance-captured starting cursor, output view, and page limit, a page begins at the selected cursor, ends at `nextCursor`, sets `hasMore` exactly when retained bytes follow, respects its visible-byte bound, and repeated reads from returned cursors cover the retained interval without duplication, reordering, or silent omission.

**Validates: Requirements 6.4, 6.5, 6.6, 6.8, 6.10, 6.13, 14.5**

### Property 9: Output retention remains bounded and reports eviction

For any output chunk sequence larger than the configured memory window, retained canonical bytes never exceed the window, eviction only advances the earliest cursor, and every request before that cursor returns `OUTPUT_GAP` with the exact earliest cursor, omitted-byte count, and artifact reference.

**Validates: Requirements 6.7, 6.9, 14.5**

### Property 10: Binary and text boundaries preserve safe source data

For any byte sequence, including invalid UTF-8 and multibyte code points split at arbitrary chunk/page boundaries, encoded output decodes to the canonical redacted bytes, plain pages never end with an incomplete UTF-8 code point, and any lossy plain decoding is explicitly marked.

**Validates: Requirements 6.11, 6.12, 7.2**

### Property 11: Presented output cannot execute terminal controls

For any generated output containing ANSI, OSC, DCS, C0/C1, carriage-return, and backspace sequences, plain output contains no executable host-terminal control effect, encoded output uses only its transport-safe representation, and repeated transformation with identical bytes and dimensions produces identical text.

**Validates: Requirements 7.1, 7.4, 14.7**

### Property 12: Resize cannot revive or mutate an incompatible session

For any valid dimensions and any interleaving of Resize with Close or process exit, a running PTY either applies and reports those dimensions or returns a terminal-state error; a pipe never resizes, and no outcome transitions a terminal/closing session back to running.

**Validates: Requirements 7.5, 7.7**

### Property 13: Exact-input policy gates every delivery

For any owning session and exact later-input action, the contextual policy receives that exact action once; safe actions may queue without confirmation, blocked actions never queue, and confirm actions cannot queue until a token bound to the exact owner, session, bytes, kind, submit behavior, and decision is atomically consumed.

**Validates: Requirements 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 14.8**

### Property 14: Interactive command risk is monotonic

For any command classified at both the existing shell boundary and interactive Start boundary, the interactive Risk Decision is never less restrictive, and process allocation occurs only after the Start policy decision permits it.

**Validates: Requirements 8.1, 8.2, 13.6**

### Property 15: Sensitive data never reaches a persistence or presentation sink

For any sensitive value inserted into input or output at any chunk boundary, including beside invalid UTF-8, the exact known byte sequence is absent from registry/journal records, artifacts, telemetry, transcripts, confirmation previews, command displays, stable errors, plain output, and encoded output, textual patterns are redacted from valid decoded text, and every durable artifact write occurs only after bounded streaming redaction.

**Validates: Requirements 7.3, 8.9, 8.10, 8.11, 8.13, 12.4, 12.7, 14.9**

### Property 16: Artifact rotation and accounting are complete

For any output stream and artifact limits, captured bytes never exceed the limit, ordered chunk metadata reconstructs exactly the captured redacted bytes, the digest matches those bytes, and captured plus dropped accounting equals all writer-accepted canonical bytes.

**Validates: Requirements 9.5, 12.5**

### Property 17: Sessions isolate mutable I/O state

For any interleaving of operations across distinct Session IDs, input queues, sequences, output cursors, deadlines, waiters, errors, and finalization outcomes for one session are unaffected by operations on another.

**Validates: Requirements 9.6**

### Property 18: Closing rejects later input and finalizes once

For any interleaving of Close, process exit, owner cancellation, idle timeout, lifetime timeout, conversation teardown, application shutdown, reset, history rebind, and disposal, the old owner is fenced before rebinding, `closing` is committed before a termination action, all subsequently submitted input is rejected, exactly one cleanup execution owns the terminal transition, operation cancellation alone does not close the session, and repeated Close returns the same terminal result without another signal.

**Validates: Requirements 5.10, 9.7, 11.1, 11.10, 11.11, 11.13, 14.11**

### Property 19: Activity and lifetime timers have independent invariants

For any monotonic schedule of accepted input and observed output, activity time equals the latest such event, idle expiry is measured from that value, and lifetime expiry remains fixed relative to successful launch regardless of activity.

**Validates: Requirements 10.4, 10.5, 10.6**

### Property 20: Automatic retries stop at the side-effect boundary

For any injected launch or operation failure, automatic Start attempts are at most two only when the first failure proves no process side effect occurred, at most one after spawn confirmation, and every input delivery operation is attempted exactly zero or one times with no payload rewriting.

**Validates: Requirements 10.7, 10.8, 10.10, 14.14, 15.7**

### Property 21: Cleanup is identity-safe and resource-complete

For any process liveness/identity result and termination reason, cleanup signals only a matching live process tree, treats absence or identity mismatch as safe non-ownership, and releases each process, terminal, timer, listener, writer, waiter, queue, token, and registry resource at most once.

**Validates: Requirements 11.4, 11.6, 14.13**

### Property 22: Stable errors are complete and non-secret

For any operation failure, the returned Stable Error uses a declared code, contains operation, actionable bounded message, retryability, allocated Session ID and current state when applicable, excludes secret command/input/output data, and reports exact omission metadata when output is truncated.

**Validates: Requirements 10.9, 12.1, 12.2, 12.9**

### Property 23: Telemetry is bounded metadata only

For any completed operation and outcome, telemetry contains the required bounded operation/state/count/duration/retry/termination metadata when applicable while excluding raw IDs, inputs, outputs, commands, environment values, and artifact content.

**Validates: Requirements 12.6, 12.7**

### Property 24: Legacy execution never allocates an interactive transport

For any existing `shell.exec`, `shell.start`, `shell.jobs`, `shell.tail`, or `shell.stop` invocation, installing or enabling interactive sessions does not call the PTY/interactive transport factory and does not change the legacy argument/result projection.

**Validates: Requirements 13.1, 13.4, 13.5, 13.7, 13.8**

### Property 25: Safety controls cannot be bypassed by operation order

For any generated sequence of Start, Send, Read, Resize, Close, cancellation, and teardown operations, no process launch or input delivery can occur before required policy approval, no output can persist before redaction, configured limits remain enforced, and every live session remains reachable by cancellation and cleanup ownership.

**Validates: Requirements 15.6**
