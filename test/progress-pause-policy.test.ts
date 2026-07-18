import { describe, expect, it } from "vitest";
import {
  codingSessionFromContext,
  isProtocolPlaceholderOutput,
  progressPauseMode,
} from "../src/agent/progress-pause-policy.js";

describe("progress pause policy", () => {
  it("never hard-pauses coding/build sessions", () => {
    expect(
      progressPauseMode({ codingSession: true, autoConfirm: false }),
    ).toBe("never");
    expect(
      progressPauseMode({ codingSession: true, autoConfirm: true }),
    ).toBe("never");
  });

  it("confirms for pentest/general interactive sessions", () => {
    expect(
      progressPauseMode({ codingSession: false, autoConfirm: false }),
    ).toBe("confirm");
  });

  it("never pauses under autoConfirm (-y)", () => {
    expect(
      progressPauseMode({ codingSession: false, autoConfirm: true }),
    ).toBe("never");
  });

  it("treats coding plan kind as a coding session", () => {
    expect(
      codingSessionFromContext({ buildLike: false, planKind: "coding" }),
    ).toBe(true);
    expect(
      codingSessionFromContext({ buildLike: false, planKind: "pentest" }),
    ).toBe(false);
    expect(
      codingSessionFromContext({ buildLike: true, planKind: "general" }),
    ).toBe(true);
  });

  it("detects protocol repair placeholders", () => {
    expect(
      isProtocolPlaceholderOutput(
        "[protocol] closed incomplete shell.exec call after resume (id=x). Ignore this row for evidence.",
      ),
    ).toBe(true);
    expect(isProtocolPlaceholderOutput("file a.ts\nfile b.ts")).toBe(false);
  });
});
