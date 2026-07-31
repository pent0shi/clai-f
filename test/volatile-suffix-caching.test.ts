import { describe, expect, it } from "vitest";
import {
  SESSION_STATE_PREFIX,
  upsertSessionStateMessage,
} from "../src/agent/session-state.js";
import {
  PLAN_CONTEXT_PREFIX,
  upsertPlanContextMessage,
} from "../src/agent/plan-tool.js";
import {
  RESPONDER_CONTEXT_PREFIX,
  upsertResponderContextMessage,
} from "../src/agent/responder-context.js";

/**
 * Provider prompt caching only pays off while the request PREFIX is byte-stable.
 * Plan / session-state / responder blocks are mutable and are refreshed several
 * times per turn, so each one must (a) exist at most once and (b) live at the
 * tail, after the constitution and the whole conversation. Inserting any of them
 * mid-array would silently invalidate the cached prefix on every step and
 * multiply input cost across a long turn, with no visible symptom.
 */

type Message = { role: string; content: string };

const VOLATILE_PREFIXES = [
  SESSION_STATE_PREFIX,
  PLAN_CONTEXT_PREFIX,
  RESPONDER_CONTEXT_PREFIX,
];

function isVolatile(message: Message): boolean {
  return (
    message.role === "system" &&
    VOLATILE_PREFIXES.some((prefix) => message.content.startsWith(prefix))
  );
}

function stablePrefix(messages: Message[]): Message[] {
  const firstVolatile = messages.findIndex(isVolatile);
  return firstVolatile < 0 ? messages : messages.slice(0, firstVolatile);
}

function countStartingWith(messages: Message[], prefix: string): number {
  return messages.filter(
    (message) => message.role === "system" && message.content.startsWith(prefix),
  ).length;
}

function baseConversation(): Message[] {
  return [
    { role: "system", content: "CONSTITUTION: stable agent prefix" },
    { role: "user", content: "build the thing" },
    { role: "assistant", content: "working on it" },
    { role: "tool", content: "Tool fs.write result (exit=0, ok=true):\nwrote" },
  ];
}

describe("volatile blocks stay a cacheable request suffix", () => {
  it("keeps exactly one copy no matter how many times a turn refreshes them", () => {
    const messages = baseConversation();
    for (let step = 1; step <= 7; step += 1) {
      upsertPlanContextMessage(messages, `${PLAN_CONTEXT_PREFIX} v${step}`);
      upsertSessionStateMessage(messages, `step ${step}`);
      upsertResponderContextMessage(
        messages,
        `${RESPONDER_CONTEXT_PREFIX}\njobs: ${step}`,
      );
    }
    for (const prefix of VOLATILE_PREFIXES) {
      expect(countStartingWith(messages, prefix)).toBe(1);
    }
    // Only the newest revision survives.
    expect(messages.some((m) => m.content.includes("v7"))).toBe(true);
    expect(messages.some((m) => m.content.includes("v6"))).toBe(false);
  });

  it("never inserts a volatile block ahead of the conversation", () => {
    const messages = baseConversation();
    const before = stablePrefix(messages).map((m) => `${m.role}:${m.content}`);
    upsertPlanContextMessage(messages, `${PLAN_CONTEXT_PREFIX} v1`);
    upsertSessionStateMessage(messages, "open task t1");
    const after = stablePrefix(messages).map((m) => `${m.role}:${m.content}`);
    // The bytes the provider can cache must be untouched by a refresh.
    expect(after).toEqual(before);
    const firstVolatile = messages.findIndex(isVolatile);
    expect(messages.slice(firstVolatile).every(isVolatile)).toBe(true);
  });

  it("holds the prefix stable across many refreshes", () => {
    const messages = baseConversation();
    upsertSessionStateMessage(messages, "first");
    const prefixAfterFirst = JSON.stringify(stablePrefix(messages));
    for (let step = 0; step < 20; step += 1) {
      upsertSessionStateMessage(messages, `refresh ${step}`);
      upsertPlanContextMessage(messages, `${PLAN_CONTEXT_PREFIX} v${step}`);
    }
    expect(JSON.stringify(stablePrefix(messages))).toBe(prefixAfterFirst);
    // Growth is bounded: refreshes replace, they do not accumulate.
    expect(messages.length).toBe(baseConversation().length + 2);
  });

  it("drops the responder block entirely when there is nothing to report", () => {
    const messages = baseConversation();
    upsertResponderContextMessage(
      messages,
      `${RESPONDER_CONTEXT_PREFIX}\njobs: 1`,
    );
    expect(countStartingWith(messages, RESPONDER_CONTEXT_PREFIX)).toBe(1);
    upsertResponderContextMessage(messages, undefined);
    expect(countStartingWith(messages, RESPONDER_CONTEXT_PREFIX)).toBe(0);
    expect(messages).toEqual(baseConversation());
  });
});
