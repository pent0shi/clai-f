import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, truncateSync, openSync, closeSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandMentions } from "../src/ui/mentions.js";
import { resolveTurnInput } from "../src/attachments/service.js";

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "clai-attach-"));
  dirs.push(dir);
  return dir;
}

describe("text attachment bounds (LIFE-007)", () => {
  it("reads only the cap even for a very large file", () => {
    const dir = workspace();
    const path = join(dir, "huge.log");
    // Sparse file: 512 MiB apparent size, no data blocks.
    const handle = openSync(path, "w");
    closeSync(handle);
    writeFileSync(path, "head-marker\n");
    truncateSync(path, 512 * 1024 * 1024);

    const startedAt = Date.now();
    const result = expandMentions(`look at @${path}`, dir, false);
    const elapsed = Date.now() - startedAt;
    const attachment = result.attachments.find((item) => item.kind === "text");

    expect(attachment?.truncated).toBe(true);
    expect(attachment?.content?.startsWith("head-marker")).toBe(true);
    expect(attachment?.content?.length).toBeLessThanOrEqual(64 * 1024);
    // Reading 512 MiB into memory would dominate this budget.
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe("image validation before model switch (LIFE-008)", () => {
  it("rejects a file whose extension lies about its bytes", () => {
    const dir = workspace();
    const path = join(dir, "fake.png");
    writeFileSync(path, "this is definitely not a png payload");

    const expansion = expandMentions(`check @${path}`, dir, false);
    const image = expansion.attachments.find((item) => item.kind === "image");
    expect(image?.sendable).toBe(false);
    expect(image?.note).toMatch(/not a supported image/i);
  });

  it("keeps the current model when no image can be attached", () => {
    const dir = workspace();
    const path = join(dir, "fake.jpg");
    writeFileSync(path, "still not an image");

    const resolved = resolveTurnInput({
      prompt: `describe @${path}`,
      mode: "ask",
      provider: "openai",
      model: "gpt-4o-mini",
      baseDir: dir,
    });

    expect(resolved.images).toHaveLength(0);
    expect(resolved.model).toBe("gpt-4o-mini");
  });

  it("accepts a real PNG and can attach it", () => {
    const dir = workspace();
    const path = join(dir, "real.png");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(path, png);

    const expansion = expandMentions(`check @${path}`, dir, true);
    const image = expansion.attachments.find((item) => item.kind === "image");
    expect(image?.sendable).toBe(true);
  });
});
