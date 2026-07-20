import { describe, expect, it } from "vitest";
import { toGeminiFunctionDeclarations } from "../../../src/llm/adapters/gemini-tools.js";
import { getToolDefinitions } from "../../../src/tools/definitions.js";
import type { ToolDefinition } from "../../../src/types.js";

/**
 * Gemini's function-calling Schema rejects `additionalProperties` and
 * `oneOf` at ANY nesting depth with HTTP 400 ("Unknown name ... Cannot find
 * field"), not just at the top level. Every real tool definition must
 * survive sanitization with those keywords fully stripped/converted,
 * otherwise every native-tool Gemini agent turn fails outright.
 */
function collectBadKeys(schema: unknown, path: string, bad: string[]): void {
  if (Array.isArray(schema)) {
    schema.forEach((entry, i) => collectBadKeys(entry, `${path}[${i}]`, bad));
    return;
  }
  if (!schema || typeof schema !== "object") return;
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (["additionalProperties", "oneOf", "allOf", "$ref"].includes(key)) {
      bad.push(`${path}.${key}`);
    }
    if (key === "properties" && value && typeof value === "object") {
      for (const [propName, propSchema] of Object.entries(
        value as Record<string, unknown>,
      )) {
        collectBadKeys(propSchema, `${path}.properties.${propName}`, bad);
      }
    } else if (key === "items" || key === "anyOf") {
      collectBadKeys(value, `${path}.${key}`, bad);
    }
  }
}

describe("gemini tool schema sanitization", () => {
  it("strips additionalProperties/oneOf from every real tool definition, at any depth", () => {
    const defs = getToolDefinitions();
    const decls = toGeminiFunctionDeclarations(defs);
    expect(decls.length).toBe(defs.length);
    for (const decl of decls) {
      const bad: string[] = [];
      collectBadKeys(decl.parameters, decl.name, bad);
      expect(bad).toEqual([]);
    }
  });

  it("converts oneOf to anyOf (Gemini only understands anyOf)", () => {
    const def: ToolDefinition = {
      name: "test.oneOf",
      wireName: "test_oneOf",
      description: "test",
      parameters: {
        type: "object",
        properties: {
          value: {
            oneOf: [{ type: "string" }, { type: "integer" }],
          },
        },
      },
    };
    const [decl] = toGeminiFunctionDeclarations([def]);
    const value = (decl!.parameters as any).properties.value;
    expect(value.oneOf).toBeUndefined();
    expect(value.anyOf).toEqual([{ type: "string" }, { type: "integer" }]);
  });

  it("preserves nested additionalProperties-free object/array schemas (fs.writeMany)", () => {
    const [decl] = toGeminiFunctionDeclarations(
      getToolDefinitions({ names: ["fs.writeMany"] }),
    );
    const files = (decl!.parameters as any).properties.files;
    expect(files.type).toBe("array");
    expect(files.items.type).toBe("object");
    expect(files.items.properties.path).toEqual({ type: "string" });
    expect(files.items.additionalProperties).toBeUndefined();
  });
});
