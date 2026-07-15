import type { ChatMessage, NativeToolCall, ToolDefinition } from "../../types.js";
import {
  fromWireName,
  mapToolChoiceToGemini,
  parseToolArguments,
  syntheticToolCallId,
  toWireName,
  type ToolChoice,
} from "../tool-protocol.js";
// Side-effect: register wire name map before fromWireName use.
import "../../tools/definitions.js";

export function toGeminiFunctionDeclarations(defs: ToolDefinition[]): Array<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}> {
  return defs.map((d) => {
    // Gemini is picky about some JSON Schema keywords; strip additionalProperties.
    const parameters = {
      type: "object",
      properties: d.parameters.properties,
      ...(d.parameters.required?.length
        ? { required: d.parameters.required }
        : {}),
    };
    return {
      name: d.wireName,
      description: d.description,
      parameters,
    };
  });
}

export function geminiToolBodyFields(options: {
  tools?: ToolDefinition[] | undefined;
  toolChoice?: ToolChoice | undefined;
}): Record<string, unknown> {
  if (!options.tools?.length) return {};
  const fc = mapToolChoiceToGemini(options.toolChoice);
  return {
    tools: [
      {
        functionDeclarations: toGeminiFunctionDeclarations(options.tools),
      },
    ],
    toolConfig: {
      functionCallingConfig: {
        mode: fc.mode,
        ...(fc.allowedFunctionNames
          ? { allowedFunctionNames: fc.allowedFunctionNames }
          : {}),
      },
    },
  };
}

type GeminiPart =
  | { text: string; thought?: boolean }
  | { inlineData: { mimeType: string; data: string } }
  | {
      functionCall: {
        name: string;
        args?: Record<string, unknown>;
        id?: string;
      };
    }
  | {
      functionResponse: {
        name: string;
        response: Record<string, unknown>;
        id?: string;
      };
    };

/**
 * Convert dialect-neutral history to Gemini contents with functionCall /
 * functionResponse parts. System messages are skipped (use systemInstruction).
 */
export function toGeminiToolContents(
  messages: ChatMessage[],
): Array<{ role: "user" | "model"; parts: GeminiPart[] }> {
  const contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = [];

  let i = 0;
  const nonSystem = messages.filter((m) => m.role !== "system");

  while (i < nonSystem.length) {
    const message = nonSystem[i]!;

    if (message.role === "tool") {
      const parts: GeminiPart[] = [];
      while (i < nonSystem.length && nonSystem[i]!.role === "tool") {
        const tr = nonSystem[i]!;
        const wire = tr.name ? toWireName(tr.name) : "unknown";
        parts.push({
          functionResponse: {
            name: wire,
            response: { result: tr.content },
            ...(tr.toolCallId ? { id: tr.toolCallId } : {}),
          },
        });
        i += 1;
      }
      contents.push({ role: "user", parts });
      continue;
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      const parts: GeminiPart[] = [];
      if (message.content.trim()) {
        parts.push({ text: message.content });
      }
      for (const tc of message.toolCalls) {
        parts.push({
          functionCall: {
            name: toWireName(tc.name),
            args: tc.args ?? {},
            ...(tc.id ? { id: tc.id } : {}),
          },
        });
      }
      contents.push({ role: "model", parts });
      i += 1;
      continue;
    }

    const role = message.role === "assistant" ? "model" : "user";
    const parts: GeminiPart[] = [];
    if (message.content.trim()) parts.push({ text: message.content });
    if (role === "user" && message.images) {
      for (const img of message.images) {
        parts.push({
          inlineData: { mimeType: img.mediaType, data: img.dataBase64 },
        });
      }
    }
    if (parts.length === 0) {
      i += 1;
      continue;
    }
    const previous = contents.at(-1);
    if (previous?.role === role) {
      previous.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
    i += 1;
  }

  return contents;
}

export function parseGeminiFunctionCalls(
  parts:
    | Array<{
        text?: string;
        thought?: boolean;
        functionCall?: {
          name?: string;
          args?: Record<string, unknown>;
          id?: string;
        };
      }>
    | undefined,
): { text: string; toolCalls: NativeToolCall[] } {
  let text = "";
  const toolCalls: NativeToolCall[] = [];
  if (!parts) return { text, toolCalls };

  for (const part of parts) {
    // Always parse functionCall even when the part is also tagged as thought.
    if (part.functionCall?.name) {
      const wire = part.functionCall.name;
      const args = part.functionCall.args
        ? parseToolArguments(part.functionCall.args)
        : {};
      toolCalls.push({
        id: part.functionCall.id ?? syntheticToolCallId(toolCalls.length),
        name: fromWireName(wire) ?? wire,
        args,
      });
    }
    // Skip thought text from user-visible content.
    if (part.thought) continue;
    if (typeof part.text === "string" && part.text) {
      text += part.text;
    }
  }
  return { text: text.trim(), toolCalls };
}
