import type { ChatMessage, NativeToolCall, ToolDefinition } from "../../types.js";
import {
  fromWireName,
  mapToolChoiceToAnthropic,
  parseToolArguments,
  syntheticToolCallId,
  toWireName,
  type ToolChoice,
  MAX_TOOL_ARG_BYTES,
} from "../tool-protocol.js";
// Side-effect: register wire name map before fromWireName use.
import "../../tools/definitions.js";

export function toAnthropicTools(defs: ToolDefinition[]): Array<{
  name: string;
  description: string;
  input_schema: ToolDefinition["parameters"];
}> {
  return defs.map((d) => ({
    name: d.wireName,
    description: d.description,
    input_schema: d.parameters,
  }));
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

/**
 * Convert dialect-neutral history to Anthropic Messages API messages.
 * System is filtered out; consecutive tool results collapse into one user turn.
 */
export function toAnthropicToolMessages(
  messages: ChatMessage[],
): Array<{ role: "user" | "assistant"; content: string | AnthropicContentBlock[] }> {
  const out: Array<{
    role: "user" | "assistant";
    content: string | AnthropicContentBlock[];
  }> = [];

  let i = 0;
  const nonSystem = messages.filter((m) => m.role !== "system");

  while (i < nonSystem.length) {
    const message = nonSystem[i]!;

    if (message.role === "tool") {
      const blocks: AnthropicContentBlock[] = [];
      while (i < nonSystem.length && nonSystem[i]!.role === "tool") {
        const tr = nonSystem[i]!;
        blocks.push({
          type: "tool_result",
          tool_use_id: tr.toolCallId ?? "",
          content: tr.content,
          // Prefer explicit ok flag; fall back to "ok=false" in content prefix.
          is_error:
            tr.ok === false ||
            (tr.ok !== true && /\bok=false\b/i.test(tr.content)),
        });
        i += 1;
      }
      out.push({ role: "user", content: blocks });
      continue;
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      const blocks: AnthropicContentBlock[] = [];
      if (message.content.trim()) {
        blocks.push({ type: "text", text: message.content });
      }
      for (const tc of message.toolCalls) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: toWireName(tc.name),
          input: tc.args ?? {},
        });
      }
      out.push({ role: "assistant", content: blocks });
      i += 1;
      continue;
    }

    if (message.role === "user" && message.images?.length) {
      const blocks: AnthropicContentBlock[] = [];
      if (message.content) {
        blocks.push({ type: "text", text: message.content });
      }
      for (const img of message.images) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: img.mediaType,
            data: img.dataBase64,
          },
        });
      }
      out.push({ role: "user", content: blocks });
      i += 1;
      continue;
    }

    const role = message.role === "assistant" ? "assistant" : "user";
    out.push({ role, content: message.content });
    i += 1;
  }

  return out;
}

export function anthropicToolBodyFields(options: {
  tools?: ToolDefinition[] | undefined;
  toolChoice?: ToolChoice | undefined;
}): Record<string, unknown> {
  if (!options.tools?.length) return {};
  return {
    tools: toAnthropicTools(options.tools),
    tool_choice: mapToolChoiceToAnthropic(options.toolChoice),
  };
}

export function parseAnthropicToolUseBlocks(
  content:
    | Array<{
        type: string;
        text?: string;
        thinking?: string;
        id?: string;
        name?: string;
        input?: unknown;
      }>
    | undefined,
): { text: string; thinkingText: string; toolCalls: NativeToolCall[] } {
  let text = "";
  let thinkingText = "";
  const toolCalls: NativeToolCall[] = [];
  if (!content) return { text, thinkingText, toolCalls };

  for (const part of content) {
    if (part.type === "text" && part.text) text += part.text;
    if (part.type === "thinking" && part.thinking) {
      thinkingText += part.thinking;
    }
    if (part.type === "tool_use") {
      const wire = part.name ?? "";
      const input = part.input;
      const args =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : parseToolArguments(
              typeof input === "string" ? input : JSON.stringify(input ?? {}),
            );
      toolCalls.push({
        id: part.id ?? syntheticToolCallId(toolCalls.length),
        name: fromWireName(wire) ?? wire,
        args,
      });
    }
  }
  return {
    text: text.trim(),
    thinkingText: thinkingText.trim(),
    toolCalls,
  };
}

export interface AnthropicToolStreamState {
  text: string;
  thinking: string;
  /** block index → partial tool_use */
  blocks: Map<
    number,
    {
      kind: "text" | "thinking" | "tool_use";
      id?: string;
      name?: string;
      json: string;
      text: string;
    }
  >;
}

export function createAnthropicToolStreamState(): AnthropicToolStreamState {
  return { text: "", thinking: "", blocks: new Map() };
}

export function handleAnthropicStreamEvent(
  state: AnthropicToolStreamState,
  event: {
    type?: string;
    index?: number;
    content_block?: {
      type?: string;
      id?: string;
      name?: string;
      text?: string;
      thinking?: string;
    };
    delta?: {
      type?: string;
      text?: string;
      thinking?: string;
      partial_json?: string;
    };
  },
): {
  textDelta?: string;
  thinkingDelta?: string;
  toolCallDelta?: {
    index: number;
    id?: string;
    name?: string;
    argumentsBytes?: number;
    nameBecameKnown?: boolean;
  };
} {
  const result: {
    textDelta?: string;
    thinkingDelta?: string;
    toolCallDelta?: {
      index: number;
      id?: string;
      name?: string;
      argumentsBytes?: number;
      nameBecameKnown?: boolean;
    };
  } = {};

  if (event.type === "content_block_start" && event.content_block) {
    const index = event.index ?? 0;
    const cb = event.content_block;
    if (cb.type === "tool_use") {
      const block: {
        kind: "tool_use";
        id?: string;
        name?: string;
        json: string;
        text: string;
      } = {
        kind: "tool_use",
        json: "",
        text: "",
      };
      if (cb.id !== undefined) block.id = cb.id;
      if (cb.name !== undefined) block.name = cb.name;
      state.blocks.set(index, block);
      if (cb.name) {
        result.toolCallDelta = {
          index,
          ...(cb.id !== undefined ? { id: cb.id } : {}),
          name: fromWireName(cb.name) ?? cb.name,
          argumentsBytes: 0,
          nameBecameKnown: true,
        };
      }
    } else if (cb.type === "text") {
      state.blocks.set(index, {
        kind: "text",
        json: "",
        text: "",
      });
    } else if (cb.type === "thinking") {
      state.blocks.set(index, {
        kind: "thinking",
        json: "",
        text: "",
      });
    }
  }

  if (event.type === "content_block_delta" && event.delta) {
    const index = event.index ?? 0;
    let block = state.blocks.get(index);
    if (!block) {
      block = { kind: "text", json: "", text: "" };
      state.blocks.set(index, block);
    }
    if (event.delta.type === "text_delta" && event.delta.text) {
      block.text += event.delta.text;
      state.text += event.delta.text;
      result.textDelta = event.delta.text;
    }
    if (event.delta.type === "thinking_delta" && event.delta.thinking) {
      block.text += event.delta.thinking;
      state.thinking += event.delta.thinking;
      result.thinkingDelta = event.delta.thinking;
    }
    if (
      event.delta.type === "input_json_delta" &&
      typeof event.delta.partial_json === "string"
    ) {
      block.json += event.delta.partial_json;
      if (block.json.length > MAX_TOOL_ARG_BYTES) {
        throw new Error(
          `Tool call arguments exceeded ${MAX_TOOL_ARG_BYTES} bytes — split the file or reduce content size.`,
        );
      }
      // Periodic large-arg progress for early UI cards.
      if (
        block.kind === "tool_use" &&
        block.json.length > 0 &&
        block.json.length % 4096 < event.delta.partial_json.length
      ) {
        result.toolCallDelta = {
          index,
          ...(block.id !== undefined ? { id: block.id } : {}),
          ...(block.name
            ? { name: fromWireName(block.name) ?? block.name }
            : {}),
          argumentsBytes: block.json.length,
        };
      }
    }
  }

  return result;
}

export function finalizeAnthropicToolStream(
  state: AnthropicToolStreamState,
): { text: string; thinkingText: string; toolCalls: NativeToolCall[] } {
  const toolCalls: NativeToolCall[] = [];
  const indices = [...state.blocks.keys()].sort((a, b) => a - b);
  for (const index of indices) {
    const block = state.blocks.get(index)!;
    if (block.kind !== "tool_use") continue;
    const wire = block.name ?? "";
    const args = parseToolArguments(block.json);
    toolCalls.push({
      id: block.id ?? syntheticToolCallId(index),
      name: fromWireName(wire) ?? wire,
      args,
      ...(block.json ? { rawArguments: block.json } : {}),
    });
  }
  return {
    text: state.text.trim(),
    thinkingText: state.thinking.trim(),
    toolCalls,
  };
}
