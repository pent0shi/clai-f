/**
 * Summarizer callback used by SessionController.compact (keeps the controller slim).
 */

import type { ProviderId } from "../../types.js";
import { completeWithProvider } from "../../llm/router.js";

export async function summarizeForSessionCompact(
  prompt: string,
  opts: {
    provider: ProviderId | undefined;
    model: string | undefined;
    signal?: AbortSignal | undefined;
    /** plan-implement needs denser handoff memory — allow a larger completion. */
    purpose?: "default" | "plan-implement" | undefined;
  },
): Promise<string> {
  const maxTokens = opts.purpose === "plan-implement" ? 4_096 : 2_048;
  const systemContent =
    opts.purpose === "plan-implement"
      ? "You write dense, complete handoff memory for an agent that will execute an approved plan. State clearly that this context is from plan-mode research used to build the comprehensive plan and tasks the agent is seeing. Preserve findings, coverage, negatives, artifacts, and open work. Never invent. Never cut a fact mid-token."
      : "You compress conversation history into accurate continuation memory.";

  const completeSummary = async (p: string): Promise<string> => {
    const response = await completeWithProvider({
      provider: opts.provider,
      model: opts.model,
      messages: [
        {
          role: "system",
          content: systemContent,
        },
        { role: "user", content: p },
      ],
      temperature: 0.1,
      maxTokens,
      signal: opts.signal,
    });
    return response.text;
  };

  const chunkSize = 50_000;
  if (prompt.length <= chunkSize) return completeSummary(prompt);
  const chunks = Array.from(
    { length: Math.ceil(prompt.length / chunkSize) },
    (_, index) => prompt.slice(index * chunkSize, (index + 1) * chunkSize),
  );
  const partials: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    opts.signal?.throwIfAborted();
    partials.push(
      await completeSummary(
        opts.purpose === "plan-implement"
          ? `Summarize part ${index + 1} of ${chunks.length} of plan-mode research for implement handoff. Preserve targets, stack, confirmed findings, negatives, untested classes, artifact paths, tools used, and remaining work.\n\n${chunks[index]}`
          : `Summarize part ${index + 1} of ${chunks.length} of one session. Preserve concrete goals, actions, commands, results, task state, failures, and remaining work.\n\n${chunks[index]}`,
      ),
    );
  }
  opts.signal?.throwIfAborted();
  return completeSummary(
    opts.purpose === "plan-implement"
      ? "Merge these ordered partial plan-mode research memories into one non-redundant implement handoff. Use sections: User goals, Research evidence, Coverage ledger, Confirmed findings, Negative/tested-OK, Untested/open, Artifacts, Durable rules, Plan-mode-only notes, Commands/tools, Current state, Remaining work, Open risks. Complete every fact; never cut mid-token.\n\n" +
          partials.map((part, index) => `PART ${index + 1}:\n${part}`).join("\n\n")
      : "Merge these ordered partial session memories into one non-redundant continuation memory. Preserve all concrete facts and unresolved work. Use sections: User goals, Decisions and constraints, Work completed, Commands/tools and results, Current state, Remaining work.\n\n" +
          partials.map((part, index) => `PART ${index + 1}:\n${part}`).join("\n\n"),
  );
}
