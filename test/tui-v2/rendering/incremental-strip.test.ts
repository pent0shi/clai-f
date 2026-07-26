import { describe, expect, it } from "vitest";
import {
  EMPTY_STRIP_STREAM,
  pushStripChunk,
  type StripStream,
} from "../../../src/tui-v2/rendering/incremental-strip.js";
import { stripToolCallSurfaces } from "../../../src/tui-v2/rendering/strip-tool-surfaces.js";
import { asSessionId, asToolCallId, asTurnId } from "../../../src/app/events/app-event.js";
import { createCountingIdFactory, EventSequencer } from "../../../src/app/events/sequencer.js";
import { applyAppEvent } from "../../../src/tui-v2/state/transcript-reducer.js";
import {
  EMPTY_TRANSCRIPT_STATE,
  transcriptItems,
  type AssistantItem,
} from "../../../src/tui-v2/state/transcript-types.js";

function streamAll(chunks: readonly string[]): { text: string; stream: StripStream } {
  let stream = EMPTY_STRIP_STREAM;
  let text = "";
  for (const chunk of chunks) {
    const pushed = pushStripChunk(stream, chunk);
    stream = pushed.stream;
    text = pushed.text;
  }
  return { text, stream };
}

function chunk(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    parts.push(text.slice(index, index + size));
  }
  return parts;
}

function buildSequencer() {
  return new EventSequencer(asSessionId("sess-strip"), createCountingIdFactory("s-"), {
    now: () => 1_700_000_000_000,
  });
}

describe("incremental tool-surface stripping (TUI-003)", () => {
  it("matches a one-shot strip for prose, fences and xml tool surfaces", () => {
    const cases = [
      "Plain prose across\nseveral lines.\n\nAnd a paragraph.",
      "before\n```tool\n{\"name\":\"fs.read\"}\n```\nafter",
      "text <tool_call name=\"x\">{\"a\":1}</tool_call> tail",
      "leading\n\n\n\nblank runs collapse",
      `${"paragraph line\n".repeat(900)}\n\`\`\`tool\n{"name":"fs.write"}\n\`\`\`\ndone`,
    ];
    for (const source of cases) {
      for (const size of [1, 7, 512]) {
        expect(streamAll(chunk(source, size)).text).toBe(stripToolCallSurfaces(source));
      }
    }
  });

  it("keeps the rescanned tail bounded as the message grows", () => {
    const small = streamAll(chunk("word ".repeat(2_000), 64)).stream;
    const large = streamAll(chunk("word ".repeat(64_000), 64)).stream;
    expect(large.rawTail.length).toBeLessThanOrEqual(small.rawTail.length + 4_096);
    expect(large.rawTail.length).toBeLessThan(8_192);
    expect(large.stableText.length).toBeGreaterThan(200_000);
  });

  it("returns to the cheap append path after a fence closes", () => {
    const prose = "word ".repeat(2_000);
    const source = `answer\n\`\`\`tool\n{"name":"fs.read"}\n\`\`\`\n${prose}`;
    const { text, stream } = streamAll(chunk(source, 64));
    expect(text).toBe(stripToolCallSurfaces(source));
    expect(stream.clean).toBe(true);
    expect(stream.rawTail.length).toBeLessThan(8_192);
  });

  it("holds an open fence in the tail until it closes", () => {
    let stream = EMPTY_STRIP_STREAM;
    let pushed = pushStripChunk(stream, "answer\n```tool\n{\"name\":\"fs.");
    expect(pushed.text).toBe("answer\n");
    stream = pushed.stream;
    pushed = pushStripChunk(stream, "read\"}\n```\nall set");
    expect(pushed.text).toBe("answer\n\nall set");
  });

  it("streams a long assistant reply through the reducer without quadratic rework", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    const body = "sentence about the change. ".repeat(4_000);
    for (const part of chunk(body, 40)) {
      state = applyAppEvent(state, seq.build("assistant-delta", { text: part }, turnId));
    }
    const item = transcriptItems(state)[0] as AssistantItem;
    expect(item.text).toBe(stripToolCallSurfaces(body));
    const stream = state.assistantStripStreams.get(state.pendingAssistantId!)!;
    expect(stream.rawTail.length).toBeLessThan(8_192);

    state = applyAppEvent(
      state,
      seq.build("tool-call", { toolCallId: asToolCallId("c1"), name: "fs.read", argsDisplay: "a" }, turnId),
    );
    expect(state.assistantStripStreams.size).toBe(0);
  });
});
