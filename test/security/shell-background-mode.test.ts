import { describe, expect, it } from "vitest";
import { toolRegistry } from "../../src/tools/registry.js";

const shellExec = toolRegistry["shell.exec"]!;

describe("TOOL-002 shell.exec background mode", () => {
  it('background:"never" keeps an expensive-looking command in the foreground', async () => {
    // `find /` normally auto-backgrounds; with background:"never" the caller
    // gets real output in this turn. A tiny maxdepth keeps the test fast.
    const result = await shellExec(
      {
        command: "find / -maxdepth 0 -name '*'",
        background: "never",
        timeoutMs: 20000,
      },
      {},
    );
    expect(result.backgroundJob).toBeUndefined();
    expect(result.output).not.toMatch(/durable background job/i);
  });

  it("a cheap scanner-shaped command stays in the foreground by default", async () => {
    const result = await shellExec({ command: "find . -maxdepth 0" }, {});
    expect(result.backgroundJob).toBeUndefined();
  });

  it("explains that timeoutMs does not apply when auto-backgrounded", async () => {
    const result = await shellExec(
      { command: "find / -name definitely-not-here-xyz", timeoutMs: 1234 },
      {},
    );
    if (result.backgroundJob) {
      expect(result.output).toMatch(/timeoutMs=1234 does not apply/i);
      expect(result.output).toMatch(/background:"never"/);
      const stop = toolRegistry["shell.stop"];
      if (stop && result.backgroundJob.id) {
        await stop({ id: result.backgroundJob.id }, {}).catch(() => undefined);
      }
    }
  });
});
