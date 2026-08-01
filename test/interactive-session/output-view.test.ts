import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { neutralizeTerminalControls } from "../../src/interactive-session/output-view.js";
import { makeStore } from "./helpers.js";

const CONTROL_FRAGMENTS = [
  "\u001b[31m",
  "\u001b[0m",
  "\u001b[2J",
  "\u001b[1;1H",
  "\u001b]0;title\u0007",
  "\u001b]8;;http://example.com\u001b\\",
  "\u001bP+q544e\u001b\\",
  "\u001b_privacy\u001b\\",
  "\r",
  "\r\n",
  "\b",
  "\u0000",
  "\u0007",
  "\u009b",
  "plain",
  "text",
];

// Feature: interactive-terminal-sessions, Property 11: Presented output cannot execute terminal controls
describe("Property 11: presented output cannot execute terminal controls", () => {
  it("leaves no executable escape or unsafe control byte in plain output", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...CONTROL_FRAGMENTS), { minLength: 1, maxLength: 30 }),
        (fragments) => {
          const plain = neutralizeTerminalControls(fragments.join(""));
          expect(plain).not.toContain("\u001b");
          expect(plain).not.toContain("\u0000");
          expect(plain).not.toContain("\r");
          expect(plain).not.toContain("\b");
          for (const char of plain) {
            const code = char.codePointAt(0)!;
            const allowed = code === 0x0a || code === 0x09;
            expect(allowed || code >= 0x20).toBe(true);
            expect(code < 0x80 || code > 0x9f).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("is deterministic for identical input bytes", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...CONTROL_FRAGMENTS), { minLength: 1, maxLength: 20 }),
        (fragments) => {
          const text = fragments.join("");
          expect(neutralizeTerminalControls(text)).toBe(neutralizeTerminalControls(text));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("linearizes carriage return and backspace into inert markers", () => {
    expect(neutralizeTerminalControls("50%\r100%\n")).toBe("50%\n100%\n");
    expect(neutralizeTerminalControls("ab\bc")).toBe("ab⌫c");
    expect(neutralizeTerminalControls("done\r\n")).toBe("done\n");
  });

  it("strips SGR and marks OSC and DCS bodies without emitting them", () => {
    expect(neutralizeTerminalControls("\u001b[1;32mok\u001b[0m")).toBe("ok");
    expect(neutralizeTerminalControls("\u001b]0;secret-title\u0007x")).toBe("[osc]x");
    expect(neutralizeTerminalControls("\u001bP+q544e\u001b\\y")).toBe("[dcs]y");
  });

  it("keeps the presented page free of control bytes end to end", () => {
    const { store } = makeStore();
    store.ingest(
      "terminal",
      new Uint8Array(Buffer.from("\u001b[31mred\u001b[0m\u001b]0;t\u0007a\bb\rz\n", "utf8")),
      0,
    );
    const page = store.page({ cursor: 0, view: "plain", operation: "read", sessionId: "s" });
    const text = page.page.events.map((event) => event.content).join("");
    expect(text).toBe("red[osc]a⌫b\nz\n");
  });
});
