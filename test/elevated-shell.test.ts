import { afterEach, describe, expect, it } from "vitest";
import {
  extractSimpleSudoCommand,
  formatSudoStdinPassword,
  preparePrivilegedBackgroundArgv,
  tryRunElevatedWithoutTty,
} from "../src/tools/elevated-shell.js";
import {
  getAllowInteractiveStdinInherit,
  setAllowInteractiveStdinInherit,
} from "../src/tools/shell.js";

describe("extractSimpleSudoCommand", () => {
  it("extracts simple sudo forms", () => {
    expect(extractSimpleSudoCommand("sudo whoami")).toEqual({
      inner: "whoami",
    });
    expect(extractSimpleSudoCommand("sudo apt install -y nmap")).toEqual({
      inner: "apt install -y nmap",
    });
  });

  it("rejects non-interactive and non-leading sudo", () => {
    expect(extractSimpleSudoCommand("sudo -n whoami")).toBeUndefined();
    expect(extractSimpleSudoCommand("sudo -S whoami")).toBeUndefined();
    expect(extractSimpleSudoCommand("ls | sudo tee /etc/x")).toBeUndefined();
    expect(extractSimpleSudoCommand("nmap -sV host")).toBeUndefined();
  });
});

describe("formatSudoStdinPassword", () => {
  it("strips trailing newlines but keeps spaces and ends with one newline", () => {
    expect(formatSudoStdinPassword("secret")).toBe("secret\n");
    expect(formatSudoStdinPassword("secret\n")).toBe("secret\n");
    expect(formatSudoStdinPassword("secret\r\n\r\n")).toBe("secret\n");
    expect(formatSudoStdinPassword(" pass word ")).toBe(" pass word \n");
  });
});

describe("preparePrivilegedBackgroundArgv", () => {
  it("authenticates first and returns a shell:false stdin-only sudo spec", async () => {
    const secret = "background-sudo-secret";
    const authInputs: string[] = [];
    const prepared = await preparePrivilegedBackgroundArgv(
      "nmap",
      ["-sS", "example.com"],
      { requestSecret: async () => secret },
      {
        isRoot: () => false,
        available: async () => true,
        runAuth: async (args) => {
          authInputs.push(args.stdinText ?? "");
          return { ok: true, output: "authenticated", exitCode: 0 };
        },
      },
    );

    expect(authInputs).toEqual([`${secret}\n`]);
    expect(prepared.prepared).toBe(true);
    if (prepared.prepared) {
      expect(prepared.spec).toMatchObject({
        command: "sudo",
        argv: ["-S", "-p", "", "nmap", "-sS", "example.com"],
        stdinText: `${secret}\n`,
      });
      expect(prepared.spec.display).not.toContain(secret);
    }
  });

  it("does not prepare or start after cancellation or failed authentication", async () => {
    const cancelled = await preparePrivilegedBackgroundArgv(
      "nmap",
      ["-sS", "example.com"],
      { requestSecret: async () => undefined },
      { isRoot: () => false, available: async () => true },
    );
    expect(cancelled).toMatchObject({
      prepared: false,
      result: { ok: false, exitCode: 130 },
    });

    const rejected = await preparePrivilegedBackgroundArgv(
      "nmap",
      ["-sS", "example.com"],
      { requestSecret: async () => "wrong" },
      {
        isRoot: () => false,
        available: async () => true,
        runAuth: async () => ({ ok: false, output: "Sorry, try again.", exitCode: 1 }),
      },
    );
    expect(rejected).toMatchObject({
      prepared: false,
      result: { ok: false, exitCode: 1 },
    });
    if (!rejected.prepared) expect(rejected.result.output).toMatch(/no background job was started/i);
  });
});

describe("tryRunElevatedWithoutTty", () => {
  const prev = getAllowInteractiveStdinInherit();
  afterEach(() => {
    setAllowInteractiveStdinInherit(prev);
  });

  it("returns undefined when no secret port", async () => {
    const r = await tryRunElevatedWithoutTty("sudo whoami", {});
    expect(r).toBeUndefined();
  });

  it("returns cancelled when secret modal is dismissed", async () => {
    const r = await tryRunElevatedWithoutTty("sudo whoami", {
      requestSecret: async () => undefined,
    });
    expect(r?.ok).toBe(false);
    expect(r?.exitCode).toBe(130);
    expect(r?.output).toMatch(/cancelled/i);
  });

  it("refuses complex interactive pipelines with a clear message", async () => {
    const r = await tryRunElevatedWithoutTty("ls | sudo tee /etc/hosts", {
      requestSecret: async () => "x",
    });
    expect(r?.ok).toBe(false);
    expect(r?.output).toMatch(/freeze|simple `sudo/i);
  });
});

describe("interactive stdin inherit policy", () => {
  const prev = getAllowInteractiveStdinInherit();
  afterEach(() => {
    setAllowInteractiveStdinInherit(prev);
  });

  it("defaults true and can be disabled for TUI", () => {
    setAllowInteractiveStdinInherit(true);
    expect(getAllowInteractiveStdinInherit()).toBe(true);
    setAllowInteractiveStdinInherit(false);
    expect(getAllowInteractiveStdinInherit()).toBe(false);
  });
});
