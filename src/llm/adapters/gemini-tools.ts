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
import { normalizeSystemMessages } from "../system-messages.js";

/**
 * Gemini's function-calling `Schema` type only understands a specific subset
 * of JSON Schema (see https://ai.google.dev/api/caching#Schema): type,
 * format, title, description, nullable, enum, maxItems, minItems, properties,
 * required, minProperties, maxProperties, minLength, maxLength, pattern,
 * example, anyOf, propertyOrdering, default, items, minimum, maximum.
 *
 * Anything else — most commonly `additionalProperties` (rejected at ANY
 * nesting depth, not just the top level) and `oneOf` (Gemini only supports
 * `anyOf`) — makes the whole request fail with HTTP 400
 * ("Unknown name ... Cannot find field"). This walks the schema recursively
 * so nested array/object parameters (fs.writeMany, tool.batch, plan.create, …)
 * never leak unsupported keywords into the wire payload.
 */
const GEMINI_SCHEMA_KEYS = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "maxItems",
  "minItems",
  "properties",
  "required",
  "minProperties",
  "maxProperties",
  "minLength",
  "maxLength",
  "pattern",
  "example",
  "anyOf",
  "propertyOrdering",
  "default",
  "items",
  "minimum",
  "maximum",
]);

function sanitizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => sanitizeGeminiSchema(entry));
  }
  if (!schema || typeof schema !== "object") return schema;
  const input = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // Gemini only supports `anyOf`, not `oneOf`/`allOf` — fold oneOf into anyOf
  // (loses the "exactly one" constraint, but the model still gets valid
  // alternatives instead of a hard-rejected request).
  const anyOfSource = input.anyOf ?? input.oneOf;
  for (const [key, value] of Object.entries(input)) {
    if (key === "oneOf") continue;
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
    if (key === "properties" && value && typeof value === "object") {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(
        value as Record<string, unknown>,
      )) {
        props[propName] = sanitizeGeminiSchema(propSchema);
      }
      out.properties = props;
      continue;
    }
    if ((key === "items" || key === "anyOf") && value !== undefined) {
      out[key] = sanitizeGeminiSchema(value);
      continue;
    }
    out[key] = value;
  }
  if (!("anyOf" in out) && anyOfSource !== undefined) {
    out.anyOf = sanitizeGeminiSchema(anyOfSource);
  }
  return out;
}

export function toGeminiFunctionDeclarations(defs: ToolDefinition[]): Array<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}> {
  return defs.map((d) => {
    const parameters = sanitizeGeminiSchema({
      type: "object",
      properties: d.parameters.properties,
      ...(d.parameters.required?.length
        ? { required: d.parameters.required }
        : {}),
    }) as Record<string, unknown>;
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
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | { inlineData: { mimeType: string; data: string } }
  | {
      functionCall: {
        name: string;
        args?: Record<string, unknown>;
        id?: string;
      };
      thoughtSignature?: string;
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
 * functionResponse parts. The first system message is owned by
 * `systemInstruction`; later system messages become marked user turns in place
 *.
 */
export function toGeminiToolContents(
  messages: ChatMessage[],
): Array<{ role: "user" | "model"; parts: GeminiPart[] }> {
  const contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = [];

  let i = 0;
  const nonSystem = normalizeSystemMessages(messages).rest;

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
          // Gemini 3 requires the exact thoughtSignature it returned on this
          // functionCall part to be echoed back, or the request 400s. See
          // https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
          ...(tc.thoughtSignature
            ? { thoughtSignature: tc.thoughtSignature }
            : {}),
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
        thoughtSignature?: string;
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
        // Gemini 3 attaches this only to the first functionCall part in a
        // step — capture it wherever it lands so it can be echoed back.
        ...(part.thoughtSignature
          ? { thoughtSignature: part.thoughtSignature }
          : {}),
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
