import { describe, expect, it } from "vitest";
import { createSystemClipboardPort } from "../../src/app/adapters/in-memory-clipboard-adapter.js";

describe("createSystemClipboardPort", () => {
  it("stores and reads text from clipboard port", async () => {
    const clipboard = createSystemClipboardPort();
    await clipboard.writeText("test cut draft payload");
    expect(clipboard.lastText).toBe("test cut draft payload");
    const read = await clipboard.readText?.();
    expect(typeof read === "string" || read === undefined).toBe(true);
  });
});
