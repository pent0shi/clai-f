import type { CompletionRequest, CompletionResult } from "../types.js";
import {
  defaultModels,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import { readJson, readStreamLines } from "./http.js";
import {
  parseOllamaToolCalls,
  toOllamaToolMessages,
  toOllamaTools,
} from "./adapters/ollama-tools.js";
import { parseOllamaUsage } from "./token-usage.js";
import type { TokenUsage } from "../types.js";

function base(auth: ProviderAuth): string {
  return (auth.baseUrl ?? auth.apiKey ?? "http://localhost:11434").replace(
    /\/$/,
    "",
  );
}

export const ollamaProvider: LlmProvider = {
  id: "ollama",
  displayName: "Ollama",
  defaultModel: defaultModels.ollama,
  envVar: "OLLAMA_HOST",
  validateKey: (key: string) => /^https?:\/\/.+/.test(key),
  async ping(auth: ProviderAuth): Promise<void> {
    const response = await fetch(`${base(auth)}/api/tags`);
    await readJson<unknown>(response);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    const model = request.model ?? defaultModels.ollama;
    const body: Record<string, unknown> = {
      model,
      messages: toOllamaToolMessages(request.messages),
      stream: false,
      options: { temperature: request.temperature ?? 0.2 },
    };
    if (request.tools?.length) {
      body.tools = toOllamaTools(request.tools);
    }
    const response = await fetch(`${base(auth)}/api/chat`, {
      method: "POST",
      signal: request.signal ?? null,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await readJson<{
      message?: {
        content?: string;
        tool_calls?: Array<{
          id?: string;
          function?: {
            name?: string;
            arguments?: string | Record<string, unknown>;
          };
        }>;
      };
      prompt_eval_count?: number;
      eval_count?: number;
    }>(response);
    const toolCalls = parseOllamaToolCalls(data.message?.tool_calls);
    const text = data.message?.content?.trim() ?? "";
    if (!text && toolCalls.length === 0) {
      throw new Error("Ollama returned no completion text");
    }
    const usage = parseOllamaUsage({
      prompt_eval_count: data.prompt_eval_count,
      eval_count: data.eval_count,
    });
    return {
      text,
      provider: "ollama",
      model,
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(toolCalls.length ? { finishReason: "tool_calls" } : {}),
      ...(usage ? { usage } : {}),
    };
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    const model = request.model ?? defaultModels.ollama;
    const body: Record<string, unknown> = {
      model,
      messages: toOllamaToolMessages(request.messages),
      stream: true,
      options: { temperature: request.temperature ?? 0.2 },
    };
    if (request.tools?.length) {
      body.tools = toOllamaTools(request.tools);
    }
    const response = await fetch(`${base(auth)}/api/chat`, {
      method: "POST",
      signal: request.signal ?? null,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await readJson<unknown>(response);
    }
    if (!response.body) {
      throw new Error("Ollama returned no stream body");
    }
    let full = "";
    let toolCalls = parseOllamaToolCalls(undefined);
    let streamUsage: TokenUsage | undefined;

    for await (const line of readStreamLines(response, {
      signal: request.signal,
    })) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as {
          message?: {
            content?: string;
            tool_calls?: Array<{
              id?: string;
              function?: {
                name?: string;
                arguments?: string | Record<string, unknown>;
              };
            }>;
          };
          done?: boolean;
          prompt_eval_count?: number;
          eval_count?: number;
        };
        const token = parsed.message?.content;
        if (token) {
          full += token;
          onToken(token);
        }
        if (parsed.message?.tool_calls?.length) {
          toolCalls = parseOllamaToolCalls(parsed.message.tool_calls);
        }
        if (parsed.done) {
          streamUsage =
            parseOllamaUsage({
              prompt_eval_count: parsed.prompt_eval_count,
              eval_count: parsed.eval_count,
            }) ?? streamUsage;
          return {
            text: full,
            provider: "ollama",
            model,
            ...(toolCalls.length ? { toolCalls } : {}),
            ...(toolCalls.length ? { finishReason: "tool_calls" } : {}),
            ...(streamUsage ? { usage: streamUsage } : {}),
          };
        }
      } catch {
        // Ignore malformed lines.
      }
    }
    return {
      text: full,
      provider: "ollama",
      model,
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(toolCalls.length ? { finishReason: "tool_calls" } : {}),
      ...(streamUsage ? { usage: streamUsage } : {}),
    };
  },
};
