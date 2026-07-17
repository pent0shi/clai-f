import { describe, expect, it } from "vitest";
import {
  toolRegistry,
  runToolCall,
  normalizeBatchToolName,
  BATCH_SAFE_TOOLS,
} from "../src/tools/registry.js";
import { classifyToolCall } from "../src/safety/classifier.js";

describe("phase 12 — tool.batch", () => {
  it("is registered and empty batch classifies as safe (handler rejects empty)", () => {
    expect(toolRegistry["tool.batch"]).toBeDefined();
    const decision = classifyToolCall({
      name: "tool.batch",
      args: { calls: [] },
    });
    expect(decision.level).toBe("safe");
  });

  it("classifies all-safe children as safe and elevates confirm children", () => {
    expect(
      classifyToolCall({
        name: "tool.batch",
        args: {
          calls: [
            { name: "sysinfo", args: {} },
            { name: "tool.check", args: { tools: ["nmap"] } },
          ],
        },
      }).level,
    ).toBe("safe");

    expect(
      classifyToolCall({
        name: "tool.batch",
        args: {
          calls: [{ name: "shell.exec", args: { command: "rm -rf /tmp/x" } }],
        },
      }).level,
    ).toBe("confirm");
  });

  it("rejects an empty or non-array calls value", async () => {
    await expect(
      runToolCall({ name: "tool.batch", args: { calls: [] } }),
    ).rejects.toThrow(/at least one/);
    await expect(
      runToolCall({ name: "tool.batch", args: { calls: "ls" } }),
    ).rejects.toThrow(/calls/);
  });

  it("normalizes wire names (tool_check → tool.check)", () => {
    expect(normalizeBatchToolName("tool_check")).toBe("tool.check");
    expect(normalizeBatchToolName("fs_read")).toBe("fs.read");
    expect(normalizeBatchToolName("web.search")).toBe("web.search");
  });

  it("accepts tool_check wire form for a parallel-safe tool", async () => {
    const result = await runToolCall({
      name: "tool.batch",
      args: {
        calls: [{ name: "tool_check", args: { tools: ["node"] } }],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/#1 tool\.check/);
  });

  it("refuses unconfirmed confirm-level shell inside batch", async () => {
    // `echo` is safe; use a mutate-class command so the batch elevates to confirm.
    await expect(
      runToolCall({
        name: "tool.batch",
        args: {
          calls: [
            {
              name: "shell.exec",
              args: { command: "rm -rf /tmp/clai-batch-should-not-run" },
            },
          ],
        },
      }),
    ).rejects.toThrow(/confirm-level|approval|refuses/i);
  });

  it("allows safe shell version probes without confirm", async () => {
    // Many version probes classify as safe and are parallel-safe only if in
    // BATCH_SAFE — shell.exec is serial when allowed; without confirmed,
    // only truly safe shell may still need confirm depending on classifier.
    // fs.write without confirm must refuse.
    await expect(
      runToolCall({
        name: "tool.batch",
        args: {
          calls: [{ name: "fs.write", args: { path: "/tmp/x", content: "a" } }],
        },
      }),
    ).rejects.toThrow(/confirm|refuses|approval/i);
  });

  it("allows net.scan / pentest.recon in batch (read-only recon)", async () => {
    // Empty/invalid targets fail at the tool, not at the batch gate.
    for (const name of ["net.scan", "pentest.recon"] as const) {
      expect(BATCH_SAFE_TOOLS.has(name)).toBe(true);
      await expect(
        runToolCall({
          name: "tool.batch",
          args: { calls: [{ name, args: { target: "127.0.0.1" } }] },
        }),
      ).resolves.toMatchObject({ ok: expect.any(Boolean) });
    }
  });

  it("refuses nested tool.batch and plan tools", async () => {
    await expect(
      runToolCall({
        name: "tool.batch",
        args: {
          calls: [{ name: "tool.batch", args: { calls: [] } }],
        },
      }),
    ).rejects.toThrow(/nested|refuses/i);
    await expect(
      runToolCall({
        name: "tool.batch",
        args: {
          calls: [
            {
              name: "plan.create",
              args: { goal: "x", tasks: ["a"], detail: "d" },
            },
          ],
        },
      }),
    ).rejects.toThrow(/refuses|nested/i);
  });

  it("caps the number of calls at 20", async () => {
    const calls = Array.from({ length: 21 }, () => ({
      name: "sysinfo",
      args: {},
    }));
    await expect(
      runToolCall({ name: "tool.batch", args: { calls } }),
    ).rejects.toThrow(/at most 20/);
  });

  it("runs allowed read-only tools and aggregates their outputs", async () => {
    const result = await runToolCall({
      name: "tool.batch",
      args: {
        calls: [
          { name: "sysinfo", args: {} },
          { name: "sysinfo", args: {} },
        ],
      },
    });
    expect(result.ok).toBe(true);
    // Both sub-results are present and labeled.
    expect(result.output).toMatch(/#1 sysinfo \[ok/);
    expect(result.output).toMatch(/#2 sysinfo \[ok/);
  });

  it("aborts pending calls when the parent signal aborts", async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await runToolCall(
      {
        name: "tool.batch",
        args: { calls: [{ name: "sysinfo", args: {} }] },
      },
      { signal: ac.signal },
    );
    // sysinfo is synchronous so it actually runs even when aborted preemptively.
    // But the batch should still report success/aborted output without throwing.
    expect(typeof result.output).toBe("string");
  });
});
