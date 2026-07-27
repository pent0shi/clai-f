import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  InteractiveSessionManager,
  type ConfirmPreview,
} from "../../src/interactive-session/manager.js";
import { OutputStore } from "../../src/interactive-session/output-store.js";
import { RecoveryJournal } from "../../src/interactive-session/recovery-journal.js";
import { SessionTelemetry } from "../../src/interactive-session/telemetry.js";
import type { SessionTransportFactory } from "../../src/interactive-session/transport.js";
import {
  SessionErrorException,
  isTerminalState,
  type StableError,
} from "../../src/interactive-session/types.js";
import {
  FakeTransportFactory,
  MemorySink,
  tempArtifactDir,
} from "./helpers.js";

const OWNER = "safety-order-owner";
const SECRET = "safety-order-canary-7f2d";
const CONFIRM_INPUT = "sed -i s/a/b/ safety-order-file";
const BLOCKED_INPUT = "rm -rf /";

type Operation =
  | "start"
  | "send"
  | "cancel-send"
  | "read-cancel"
  | "emit"
  | "resize"
  | "close"
  | "exit"
  | "cancel-owner"
  | "teardown"
  | "shutdown";

const operationArbitrary = fc.array(
  fc.constantFrom<Operation>(
    "start",
    "send",
    "cancel-send",
    "read-cancel",
    "emit",
    "resize",
    "close",
    "exit",
    "cancel-owner",
    "teardown",
    "shutdown",
  ),
  { minLength: 1, maxLength: 16 },
);

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stableOf(error: unknown): StableError {
  if (error instanceof SessionErrorException) return error.stable;
  throw error;
}

async function rejectedCode(run: () => Promise<unknown>): Promise<StableError["code"]> {
  try {
    await run();
  } catch (error) {
    return stableOf(error).code;
  }
  throw new Error("expected operation rejection");
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function cancelledSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

// Feature: interactive-terminal-sessions, Property 25: Safety controls cannot be bypassed by operation order
describe("Property 25: safety controls cannot be bypassed by operation order", () => {
  it("preserves policy, redaction, limits, and cleanup invariants across generated sequences", async () => {
    await fc.assert(
      fc.asyncProperty(
        operationArbitrary,
        fc.array(fc.integer({ min: 1, max: 11 }), { minLength: 1, maxLength: 8 }),
        async (operations, chunkSizes) => {
          const events: string[] = [];
          const innerFactory = new FakeTransportFactory({
            ptyAvailable: true,
            transportOptions: { beforeWrite: async () => events.push("delivery") },
          });
          const transports: SessionTransportFactory = {
            capability: (platform) => innerFactory.capability(platform),
            startPipe: async (request) => {
              events.push("launch");
              return await innerFactory.startPipe(request);
            },
            startPty: async (request) => {
              events.push("launch");
              return await innerFactory.startPty(request);
            },
          };
          const dir = tempArtifactDir();
          dirs.push(dir);
          const manager = new InteractiveSessionManager({
            transports,
            artifactBaseDir: dir,
            journal: new RecoveryJournal(join(dir, "journal")),
            telemetry: new SessionTelemetry(async () => undefined),
            config: { liveSessionLimit: 1, queuedInputBytes: 1_024 },
          });
          const allocated: string[] = [];
          let acceptedSequence = 0;

          const confirm = (approved: boolean, label: string): ConfirmPreview => async () => {
            events.push(label);
            return approved;
          };
          const liveSession = () =>
            manager.list({ ownerId: OWNER }).sessions.find((session) => session.state === "running");

          // Declined policy decisions cannot reserve a slot or launch.
          expect(
            await rejectedCode(() =>
              manager.start({
                ownerId: OWNER,
                command: CONFIRM_INPUT,
                terminalMode: "required",
                confirm: confirm(false, "start-policy-declined"),
              }),
            ),
          ).toBe("INPUT_REJECTED");
          expect(events).toEqual(["start-policy-declined"]);
          expect(innerFactory.launches).toBe(0);
          expect(manager.list({ ownerId: OWNER }).sessions).toHaveLength(0);

          const started = await manager.start({
            ownerId: OWNER,
            command: CONFIRM_INPUT,
            terminalMode: "required",
            confirm: confirm(true, "start-policy"),
          });
          allocated.push(started.sessionId);
          expect(events.indexOf("start-policy")).toBeLessThan(events.indexOf("launch"));

          // A live-limit rejection performs policy but allocates and launches nothing.
          const launchesAtLimit = innerFactory.launches;
          expect(
            await rejectedCode(() =>
              manager.start({
                ownerId: OWNER,
                command: CONFIRM_INPUT,
                terminalMode: "required",
                confirm: confirm(true, "limit-policy"),
              }),
            ),
          ).toBe("LIMIT_REACHED");
          expect(innerFactory.launches).toBe(launchesAtLimit);
          expect(manager.list({ ownerId: OWNER }).sessions).toHaveLength(1);

          const transport = innerFactory.last();
          const writesBeforeDecline = transport.writes.length;
          expect(
            await rejectedCode(() =>
              manager.send({
                ownerId: OWNER,
                id: started.sessionId,
                input: { kind: "text", text: CONFIRM_INPUT, submit: "enter" },
                confirm: confirm(false, "send-policy-declined"),
              }),
            ),
          ).toBe("INPUT_REJECTED");
          expect(transport.writes).toHaveLength(writesBeforeDecline);

          expect(
            await rejectedCode(() =>
              manager.send({
                ownerId: OWNER,
                id: started.sessionId,
                input: { kind: "text", text: BLOCKED_INPUT, submit: "enter" },
                confirm: confirm(true, "blocked-confirm-must-not-run"),
              }),
            ),
          ).toBe("INPUT_REJECTED");
          expect(events).not.toContain("blocked-confirm-must-not-run");
          expect(transport.writes).toHaveLength(writesBeforeDecline);

          expect(
            await rejectedCode(() =>
              manager.send({
                ownerId: OWNER,
                id: started.sessionId,
                input: { kind: "text", text: "x".repeat(2_000), submit: "none" },
                confirm: confirm(true, "backpressure-policy"),
              }),
            ),
          ).toBe("BACKPRESSURE");
          expect(transport.writes).toHaveLength(writesBeforeDecline);

          const policyIndex = events.length;
          const accepted = await manager.send({
            ownerId: OWNER,
            id: started.sessionId,
            input: { kind: "text", text: CONFIRM_INPUT, submit: "enter" },
            confirm: confirm(true, "send-policy"),
            signal: cancelledSignal(),
          });
          acceptedSequence = accepted.inputSequence;
          expect(acceptedSequence).toBe(1);
          expect(events.indexOf("send-policy", policyIndex)).toBeLessThan(
            events.indexOf("delivery", policyIndex),
          );

          for (const operation of operations) {
            const live = liveSession();
            if (operation === "start") {
              const launchesBefore = innerFactory.launches;
              try {
                const result = await manager.start({
                  ownerId: OWNER,
                  command: CONFIRM_INPUT,
                  terminalMode: "required",
                  confirm: confirm(true, "generated-start-policy"),
                });
                allocated.push(result.sessionId);
                acceptedSequence = 0;
                expect(innerFactory.launches).toBe(launchesBefore + 1);
              } catch (error) {
                expect(["LIMIT_REACHED", "SESSION_CLOSING"]).toContain(stableOf(error).code);
                expect(innerFactory.launches).toBe(launchesBefore);
              }
              continue;
            }
            if (!live) continue;
            const id = live.id;
            const activeTransport = innerFactory.transports[allocated.indexOf(id)]!;

            if (operation === "send" || operation === "cancel-send") {
              const result = await manager.send({
                ownerId: OWNER,
                id,
                input: { kind: "text", text: "echo ordered", submit: "enter" },
                confirm: confirm(true, "generated-send-policy"),
                signal: cancelledSignal(),
              });
              acceptedSequence += 1;
              expect(result.inputSequence).toBe(acceptedSequence);
              expect(result.error?.code).toBe("CANCELLED");
              expect(manager.status({ ownerId: OWNER, id }).session.state).toBe("running");
            } else if (operation === "read-cancel") {
              const cursor = manager.status({ ownerId: OWNER, id }).session.latestCursor;
              const result = await manager.read({
                ownerId: OWNER,
                id,
                cursor,
                waitMs: 1_000,
                signal: cancelledSignal(),
              });
              expect(result.error?.code).toBe("CANCELLED");
              expect(manager.status({ ownerId: OWNER, id }).session.state).toBe("running");
            } else if (operation === "emit") {
              activeTransport.emit(`safe-${operations.length}`);
            } else if (operation === "resize") {
              await manager.resize({ ownerId: OWNER, id, columns: 90, rows: 30 });
            } else if (operation === "close") {
              await manager.close({ ownerId: OWNER, id });
            } else if (operation === "exit") {
              activeTransport.emitExit();
              await flushMicrotasks();
            } else if (operation === "cancel-owner") {
              await manager.cancelOwner(OWNER);
            } else if (operation === "teardown") {
              await manager.beginCloseOwner(OWNER);
            } else {
              await manager.closeAll();
            }
          }

          await manager.closeAll();
          for (let index = 0; index < allocated.length; index += 1) {
            const id = allocated[index]!;
            expect(isTerminalState(manager.status({ ownerId: OWNER, id }).session.state)).toBe(true);
            expect(innerFactory.transports[index]!.disposed).toBe(1);
            await manager.close({ ownerId: OWNER, id });
            expect(innerFactory.transports[index]!.disposed).toBe(1);
          }

          const sink = new MemorySink();
          const output = new OutputStore({
            memoryWindowBytes: 65_536,
            pageBytes: 65_536,
            redactionOverlapBytes: 4_096,
            sink,
          });
          output.registerExactSecret(SECRET);
          const raw = new Uint8Array(Buffer.from(`before:${SECRET}:after`, "utf8"));
          let offset = 0;
          let chunk = 0;
          while (offset < raw.length) {
            const size = chunkSizes[chunk % chunkSizes.length]!;
            output.ingest("stdout", raw.subarray(offset, offset + size), chunk);
            offset += size;
            chunk += 1;
          }
          output.finish();
          const persisted = Buffer.from(sink.bytes()).toString("utf8");
          expect(persisted).not.toContain(SECRET);
          for (const view of ["plain", "encoded"] as const) {
            const page = output.page({
              cursor: 0,
              view,
              operation: "read",
              sessionId: "safety-order",
            }).page;
            const presented = page.events.map((event) => event.content).join("");
            expect(presented).not.toContain(SECRET);
            if (view === "encoded") {
              expect(Buffer.from(presented, "base64").toString("utf8")).not.toContain(SECRET);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 30_000);
});
