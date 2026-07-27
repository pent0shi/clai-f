# Requirements Document

## Introduction

This specification defines agent-controlled persistent interactive terminal sessions for clai. The feature enables an agent to start terminal-oriented processes and REPLs, send later input, collect ordered output, inspect status, resize a terminal, and close sessions without handing the host terminal directly to a user. The feature extends clai's existing approval, classification, output-bounding, artifact, cancellation, redaction, and process-tree cleanup controls while preserving all existing foreground shell and detached background-job behavior.

## Glossary

- **Interactive_Session_Manager**: The clai subsystem that owns persistent interactive process lifecycle and operations.
- **Interactive_Session**: One agent-controlled process with persistent input and output channels.
- **Session_Operation**: One of Start, Send, Read, Status, List, Resize, or Close.
- **Start**: The operation that creates an Interactive_Session after policy approval and process launch confirmation.
- **Send**: The operation that submits Text_Input, Control_Input, or EOF_Input and gathers resulting output.
- **Read**: The operation that retrieves delayed or unsolicited output without submitting input.
- **Status**: The operation that returns the current Session_State and process outcome.
- **List**: The operation that returns bounded summaries for sessions owned by the current Conversation.
- **Resize**: The operation that changes Terminal_Dimensions for a PTY_Transport.
- **Close**: The idempotent operation that terminates an Interactive_Session and verifies descendant cleanup.
- **Session_ID**: An opaque, non-reusable identifier generated for one Interactive_Session.
- **Conversation**: The clai interaction context that owns an Interactive_Session.
- **Session_Registry**: The owner-scoped record of live and recently terminal Interactive_Sessions.
- **Session_State**: One value from `starting`, `running`, `closing`, `exited`, `failed`, or `closed`.
- **Termination_Reason**: One value from `process-exit`, `explicit-close`, `cancelled`, `idle-timeout`, `lifetime-timeout`, `conversation-teardown`, `app-shutdown`, `output-limit`, or `launch-failure`.
- **Session_Transport**: One value from `pty` or `pipe`.
- **PTY_Transport**: A pseudoterminal-backed Session_Transport that provides terminal semantics to the child process.
- **Pipe_Transport**: A Session_Transport that uses managed process input, standard output, and standard error without terminal emulation.
- **Terminal_Mode**: A Start option with value `required`, `preferred`, or `pipe`.
- **Supported_Platform**: A clai release target running Node.js 20 or newer on macOS, Linux, or Windows.
- **Terminal_Dimensions**: Positive integer columns and rows associated with a PTY_Transport.
- **Text_Input**: A UTF-8 string plus an explicit submit behavior that either sends terminal Enter or sends no line terminator.
- **Control_Input**: A named terminal action from `interrupt`, `eof`, `suspend`, `escape`, `tab`, `backspace`, `up`, `down`, `left`, or `right`.
- **EOF_Input**: An input action that closes the child input direction according to the active Session_Transport.
- **Input_Sequence**: A monotonically increasing integer assigned to each accepted input action in one Interactive_Session.
- **Output_Event**: An ordered output record containing a Cursor range, stream identity, timestamp, and bounded content.
- **Output_Stream**: One value from `terminal`, `stdout`, or `stderr`.
- **Cursor**: A monotonically increasing byte offset in one Interactive_Session's logical output sequence.
- **Output_Page**: A contiguous, bounded sequence of Output_Events with `nextCursor` and `hasMore` fields.
- **Quiet_Interval**: A configured period with no newly observed process output after Send completes input delivery.
- **Hard_Deadline**: The maximum elapsed time for a Start, Send, blocking Read, or Close operation.
- **Operation_Cancellation**: Cancellation of one in-flight Send or blocking Read wait; it does not by itself terminate the Interactive_Session.
- **Owner_Cancellation**: Cancellation of all work owned by a Conversation; it closes every live Interactive_Session for that Conversation with Termination_Reason `cancelled`.
- **Output_View**: A requested representation with value `plain` or `encoded`.
- **Plain_Output**: UTF-8 text with unsafe terminal control effects neutralized.
- **Encoded_Output**: A transport-safe encoding of redacted output bytes that cannot execute terminal controls in the clai host terminal.
- **ANSI_Control_Sequence**: A terminal escape, operating-system command, device-control, cursor-control, or equivalent non-printing sequence.
- **Output_Store**: The bounded in-memory output window and redacted artifact capture for an Interactive_Session.
- **Artifact**: A permission-restricted, bounded, redacted file containing captured session output.
- **Policy_Engine**: The existing clai classification, confirmation, permission, and engagement-scope enforcement boundary.
- **Risk_Decision**: One Policy_Engine result from `safe`, `confirm`, or `block`.
- **Approval_Token**: A single-use authorization bound to one exact input payload, Session_ID, and Risk_Decision.
- **Sensitive_Data**: Credentials, secrets, tokens, private keys, protected values, or data matched by clai's secret-protection rules.
- **Backpressure_Limit**: The configured maximum queued input bytes for one Interactive_Session.
- **Live_Session_Limit**: The configured maximum number of nonterminal Interactive_Sessions owned by one Conversation.
- **Idle_Timeout**: An optional duration measured since the most recent accepted input or observed output.
- **Lifetime_Timeout**: An optional duration measured since successful process launch.
- **Cleanup_Coordinator**: The clai subsystem that closes sessions, terminates process trees, and verifies terminal state.
- **Process_Tree**: The session process and every descendant created by the session process.
- **Process_Identity**: Platform-specific evidence that a process identifier still refers to the process launched for an Interactive_Session.
- **Stable_Error**: A structured failure containing `code`, `message`, `retryable`, `operation`, and, when allocated, `sessionId`.
- **Telemetry_Recorder**: The clai subsystem that emits bounded, redacted lifecycle and operation diagnostics.
- **Compatibility_Layer**: The existing `shell.exec`, `shell.start`, `shell.jobs`, `shell.tail`, and `shell.stop` behavior and contracts.
- **Test_Suite**: Automated unit, integration, property, race, and Supported_Platform tests for the feature.

## Requirements

### Requirement 1: Agent-Controlled Session Operations

**User Story:** As an agent, I want explicit persistent-session operations, so that I can interact with terminal programs across multiple tool calls.

#### Acceptance Criteria

1. THE Interactive_Session_Manager SHALL provide Start, Send, Read, Status, List, Resize, and Close operations.
2. WHEN Start confirms process launch, THE Interactive_Session_Manager SHALL return a Session_ID, Session_State, Session_Transport, Terminal_Dimensions when applicable, Cursor, and redacted Artifact reference.
3. WHEN any Session_Operation references a Session_ID owned by another Conversation, THE Interactive_Session_Manager SHALL return a `SESSION_NOT_FOUND` Stable_Error.
4. WHEN List is requested, THE Session_Registry SHALL return at most 50 owner-scoped session summaries ordered by live state before terminal state and then by descending start time.
5. WHEN Status is requested, THE Session_Registry SHALL return without waiting for process output.
6. THE Interactive_Session_Manager SHALL keep direct user-terminal handoff outside the Session_Operation contract.

### Requirement 2: Terminal Transport and Platform Behavior

**User Story:** As an agent, I want predictable terminal semantics across supported operating systems, so that REPLs and terminal-oriented tools behave consistently.

#### Acceptance Criteria

1. WHERE Terminal_Mode is `required`, THE Interactive_Session_Manager SHALL use PTY_Transport or return a `PTY_UNAVAILABLE` Stable_Error before process launch.
2. WHERE Terminal_Mode is `preferred`, THE Interactive_Session_Manager SHALL use PTY_Transport when PTY capability is available.
3. WHERE Terminal_Mode is `preferred`, IF PTY capability is unavailable, THE Interactive_Session_Manager SHALL use Pipe_Transport and return a degraded-transport reason of `PTY_UNAVAILABLE`.
4. WHERE Terminal_Mode is `pipe`, THE Interactive_Session_Manager SHALL use Pipe_Transport without attempting PTY allocation.
5. THE Interactive_Session_Manager SHALL expose PTY capability separately for macOS, Linux, and Windows Supported_Platform targets.
6. WHEN PTY_Transport starts without explicit Terminal_Dimensions, THE Interactive_Session_Manager SHALL use 80 columns and 24 rows.
7. IF requested Terminal_Dimensions contain a value outside 2 through 1000, THEN THE Interactive_Session_Manager SHALL return an `INVALID_REQUEST` Stable_Error before process launch or resize.
8. WHEN PTY capability initialization fails after resource allocation but before launch confirmation, THE Cleanup_Coordinator SHALL release the allocated terminal resources before Start returns.
9. BEFORE a Supported_Platform release advertises PTY capability, THE release pipeline SHALL build or obtain the pinned PTY native artifact for the exact operating-system, architecture, Node.js ABI, and Bun runtime combination and SHALL pass load, spawn, resize, input, output, and cleanup smoke tests on a matching target runner.
10. IF the exact packaged executable and native artifact cannot pass the matching-target smoke test, THEN that release target SHALL advertise PTY capability as unavailable while preserving Pipe_Transport and Compatibility_Layer behavior.

### Requirement 3: Identity, Limits, and Stable State

**User Story:** As an operator, I want bounded sessions and stable status values, so that parallel interactive work remains controllable.

#### Acceptance Criteria

1. THE Session_Registry SHALL generate a Session_ID that reveals no process identifier, command text, path, secret, or sequential counter.
2. THE Session_Registry SHALL prevent Session_ID reuse within one application lifetime.
3. THE Interactive_Session_Manager SHALL enforce a configurable Live_Session_Limit with a default of 4 and an allowed range of 1 through 32 per Conversation.
4. IF Start would exceed the Live_Session_Limit, THEN THE Interactive_Session_Manager SHALL return a `LIMIT_REACHED` Stable_Error without spawning a process.
5. WHEN Session_State changes, THE Session_Registry SHALL preserve a valid transition from `starting` to `running`, `exited`, or `failed`; from `running` to `closing`, `exited`, or `failed`; and from `closing` to `closed`, `exited`, or `failed`; after the first terminal transition, later finalization or exit observations SHALL preserve that same terminal state and may only enrich its recorded outcome.
6. WHEN a process terminates, THE Session_Registry SHALL record exit code, signal or platform-equivalent outcome, end time, and Termination_Reason when each value is available.
7. WHEN Start receives an invalid configuration value, THE Interactive_Session_Manager SHALL return an `INVALID_CONFIGURATION` Stable_Error before process launch.

### Requirement 4: Input Submission and Ordering

**User Story:** As an agent, I want deterministic later input delivery, so that multi-step REPL interactions do not repeat or reorder commands.

#### Acceptance Criteria

1. WHEN Send accepts Text_Input, THE Interactive_Session_Manager SHALL assign one Input_Sequence before writing input bytes.
2. WHEN multiple Send operations target one Interactive_Session concurrently, THE Interactive_Session_Manager SHALL write accepted input actions in ascending Input_Sequence order.
3. WHEN Text_Input requests terminal Enter, THE Interactive_Session_Manager SHALL append exactly one transport-appropriate Enter action after the supplied UTF-8 text.
4. WHEN Text_Input requests no line terminator, THE Interactive_Session_Manager SHALL write only the UTF-8 bytes represented by the supplied text.
5. WHEN Send accepts Control_Input, THE Interactive_Session_Manager SHALL deliver the named terminal action once or return an `UNSUPPORTED_CONTROL` Stable_Error before delivery.
6. WHEN Send accepts `interrupt` Control_Input, THE Interactive_Session_Manager SHALL keep the Interactive_Session available unless the child process exits.
7. WHEN Send accepts EOF_Input, THE Interactive_Session_Manager SHALL close the child input direction exactly once.
8. IF Send follows accepted EOF_Input, THEN THE Interactive_Session_Manager SHALL return an `INPUT_CLOSED` Stable_Error without writing bytes.
9. IF a write result cannot establish whether input bytes were accepted, THEN THE Interactive_Session_Manager SHALL return an `INPUT_DELIVERY_UNKNOWN` Stable_Error with `retryable` set to false.
10. THE Interactive_Session_Manager SHALL perform no automatic retry of Send, Control_Input, or EOF_Input.

### Requirement 5: Quiet-Interval Gathering and Deadlines

**User Story:** As an agent, I want each send to gather a useful response without hanging, so that follow-up decisions use current terminal output.

#### Acceptance Criteria

1. WHEN Send completes an input write, THE Interactive_Session_Manager SHALL gather Output_Events until the Quiet_Interval elapses, the Hard_Deadline elapses, the process terminates, Operation_Cancellation occurs, or another terminal trigger occurs.
2. THE Interactive_Session_Manager SHALL provide a configurable Quiet_Interval with a default of 250 milliseconds and an allowed range of 25 through 5000 milliseconds.
3. THE Interactive_Session_Manager SHALL provide a configurable Send Hard_Deadline with a default of 30000 milliseconds and an allowed range of 100 through 120000 milliseconds.
4. WHILE output continues before the Quiet_Interval elapses, THE Interactive_Session_Manager SHALL extend quiet detection without extending the Send Hard_Deadline.
5. WHEN the Send Hard_Deadline elapses after input delivery, THE Interactive_Session_Manager SHALL return gathered Output_Page data with a `DEADLINE_EXCEEDED` Stable_Error and `retryable` set to false.
6. WHEN a blocking Read is requested, THE Interactive_Session_Manager SHALL cap the requested wait at 30000 milliseconds.
7. WHEN a nonblocking Read is requested, THE Interactive_Session_Manager SHALL return currently available Output_Page data without waiting for new process output.
8. WHEN Operation_Cancellation occurs during Send or blocking Read, THE Interactive_Session_Manager SHALL return a `CANCELLED` Stable_Error within the applicable Hard_Deadline, remove only that operation's waiters and timers, and leave the Interactive_Session available unless another terminal trigger occurs.
9. WHEN Send delivery completes, THE Interactive_Session_Manager SHALL start Quiet_Interval detection at delivery completion; only output observed after delivery completion SHALL reset that quiet timer, while the returned Output_Page MAY begin at the request's earlier selected Cursor.
10. WHEN Owner_Cancellation races with an in-flight Send or blocking Read, THE Cleanup_Coordinator SHALL own session termination and the operation SHALL settle without replaying input or running cleanup a second time.

### Requirement 6: Output Ordering, Cursors, and Bounds

**User Story:** As an agent, I want ordered cursor-based output, so that delayed or unsolicited data can be consumed without duplication or silent gaps.

#### Acceptance Criteria

1. WHEN process output is observed, THE Output_Store SHALL assign Cursor ranges in observation order without reordering Output_Events.
2. WHERE Session_Transport is PTY_Transport, THE Output_Store SHALL label process output as `terminal` Output_Stream.
3. WHERE Session_Transport is Pipe_Transport, THE Output_Store SHALL label process output as `stdout` or `stderr` Output_Stream.
4. WHEN Read supplies a Cursor, THE Output_Store SHALL return a contiguous Output_Page beginning at the supplied Cursor.
5. WHEN Send returns output, THE Output_Store SHALL return a contiguous Output_Page and a `nextCursor` equal to the first byte after the returned page.
6. WHEN more retained output exists after `nextCursor`, THE Output_Store SHALL set `hasMore` to true.
7. IF a supplied Cursor precedes the earliest retained byte, THEN THE Output_Store SHALL return an `OUTPUT_GAP` Stable_Error containing `earliestAvailableCursor`, omitted byte count, and the Artifact reference.
8. THE Output_Store SHALL bound each model-visible Output_Page to a configurable byte limit with a default of 12000 bytes and an allowed range of 1024 bytes through 1048576 bytes.
9. THE Output_Store SHALL bound the in-memory output window per Interactive_Session to a configurable limit with a default of 1048576 bytes and an allowed range of 65536 bytes through 16777216 bytes.
10. WHEN an Output_Page reaches the model-visible byte limit, THE Output_Store SHALL preserve remaining retained output for a later Read.
11. WHEN output contains an incomplete UTF-8 code point at an Output_Page boundary, THE Output_Store SHALL end the page before the incomplete code point.
12. WHEN a process emits non-UTF-8 bytes, THE Output_Store SHALL preserve redacted bytes in Encoded_Output or the Artifact and mark Plain_Output decoding loss.
13. WHEN Send supplies a Cursor, THE Output_Store SHALL begin its returned contiguous Output_Page at that Cursor; otherwise it SHALL begin at the Cursor captured when the input action is accepted, and in either case `nextCursor` SHALL remain a canonical safe-byte offset independent of rendered length.

### Requirement 7: Terminal Rendering, Resize, and Control Safety

**User Story:** As an agent, I want terminal prompts and control behavior represented safely, so that terminal-oriented applications remain usable without corrupting the clai interface.

#### Acceptance Criteria

1. WHERE Output_View is `plain`, THE Output_Store SHALL neutralize ANSI_Control_Sequence effects before model, transcript, log, or user-interface presentation.
2. WHERE Output_View is `encoded`, THE Output_Store SHALL return terminal bytes in a representation that cannot execute ANSI_Control_Sequence effects in the host terminal.
3. THE Output_Store SHALL apply Sensitive_Data redaction to Plain_Output and Encoded_Output.
4. WHEN Plain_Output contains carriage return or backspace behavior, THE Output_Store SHALL produce deterministic text for identical input bytes and Terminal_Dimensions.
5. WHEN Resize targets a running PTY_Transport, THE Interactive_Session_Manager SHALL apply the requested Terminal_Dimensions and return the applied values.
6. WHEN Resize targets Pipe_Transport, THE Interactive_Session_Manager SHALL return an `UNSUPPORTED_OPERATION` Stable_Error without changing Session_State.
7. WHEN Resize races with Close or process exit, THE Interactive_Session_Manager SHALL return either the applied dimensions or a terminal-state Stable_Error without reviving the process.
8. THE Interactive_Session_Manager SHALL keep full terminal screen emulation outside the Plain_Output contract.

### Requirement 8: Approval, Classification, and Secret Protection

**User Story:** As an operator, I want every interactive action governed by existing safety controls, so that persistence does not bypass command approval or leak secrets.

#### Acceptance Criteria

1. WHEN Start is requested, THE Policy_Engine SHALL apply the existing command approval, permission, and engagement-scope rules before process launch.
2. IF the Start Risk_Decision is `block`, THEN THE Interactive_Session_Manager SHALL return a policy Stable_Error without allocating a live process.
3. WHEN Send, Control_Input, or EOF_Input is requested, THE Policy_Engine SHALL classify the exact action in the context of the owning Interactive_Session before delivery.
4. WHERE a later-input Risk_Decision is `safe`, THE Interactive_Session_Manager SHALL deliver the input without requesting confirmation.
5. WHERE a later-input Risk_Decision is `confirm`, THE Interactive_Session_Manager SHALL require an Approval_Token before delivery.
6. WHERE a later-input Risk_Decision is `block`, THE Interactive_Session_Manager SHALL return an `INPUT_REJECTED` Stable_Error without delivery.
7. WHEN an Approval_Token is presented, THE Policy_Engine SHALL accept the Approval_Token only for the bound Session_ID and exact input payload.
8. WHEN an Approval_Token is accepted, THE Policy_Engine SHALL invalidate the Approval_Token before input delivery.
9. WHEN an input action contains Sensitive_Data, THE Interactive_Session_Manager SHALL exclude raw Sensitive_Data from registry records, artifacts, telemetry, transcripts, confirmation previews, command displays, and errors.
10. WHEN output contains Sensitive_Data, THE Output_Store SHALL redact Sensitive_Data before persistence or presentation.
11. WHEN a confirmation preview represents Sensitive_Data, THE Policy_Engine SHALL show a redacted description and the applicable risk reason.
12. THE Interactive_Session_Manager SHALL keep inherited host stdin disabled for agent-controlled Interactive_Sessions.
13. WHEN known Sensitive_Data byte sequences cross process-output chunks or occur adjacent to non-UTF-8 bytes, THE Output_Store SHALL redact them with bounded byte-stream matching before assigning Cursors, persisting Artifacts, or producing Plain_Output or Encoded_Output; text-pattern redaction SHALL additionally apply to valid decoded text.

### Requirement 9: Concurrency and Backpressure

**User Story:** As an operator, I want bounded concurrent I/O, so that chatty or stalled processes cannot exhaust memory or corrupt input ordering.

#### Acceptance Criteria

1. THE Interactive_Session_Manager SHALL enforce a configurable Backpressure_Limit with a default of 65536 queued input bytes and an allowed range of 1024 through 1048576 bytes per Interactive_Session.
2. IF accepting an input action would exceed the Backpressure_Limit, THEN THE Interactive_Session_Manager SHALL return a `BACKPRESSURE` Stable_Error without partially accepting the action.
3. WHILE one input action is being written, THE Interactive_Session_Manager SHALL keep later accepted input actions queued in Input_Sequence order.
4. WHEN output persistence applies backpressure, THE Output_Store SHALL bound memory use by pausing process reads, applying the configured output-limit policy, or terminating the session with Termination_Reason `output-limit`.
5. WHEN output bytes exceed the configured Artifact capture limit, THE Output_Store SHALL record captured bytes, dropped bytes, and the configured output-limit outcome.
6. WHEN Session_Operations target different Interactive_Sessions, THE Interactive_Session_Manager SHALL isolate input queues, Cursors, deadlines, and failures by Session_ID.
7. WHEN Close begins, THE Interactive_Session_Manager SHALL reject newly submitted input with a `SESSION_CLOSING` Stable_Error.
8. WHEN queued input remains at process exit, THE Interactive_Session_Manager SHALL reject undelivered queue entries with a terminal-state Stable_Error and delivered-byte count.

### Requirement 10: Timeout, Idle, and Retry Policy

**User Story:** As an operator, I want bounded waits and explicit retry rules, so that failures do not cause hangs or duplicate side effects.

#### Acceptance Criteria

1. THE Interactive_Session_Manager SHALL apply a configurable Start Hard_Deadline with a default of 10000 milliseconds and an allowed range of 100 through 120000 milliseconds.
2. THE Interactive_Session_Manager SHALL support an optional Idle_Timeout disabled by default and configurable from 1000 milliseconds through 86400000 milliseconds.
3. THE Interactive_Session_Manager SHALL support an optional Lifetime_Timeout disabled by default and configurable from 1000 milliseconds through 604800000 milliseconds.
4. WHEN accepted input or process output occurs, THE Session_Registry SHALL update the activity time used by Idle_Timeout.
5. WHEN Idle_Timeout elapses, THE Cleanup_Coordinator SHALL close the Interactive_Session with Termination_Reason `idle-timeout`.
6. WHEN Lifetime_Timeout elapses, THE Cleanup_Coordinator SHALL close the Interactive_Session with Termination_Reason `lifetime-timeout`.
7. IF a transient launch failure occurs before spawn confirmation and no process side effect can have occurred, THEN THE Interactive_Session_Manager SHALL perform at most one automatic Start retry.
8. IF spawn confirmation occurred, THEN THE Interactive_Session_Manager SHALL perform zero automatic Start retries.
9. WHEN an operation fails after process launch, THE Interactive_Session_Manager SHALL include the current Session_State and a retryability value in the Stable_Error.
10. THE Interactive_Session_Manager SHALL perform no unconditional retry for any Session_Operation.

### Requirement 11: Cleanup and Race Safety

**User Story:** As an operator, I want deterministic cleanup, so that interactive processes and descendants do not survive their owning context.

#### Acceptance Criteria

1. WHEN Close is requested for a live Interactive_Session, THE Cleanup_Coordinator SHALL move Session_State to `closing` before sending a termination action.
2. WHEN Close is requested, THE Cleanup_Coordinator SHALL request graceful Process_Tree termination for a configurable period with a default of 2000 milliseconds and an allowed range of 0 through 30000 milliseconds.
3. IF the Process_Tree remains alive after the graceful period, THEN THE Cleanup_Coordinator SHALL request forceful Process_Tree termination.
4. WHEN termination actions complete, THE Cleanup_Coordinator SHALL verify process absence or Process_Identity mismatch before returning successful Close.
5. IF any verified descendant remains alive after the Close Hard_Deadline, THEN THE Cleanup_Coordinator SHALL return a `CLEANUP_FAILED` Stable_Error naming no secret command content.
6. WHEN explicit Close, process exit, Owner_Cancellation, Idle_Timeout, Lifetime_Timeout, Conversation teardown, or application shutdown occurs, THE Cleanup_Coordinator SHALL release process, terminal, timer, listener, writer, queue, and registry resources owned by the Interactive_Session.
7. WHEN Conversation teardown occurs, THE Cleanup_Coordinator SHALL close every live Interactive_Session owned by the Conversation.
8. WHEN application shutdown occurs, THE Cleanup_Coordinator SHALL close every live Interactive_Session before shutdown completion or report cleanup failure through the shutdown result.
9. WHEN application startup finds an incomplete prior Interactive_Session record, THE Cleanup_Coordinator SHALL use Process_Identity before terminating a matching orphan Process_Tree or marking the record terminal.
10. WHEN Close races with process exit, Owner_Cancellation, timeout, Conversation teardown, or application shutdown, THE Cleanup_Coordinator SHALL execute terminal cleanup once and return one terminal Session_State.
11. WHEN Close targets a terminal Interactive_Session, THE Interactive_Session_Manager SHALL return the recorded terminal result without signaling a process.
12. WHEN cleanup completes, THE Cleanup_Coordinator SHALL close input and output resources after final captured output reaches the Output_Store.
13. BEFORE a Conversation owner identifier is rebound, replaced, restored from history, reset, or disposed, THE application lifecycle SHALL synchronously fence that owner against new Session_Operations, begin one tracked asynchronous close of every owned live Interactive_Session, and prevent the old owner from becoming reachable through the new Conversation context.

### Requirement 12: Artifacts, Errors, and Observability

**User Story:** As a maintainer, I want stable errors and redacted diagnostics, so that failures can be understood without exposing protected data.

#### Acceptance Criteria

1. THE Interactive_Session_Manager SHALL use Stable_Error codes from `INVALID_REQUEST`, `INVALID_CONFIGURATION`, `SESSION_NOT_FOUND`, `LIMIT_REACHED`, `PTY_UNAVAILABLE`, `SESSION_NOT_RUNNING`, `SESSION_CLOSING`, `INPUT_CLOSED`, `INPUT_REJECTED`, `INPUT_DELIVERY_UNKNOWN`, `UNSUPPORTED_CONTROL`, `UNSUPPORTED_OPERATION`, `BACKPRESSURE`, `DEADLINE_EXCEEDED`, `CANCELLED`, `OUTPUT_GAP`, `LAUNCH_FAILED`, `PERSIST_FAILED`, or `CLEANUP_FAILED`.
2. WHEN a Stable_Error is returned, THE Interactive_Session_Manager SHALL include an actionable message, retryability value, Session_Operation, and Session_ID when allocation occurred.
3. THE Output_Store SHALL create Artifact directories with owner-only access and Artifact files with owner-read/write access on platforms that provide file permission controls.
4. THE Output_Store SHALL use bounded, streaming redaction before Artifact bytes become durable.
5. WHEN Artifact rotation occurs, THE Output_Store SHALL preserve ordered chunk metadata, total bytes, dropped bytes, redaction status, and integrity digest.
6. WHEN a Session_Operation completes, THE Telemetry_Recorder SHALL emit operation name, redacted Session_ID, duration, result code, Session_State, input byte count, output byte count, queue depth, retry count, and Termination_Reason when applicable.
7. THE Telemetry_Recorder SHALL exclude raw input, raw output, Sensitive_Data, unredacted commands, environment values, and Artifact content.
8. WHEN Start fails after resource allocation, THE Telemetry_Recorder SHALL record whether cleanup verification succeeded.
9. WHEN output or diagnostics are truncated, THE Interactive_Session_Manager SHALL report omitted byte counts and the redacted Artifact reference.

### Requirement 13: Existing Behavior Compatibility

**User Story:** As an existing clai user, I want interactive sessions added without changing current shell and job behavior, so that established workflows remain regression-safe.

#### Acceptance Criteria

1. THE Compatibility_Layer SHALL preserve existing `shell.exec`, `shell.start`, `shell.jobs`, `shell.tail`, and `shell.stop` public argument and result contracts.
2. THE Compatibility_Layer SHALL preserve existing one-shot output head/tail bounds, redacted Artifact capture, timeout handling, cancellation handling, process-tree termination, and launch-only retry behavior.
3. THE Compatibility_Layer SHALL preserve the existing detached-job rule that accepts at most one stdin payload and closes detached-job stdin after the payload.
4. THE Interactive_Session_Manager SHALL keep Interactive_Session records separate from detached background-job records unless a future specification defines migration.
5. WHEN an existing shell or background operation runs, THE Compatibility_Layer SHALL avoid allocating a PTY solely because interactive-session support is installed.
6. THE Policy_Engine SHALL apply the same or stricter Risk_Decision to a command started as an Interactive_Session compared with the same command started through the existing shell boundary.
7. THE Interactive_Session_Manager SHALL use additive tool definitions without changing existing tool names.
8. WHEN feature capability is unavailable, THE Compatibility_Layer SHALL continue serving existing shell and background operations.

### Requirement 14: Verification and Regression Coverage

**User Story:** As a maintainer, I want failure-boundary tests for interactive sessions, so that lifecycle, security, and platform regressions are detected before release.

#### Acceptance Criteria

1. THE Test_Suite SHALL verify Start, Send, Read, Status, List, Resize, and Close with a deterministic interactive fixture.
2. THE Test_Suite SHALL verify a Python REPL round trip on each Supported_Platform where Python is available and skip with an explicit capability reason where Python is unavailable.
3. THE Test_Suite SHALL verify PTY-required failure and PTY-preferred Pipe_Transport fallback without spawning duplicate processes.
4. THE Test_Suite SHALL verify Input_Sequence ordering under at least 100 concurrent Send requests to one Interactive_Session.
5. THE Test_Suite SHALL verify Cursor continuity, delayed output, unsolicited output, page boundaries, UTF-8 boundaries, output eviction, and `OUTPUT_GAP` metadata.
6. THE Test_Suite SHALL verify Quiet_Interval and Hard_Deadline boundaries using controlled clocks and deterministic output schedules.
7. THE Test_Suite SHALL verify Text_Input, each Control_Input, EOF_Input, resize, ANSI_Control_Sequence neutralization, carriage return behavior, and non-UTF-8 output handling.
8. THE Test_Suite SHALL verify `safe`, `confirm`, and `block` Risk_Decision paths for later input.
9. THE Test_Suite SHALL verify that Sensitive_Data is absent from registry files, Artifacts, telemetry, transcripts, confirmation previews, command displays, and Stable_Error messages.
10. THE Test_Suite SHALL verify Live_Session_Limit, Backpressure_Limit, output limits, Idle_Timeout, Lifetime_Timeout, and invalid configuration boundaries.
11. THE Test_Suite SHALL verify Close races with process exit, Owner_Cancellation, timeout, Conversation teardown, and application shutdown, and SHALL separately verify that Operation_Cancellation does not close a live session.
12. THE Test_Suite SHALL verify parent, child, and grandchild termination with port or heartbeat evidence on macOS, Linux, and Windows CI targets.
13. THE Test_Suite SHALL verify Process_Identity protection against process identifier reuse during cleanup and startup reconciliation.
14. THE Test_Suite SHALL verify that automatic retry occurs at most once before spawn confirmation and zero times after spawn confirmation or input delivery.
15. THE Test_Suite SHALL run the existing shell, job, safety, artifact, cancellation, and process-tree regression suites without changed expected behavior.
16. THE Test_Suite SHALL use deterministic fixtures instead of requiring Mimikatz, Metasploit, or another external security tool in automated tests.
17. THE Test_Suite SHALL treat Acceptance Criteria 14.1 through 14.16 and every Correctness Property as mandatory release gates; only explicitly capability-dependent cases may skip, and each skip SHALL record the unavailable capability while the required fallback behavior still passes.

### Requirement 15: Explicit Non-Goals

**User Story:** As a product owner, I want clear feature boundaries, so that persistent sessions do not expand into uncontrolled terminal access.

#### Acceptance Criteria

1. THE Interactive_Session_Manager SHALL exclude direct user keyboard passthrough to a child process.
2. THE Interactive_Session_Manager SHALL exclude transfer of the host controlling terminal to a child process.
3. THE Interactive_Session_Manager SHALL exclude graphical application interaction.
4. THE Interactive_Session_Manager SHALL exclude reattachment to a live Interactive_Session after application restart.
5. THE Interactive_Session_Manager SHALL exclude complete terminal screen emulation and pixel-equivalent rendering.
6. THE Interactive_Session_Manager SHALL exclude bypasses for Policy_Engine confirmation, scope, redaction, cancellation, limits, or cleanup controls.
7. THE Interactive_Session_Manager SHALL exclude automatic command rewriting after launch or input failure.
