import { describe, expect, it } from "vitest";
import {
  compileBatchFailMode,
  evaluateCancelTargets,
  formatBatchCancelReason,
  parseBatchFailPolicy,
} from "../src/tools/batch-fail-policy.js";

describe("batch-fail-policy", () => {
  const ids = new Set(["1", "2", "3", "scan", "fuzz"]);

  it("defaults to continue when on_fail omitted", () => {
    expect(parseBatchFailPolicy({}, ids)).toEqual({ kind: "continue" });
  });

  it("parses string modes and aliases", () => {
    expect(parseBatchFailPolicy({ on_fail: "continue" }, ids).kind).toBe(
      "continue",
    );
    expect(parseBatchFailPolicy({ onFail: "cancel_pending" }, ids).kind).toBe(
      "cancel_pending",
    );
    expect(parseBatchFailPolicy({ fail_policy: "fail_fast" }, ids).kind).toBe(
      "cancel_pending",
    );
    expect(parseBatchFailPolicy({ on_fail: "cancel_rest" }, ids).kind).toBe(
      "cancel_pending",
    );
  });

  it("parses rules and single-rule shorthand object", () => {
    const rules = parseBatchFailPolicy(
      {
        on_fail: {
          rules: [
            { if_failed: "scan", cancel: ["fuzz"] },
            { if_failed: ["1", "2"], match: "all", cancel: "3" },
          ],
        },
      },
      ids,
    );
    expect(rules).toEqual({
      kind: "rules",
      rules: [
        { ifFailed: ["scan"], cancel: ["fuzz"], match: "any" },
        { ifFailed: ["1", "2"], cancel: ["3"], match: "all" },
      ],
    });

    const short = parseBatchFailPolicy(
      { on_fail: { if_failed: "1", cancel: ["2", "3"] } },
      ids,
    );
    expect(short.kind).toBe("rules");
    if (short.kind === "rules") {
      expect(short.rules).toHaveLength(1);
      expect(short.rules[0]).toMatchObject({
        ifFailed: ["1"],
        cancel: ["2", "3"],
        match: "any",
      });
    }
  });

  it("compiles per-call cancel_on_fail into rules", () => {
    const mode = compileBatchFailMode(
      { kind: "continue" },
      [
        {
          id: "scan",
          name: "net.scan",
          index1: 1,
          cancelOnFail: ["fuzz"],
        },
        {
          id: "fuzz",
          name: "shell.exec",
          index1: 2,
          cancelOnFail: [],
        },
      ],
      new Set(["scan", "fuzz"]),
    );
    expect(mode).toEqual({
      kind: "rules",
      rules: [
        { ifFailed: ["scan"], cancel: ["fuzz"], match: "any" },
      ],
    });
  });

  it("cancel_pending wins over per-call rules", () => {
    const mode = compileBatchFailMode(
      { kind: "cancel_pending" },
      [
        {
          id: "a",
          name: "sysinfo",
          index1: 1,
          cancelOnFail: ["b"],
        },
        { id: "b", name: "sysinfo", index1: 2, cancelOnFail: [] },
      ],
      new Set(["a", "b"]),
    );
    expect(mode.kind).toBe("cancel_pending");
  });

  it("evaluateCancelTargets for continue / cancel_pending / rules", () => {
    const all = ["1", "2", "3"];
    expect(
      [...evaluateCancelTargets({ kind: "continue" }, new Set(["1"]), all)],
    ).toEqual([]);
    expect(
      [
        ...evaluateCancelTargets(
          { kind: "cancel_pending" },
          new Set(["1"]),
          all,
        ),
      ].sort(),
    ).toEqual(["2", "3"]);

    const rulesMode = {
      kind: "rules" as const,
      rules: [
        {
          ifFailed: ["1"],
          cancel: ["3"],
          match: "any" as const,
        },
      ],
    };
    expect([
      ...evaluateCancelTargets(rulesMode, new Set(["1"]), all),
    ]).toEqual(["3"]);
    expect([
      ...evaluateCancelTargets(
        {
          kind: "rules",
          rules: [
            {
              ifFailed: ["1", "2"],
              cancel: ["3"],
              match: "all",
            },
          ],
        },
        new Set(["1"]),
        all,
      ),
    ]).toEqual([]);
  });

  it("formatBatchCancelReason lists triggers", () => {
    const meta = new Map([
      [
        "1",
        {
          id: "1",
          name: "fs.read",
          index1: 1,
          cancelOnFail: [] as string[],
        },
      ],
      [
        "2",
        {
          id: "2",
          name: "dns.lookup",
          index1: 2,
          cancelOnFail: [] as string[],
        },
      ],
    ]);
    expect(formatBatchCancelReason(["1"], meta)).toBe(
      "Cancelled — not run because #1 fs.read failed",
    );
    expect(formatBatchCancelReason(["1", "2"], meta)).toBe(
      "Cancelled — not run because #1 fs.read and #2 dns.lookup failed",
    );
  });
});
