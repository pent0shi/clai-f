import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { makeStore, MemorySink } from "./helpers.js";
import type { OutputStream } from "../../src/interactive-session/types.js";

const asciiBytes = fc.array(fc.integer({ min: 0x20, max: 0x7e }), {
  minLength: 1,
  maxLength: 200,
});

function decodePage(events: readonly { content: string }[]): Uint8Array {
  return new Uint8Array(
    events.flatMap((event) => [...Buffer.from(event.content, "base64")]),
  );
}

// Feature: interactive-terminal-sessions, Property 7: Cursor assignment preserves observation order
describe("Property 7: cursor assignment preserves observation order", () => {
  it("assigns contiguous monotonic ranges in callback order and keeps stream identity", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom<OutputStream>("stdout", "stderr"),
            // Alphabet chosen so no chunk ends inside a secret-pattern prefix,
            // which would legitimately hold bytes back as redaction overlap.
            fc
              .array(fc.constantFrom("x", "y", "z", "0", " "), { minLength: 1, maxLength: 20 })
              .map((chars) => chars.join("")),
          ),
          { minLength: 1, maxLength: 40 },
        ),
        (chunks) => {
          const { store } = makeStore();
          for (const [stream, text] of chunks) {
            store.ingest(stream, new Uint8Array(Buffer.from(text, "utf8")), 0);
          }
          const page = store.page({
            cursor: 0,
            view: "encoded",
            operation: "read",
            sessionId: "s",
            maxBytes: 1_048_576,
          });
          expect(page.ok).toBe(true);
          let expected = 0;
          for (const [index, event] of page.page.events.entries()) {
            expect(event.startCursor).toBe(expected);
            expect(event.endCursor).toBeGreaterThan(event.startCursor);
            expected = event.endCursor;
            expect(event.stream).toBe(chunks[index]![0]);
          }
          expect(expected).toBe(store.latestCursor);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("labels pty output as a single terminal stream", () => {
    const { store } = makeStore();
    store.ingest("terminal", new Uint8Array(Buffer.from("hi", "utf8")), 0);
    const page = store.page({ cursor: 0, view: "plain", operation: "read", sessionId: "s" });
    expect(page.page.events[0]?.stream).toBe("terminal");
  });
});

// Feature: interactive-terminal-sessions, Property 8: Cursor pagination is gap-free within retention
describe("Property 8: cursor pagination is gap-free within retention", () => {
  it("reconstructs every retained byte exactly once across repeated pages", () => {
    fc.assert(
      fc.property(
        fc.array(asciiBytes, { minLength: 1, maxLength: 20 }),
        fc.integer({ min: 1, max: 64 }),
        (chunks, pageBytes) => {
          const sink = new MemorySink();
          const { store } = makeStore({ sink });
          for (const chunk of chunks) {
            store.ingest("stdout", new Uint8Array(chunk), 0);
          }
          const collected: number[] = [];
          let cursor = 0;
          let guard = 0;
          for (;;) {
            const outcome = store.page({
              cursor,
              view: "encoded",
              maxBytes: pageBytes,
              operation: "read",
              sessionId: "s",
            });
            expect(outcome.ok).toBe(true);
            const page = outcome.page;
            expect(page.requestedCursor).toBe(cursor);
            collected.push(...decodePage(page.events));
            expect(page.hasMore).toBe(page.nextCursor < store.latestCursor);
            if (!page.hasMore) break;
            expect(page.nextCursor).toBeGreaterThan(cursor);
            cursor = page.nextCursor;
            expect(++guard).toBeLessThan(10_000);
          }
          expect(new Uint8Array(collected)).toEqual(sink.bytes());
        },
      ),
      { numRuns: 100 },
    );
  });

  it("bounds each page by its visible byte limit and retains the remainder", () => {
    const { store } = makeStore({ pageBytes: 8 });
    store.ingest("stdout", new Uint8Array(Buffer.from("0123456789", "utf8")), 0);
    const first = store.page({ cursor: 0, view: "plain", operation: "read", sessionId: "s" });
    expect(first.page.nextCursor).toBe(8);
    expect(first.page.hasMore).toBe(true);
    const second = store.page({
      cursor: first.page.nextCursor,
      view: "plain",
      operation: "read",
      sessionId: "s",
    });
    expect(second.page.events[0]?.content).toBe("89");
    expect(second.page.hasMore).toBe(false);
  });
});

// Feature: interactive-terminal-sessions, Property 9: Output retention remains bounded and reports eviction
describe("Property 9: output retention remains bounded and reports eviction", () => {
  it("bounds retention, only advances the earliest cursor, and reports OUTPUT_GAP", () => {
    fc.assert(
      fc.property(
        fc.array(asciiBytes, { minLength: 20, maxLength: 60 }),
        (chunks) => {
          const { store } = makeStore({ memoryWindowBytes: 128 });
          let earliest = 0;
          for (const chunk of chunks) {
            store.ingest("stdout", new Uint8Array(chunk), 0);
            expect(store.earliestCursor).toBeGreaterThanOrEqual(earliest);
            earliest = store.earliestCursor;
            const retained = store.latestCursor - store.earliestCursor;
            expect(retained).toBeLessThanOrEqual(128);
          }
          if (store.earliestCursor === 0) return;
          const outcome = store.page({
            cursor: 0,
            view: "plain",
            operation: "read",
            sessionId: "s",
          });
          expect(outcome.ok).toBe(false);
          if (outcome.ok) return;
          expect(outcome.error.code).toBe("OUTPUT_GAP");
          expect(outcome.error.details?.earliestAvailableCursor).toBe(store.earliestCursor);
          expect(outcome.error.details?.omittedBytes).toBe(store.earliestCursor);
          expect(outcome.error.details?.artifactPath).toBe(store.artifact.path);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: interactive-terminal-sessions, Property 10: Binary and text boundaries preserve safe source data
describe("Property 10: binary and text boundaries preserve safe source data", () => {
  it("round-trips arbitrary bytes through the encoded view", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 300 }),
        fc.integer({ min: 1, max: 40 }),
        (bytes, chunkSize) => {
          const sink = new MemorySink();
          const { store } = makeStore({ sink });
          for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            store.ingest(
              "stdout",
              new Uint8Array(bytes.slice(offset, offset + chunkSize)),
              0,
            );
          }
          store.finish();
          const page = store.page({
            cursor: 0,
            view: "encoded",
            maxBytes: 1_048_576,
            operation: "read",
            sessionId: "s",
          });
          expect(decodePage(page.page.events)).toEqual(sink.bytes());
        },
      ),
      { numRuns: 100 },
    );
  });

  it("never ends a plain page inside a multi-byte code point", () => {
    const { store } = makeStore();
    store.ingest("stdout", new Uint8Array(Buffer.from("héllo wörld", "utf8")), 0);
    for (let limit = 1; limit <= 14; limit += 1) {
      const page = store.page({
        cursor: 0,
        view: "plain",
        maxBytes: limit,
        operation: "read",
        sessionId: "s",
      });
      const text = page.page.events.map((event) => event.content).join("");
      expect(text).not.toContain("\uFFFD");
    }
  });

  it("marks lossy plain decoding of invalid UTF-8 while preserving bytes", () => {
    const sink = new MemorySink();
    const { store } = makeStore({ sink });
    store.ingest("stdout", new Uint8Array([0xff, 0xfe, 0x41]), 0);
    store.finish();
    const plain = store.page({ cursor: 0, view: "plain", operation: "read", sessionId: "s" });
    expect(plain.page.decodingLoss).toBe(true);
    const encoded = store.page({
      cursor: 0,
      view: "encoded",
      operation: "read",
      sessionId: "s",
    });
    expect(decodePage(encoded.page.events)).toEqual(sink.bytes());
  });
});
