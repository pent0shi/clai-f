import type { ChatMessage, NativeToolCall, ToolDefinition } from "../../types.js";
import {
  mapToolChoiceToOpenAi,
  toWireName,
  type ToolChoice,
} from "../tool-protocol.js";
// Side-effect: register wire name map (incl. snake_case aliases) before fromWireName use.
import "../../tools/definitions.js";

export function toOpenAiTools(defs: ToolDefinition[]): Array<{
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolDefinition["parameters"];
  };
}> {
  return defs.map((d) => ({
    type: "function" as const,
    function: {
      name: d.wireName,
      description: d.description,
      parameters: d.parameters,
    },
  }));
}

export type OpenAiWireMessage =
  | {
      role: "system" | "user" | "assistant";
      content: string | unknown[] | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
      name?: string;
    };

/**
 * Map dialect-neutral ChatMessage[] to OpenAI Chat Completions wire format,
 * preserving tool roles and assistant tool_calls.
 */
export function toOpenAiToolMessages(
  messages: ChatMessage[],
  mapUserContent: (message: ChatMessage) => string | unknown[],
): OpenAiWireMessage[] {
  const out: OpenAiWireMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: message.toolCallId ?? "",
        content: message.content,
        ...(message.name ? { name: toWireName(message.name) } : {}),
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: toWireName(tc.name),
            arguments: tc.rawArguments ?? JSON.stringify(tc.args ?? {}),
          },
        })),
      });
      continue;
    }
    if (message.role === "user") {
      out.push({
        role: "user",
        content: mapUserContent(message),
      });
      continue;
    }
    out.push({
      role: message.role as "system" | "assistant",
      content: message.content,
    });
  }
  return out;
}

export function openAiToolBodyFields(options: {
  tools?: ToolDefinition[] | undefined;
  toolChoice?: ToolChoice | undefined;
  parallelToolCalls?: boolean | undefined;
}): Record<string, unknown> {
  if (!options.tools?.length) return {};
  return {
    tools: toOpenAiTools(options.tools),
    tool_choice: mapToolChoiceToOpenAi(options.toolChoice),
    // Only send the field when it changes behavior. Several OpenAI-compatible
    // gateways (self-hosted NIM chat templates, DashScope compatible mode)
    // reject unknown top-level fields with a 400 that used to be misread as
    // "tools not supported", permanently downgrading the model to the legacy
    // fenced protocol. Parallel calls are the upstream default anyway.
    ...(options.parallelToolCalls === false
      ? { parallel_tool_calls: false }
      : {}),
  };
}

export function nativeToolCallsFromOpenAi(
  toolCalls: NativeToolCall[] | undefined,
): NativeToolCall[] | undefined {
  return toolCalls?.length ? toolCalls : undefined;
}
