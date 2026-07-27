import { describe, expect, it, vi } from "vitest";
import { shellExec } from "../../src/tools/shell.js";
import { toolRegistry } from "../../src/tools/registry.js";
import { TOOL_DEFINITIONS } from "../../src/tools/definitions.js";
import { INTERACTIVE_SESSION_TOOL_NAMES } from "../../src/tools/interactive-session-tools.js";
import * as transportFactory from "../../src/interactive-session/transport-factory.js";
import * as nodePty from "../../src/interactive-session/transport-node-pty.js";

// Feature: interactive-terminal-sessions, Property 24: Legacy execution never allocates an interactive transport
describe("Property 24: legacy execution never allocates an interactive transport", () => {
  it("runs shell.exec without touching the interactive or PTY factories", async () => {
    const createFactory = vi.spyOn(transportFactory, "createSessionTransportFactory");
    const probe = vi.spyOn(nodePty, "probePtyCapability");
    const startPty = vi.spyOn(nodePty, "startPtyTransport");

    const result = await shellExec({ command: "echo legacy", noArtifact: true });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("legacy");
    expect(createFactory).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(startPty).not.toHaveBeenCalled();

    createFactory.mockRestore();
    probe.mockRestore();
    startPty.mockRestore();
  });

  it("keeps the legacy shell/job tool names and adds the terminal tools additively", () => {
    for (const name of [
      "shell.exec",
      "shell.start",
      "shell.jobs",
      "shell.tail",
      "shell.stop",
    ]) {
      expect(typeof toolRegistry[name]).toBe("function");
      expect(TOOL_DEFINITIONS.some((definition) => definition.name === name)).toBe(true);
    }
    for (const name of INTERACTIVE_SESSION_TOOL_NAMES) {
      expect(typeof toolRegistry[name]).toBe("function");
      expect(TOOL_DEFINITIONS.some((definition) => definition.name === name)).toBe(true);
    }
  });

  it("requires an owning session id instead of defaulting to a shared owner", async () => {
    for (const name of INTERACTIVE_SESSION_TOOL_NAMES) {
      const result = await toolRegistry[name]!({ id: "its_x", cursor: 0, kind: "eof", command: "x", columns: 80, rows: 24 });
      expect(result.ok).toBe(false);
      expect(result.output).toContain("requires an active clai session");
    }
  });
});
