import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wordlistFind } from "../src/tools/wordlists.js";

let originalHome: string | undefined;
let homeDir: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  homeDir = mkdtempSync(join(tmpdir(), "clai-wordlist-home-"));
  process.env.HOME = homeDir;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(homeDir, { recursive: true, force: true });
});

function seed(relDir: string, filename: string, body = "admin\nlogin\n"): string {
  const dir = join(homeDir, relDir);
  mkdirSync(dir, { recursive: true });
  const full = join(dir, filename);
  writeFileSync(full, body);
  return full;
}

describe("wordlist.find", () => {
  it("finds a wordlist in a known per-OS location without touching /usr/share blindly", async () => {
    seed(join("SecLists", "Discovery", "Web-Content"), "common.txt");

    const result = await wordlistFind({ query: "common.txt" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("common.txt");
  }, 30_000);

  it("resolves a known alias like rockyou to its real filename", async () => {
    seed("wordlists", "rockyou.txt", "password\n123456\n");

    const result = await wordlistFind({ query: "rockyou" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("rockyou.txt");
  }, 30_000);

  it("resolves a multi-word natural-language query to the right file (the reported bug)", async () => {
    // Model sends "directory common medium" — must still find the files.
    seed(join("SecLists", "Discovery", "Web-Content"), "directory-list-2.3-medium.txt");

    const result = await wordlistFind({ query: "directory common medium" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("directory-list-2.3-medium.txt");
  }, 30_000);

  it("matches on a keyword substring (medium -> directory-list-2.3-medium.txt)", async () => {
    seed("wordlists", "directory-list-2.3-medium.txt");

    const result = await wordlistFind({ query: "medium directory wordlist for fuzzing" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("directory-list-2.3-medium.txt");
  }, 30_000);

  it("matches case-insensitively and ignores noise words", async () => {
    seed("wordlists", "Common.TXT");

    const result = await wordlistFind({ query: "the COMMON wordlist please" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Common.TXT");
  }, 30_000);

  it("finds password lists by intent keyword (passwords -> rockyou)", async () => {
    seed(join("SecLists", "Passwords"), "rockyou.txt", "password\n");

    const result = await wordlistFind({ query: "password list" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("rockyou.txt");
  }, 30_000);

  it("keeps a short web-content query away from password and username lists", async () => {
    seed("wordlists", "top-usernames-shortlist.txt", "admin\n");
    seed(join("SecLists", "Discovery", "Web-Content"), "common.txt", "admin\nlogin\n");
    seed(join("SecLists", "Discovery", "Web-Content"), "directory-list-2.3-small.txt", "x\n".repeat(1_000));

    const result = await wordlistFind({ query: "short web content" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Recommended first match");
    expect(result.output).toContain("common.txt");
    expect(result.output).not.toContain("top-usernames-shortlist.txt");
  }, 30_000);

  it("fails cleanly (no throw, no noisy stderr) when nothing is found and expand=false", async () => {
    const result = await wordlistFind({
      query: "zzqxwordlistdoesnotexistxyzzy",
      expand: false,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("No match");
  }, 30_000);

  it("requires a query", async () => {
    const result = await wordlistFind({ query: "" });
    expect(result.ok).toBe(false);
  });
});
