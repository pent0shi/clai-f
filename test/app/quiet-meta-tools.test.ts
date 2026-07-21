import { describe, expect, it } from "vitest";
import {
  isQuietMetaTool,
  shouldHideQuietMetaToolInChat,
} from "../../src/app/adapters/quiet-meta-tools.js";
import { isInternalChatMessage } from "../../src/types.js";

describe("quiet meta tools", () => {
  it("recognizes plan.create and task.update", () => {
    expect(isQuietMetaTool("plan.create")).toBe(true);
    expect(isQuietMetaTool("task.update")).toBe(true);
    expect(isQuietMetaTool("shell.exec")).toBe(false);
  });

  it("hides plan.create on success, surfaces its failures/blocked", () => {
    expect(shouldHideQuietMetaToolInChat("plan.create", "ok")).toBe(true);
    expect(shouldHideQuietMetaToolInChat("plan.create", "running")).toBe(true);
    expect(shouldHideQuietMetaToolInChat("plan.create", "failed")).toBe(false);
    expect(shouldHideQuietMetaToolInChat("plan.create", "blocked")).toBe(false);
    expect(shouldHideQuietMetaToolInChat("shell.exec", "ok")).toBe(false);
  });

  it("always hides task.update regardless of outcome", () => {
    expect(shouldHideQuietMetaToolInChat("task.update", "ok")).toBe(true);
    expect(shouldHideQuietMetaToolInChat("task.update", "running")).toBe(true);
    expect(shouldHideQuietMetaToolInChat("task.update", "failed")).toBe(true);
    expect(shouldHideQuietMetaToolInChat("task.update", "blocked")).toBe(true);
  });
});

describe("internal chat messages", () => {
  it("hides Plan approved implement directives", () => {
    expect(
      isInternalChatMessage({
        role: "user",
        content:
          "Plan approved. Execute the engagement tasks. Work through pending tasks.",
      }),
    ).toBe(true);
    expect(
      isInternalChatMessage({
        role: "user",
        content: "Plan approved. Execute it. Work through pending tasks.",
      }),
    ).toBe(true);
    expect(
      isInternalChatMessage({
        role: "user",
        content: "please implement the plan for me",
      }),
    ).toBe(false);
  });
});
