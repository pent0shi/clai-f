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
  },
): Promise<string> {
  const completeSummary = async (p: string): Promise<string> => {
    const response = await completeWithProvider({
      provider: opts.provider,
      model: opts.model,
      messages: [
        {
          role: "system",
          content:
            "You compress conversation history into accurate continuation memory.",
        },
        { role: "user", content: p },
      ],
      temperature: 0.1,
      maxTokens: 2_048,
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
        `Summarize part ${index + 1} of ${chunks.length} of one session. Preserve concrete goals, actions, commands, results, task state, failures, and remaining work.\n\n${chunks[index]}`,
      ),
    );
  }
  opts.signal?.throwIfAborted();
  return completeSummary(
    "Merge these ordered partial session memories into one non-redundant continuation memory. Preserve all concrete facts and unresolved work. Use sections: User goals, Decisions and constraints, Work completed, Commands/tools and results, Current state, Remaining work.\n\n" +
      partials.map((part, index) => `PART ${index + 1}:\n${part}`).join("\n\n"),
  );
}
