import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { SessionRegistry, canTransition } from "../../src/interactive-session/registry.js";
import { MAX_LIST_SUMMARIES } from "../../src/interactive-session/config.js";
import {
  isTerminalState,
  type InteractiveSessionRecord,
  type SessionState,
} from "../../src/interactive-session/types.js";

const STATES: SessionState[] = [
  "starting",
  "running",
  "closing",
  "exited",
  "failed",
  "closed",
];

function record(
  registry: SessionRegistry,
  ownerId: string,
  startedAt: number,
): InteractiveSessionRecord {
  const value: InteractiveSessionRecord = {
    id: registry.mintId(),
    ownerId,
    state: "starting",
    transport: "pipe",
    startedAt,
    lastActivityAt: startedAt,
    artifact: {
      path: "/tmp/a",
      bytes: 0,
      droppedBytes: 0,
      redacted: true,
      chunks: [],
      sha256: "",
    },
    earliestCursor: 0,
    latestCursor: 0,
    inputClosed: false,
  };
  registry.insert(value);
  return value;
}

// Feature: interactive-terminal-sessions, Property 2: Session identity and ownership are non-disclosing
describe("Property 2: session identity and ownership are non-disclosing", () => {
  it("mints unique, non-reused, metadata-independent ids", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 40 }), { minLength: 1, maxLength: 50 }),
        // A distinctive pid: a one-digit pid would appear in any hex uuid by
        // chance, which says nothing about disclosure.
        fc.integer({ min: 100_000, max: 999_999 }),
        (commands, pid) => {
          const registry = new SessionRegistry();
          const ids = commands.map(() => registry.mintId());
          expect(new Set(ids).size).toBe(ids.length);
          for (const id of ids) {
            expect(id.startsWith("its_")).toBe(true);
            expect(id).not.toContain(String(pid));
            for (const command of commands) {
              if (command.length >= 6) expect(id).not.toContain(command);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("never reuses an id after its record is evicted", () => {
    const registry = new SessionRegistry();
    const seen = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      const id = registry.mintId();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it("treats another owner's session exactly like a missing id", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 12 }),
        fc.string({ minLength: 1, maxLength: 12 }),
        (ownerA, ownerB) => {
          fc.pre(ownerA !== ownerB);
          const registry = new SessionRegistry();
          const owned = record(registry, ownerA, 1);
          expect(registry.get(ownerB, owned.id)).toBeUndefined();
          expect(registry.get(ownerB, "its_missing")).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: interactive-terminal-sessions, Property 3: Registry limits, ordering, and state transitions hold
describe("Property 3: registry limits, ordering, and transitions", () => {
  it("only permits declared transitions and freezes the first terminal state", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...STATES),
        fc.constantFrom(...STATES),
        (from, to) => {
          const registry = new SessionRegistry();
          const value = record(registry, "owner", 1);
          value.state = from;
          const allowed = canTransition(from, to);
          expect(registry.transition(value, to)).toBe(allowed);
          expect(value.state).toBe(allowed ? to : from);
          if (isTerminalState(from)) expect(value.state).toBe(from);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("counts only live records against the live limit", () => {
    const registry = new SessionRegistry();
    const first = record(registry, "owner", 1);
    const second = record(registry, "owner", 2);
    expect(registry.liveCount("owner")).toBe(2);
    registry.transition(first, "exited");
    expect(registry.liveCount("owner")).toBe(1);
    registry.transition(second, "running");
    registry.transition(second, "closing");
    expect(registry.liveCount("owner")).toBe(1);
  });

  it("lists live records first, then descending start time, capped at 50", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 1_000 }), fc.boolean()), {
          minLength: 1,
          maxLength: 80,
        }),
        (entries) => {
          const registry = new SessionRegistry();
          for (const [startedAt, terminal] of entries) {
            const value = record(registry, "owner", startedAt);
            if (terminal) registry.transition(value, "failed");
            else registry.transition(value, "running");
          }
          const summaries = registry.list("owner");
          expect(summaries.length).toBeLessThanOrEqual(MAX_LIST_SUMMARIES);
          const live = summaries.filter((summary) => !isTerminalState(summary.state));
          const terminal = summaries.filter((summary) => isTerminalState(summary.state));
          // Live records occupy the prefix, and each group is start-time desc.
          expect(summaries.slice(0, live.length)).toEqual(live);
          for (const group of [live, terminal]) {
            for (let index = 1; index < group.length; index += 1) {
              expect(group[index]!.startedAt).toBeLessThanOrEqual(group[index - 1]!.startedAt);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("keeps every live record while bounding terminal history", () => {
    const registry = new SessionRegistry();
    for (let index = 0; index < 120; index += 1) {
      const value = record(registry, "owner", index);
      registry.transition(value, "exited");
    }
    const live = record(registry, "owner", 1_000);
    registry.transition(live, "running");
    const summaries = registry.list("owner");
    expect(summaries[0]?.id).toBe(live.id);
    expect(registry.liveCount("owner")).toBe(1);
  });

  it("fences an owner so no new session can be reserved for it", () => {
    const registry = new SessionRegistry();
    registry.fenceOwner("owner");
    expect(registry.isFenced("owner")).toBe(true);
    registry.unfenceOwner("owner");
    expect(registry.isFenced("owner")).toBe(false);
  });
});
