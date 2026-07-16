import type { Mode } from "../types.js";

export type PromptSectionKind =
  | "safety"
  | "mode"
  | "outcome"
  | "plan"
  | "scope"
  | "recovery"
  | "focus"
  | "constitution"
  | "context";

export interface AgentPromptSection {
  readonly kind: PromptSectionKind;
  readonly content: string;
  readonly mandatory?: boolean;
}

export interface AgentPromptContext {
  readonly mode: Mode;
  readonly nativeToolsActive: boolean;
  readonly sections: readonly AgentPromptSection[];
  readonly maxTokens?: number | undefined;
}

export interface ComposedPrompt {
  readonly content: string;
  readonly included: readonly PromptSectionKind[];
  readonly omitted: readonly PromptSectionKind[];
  readonly estimatedTokens: number;
}

const priority: Record<PromptSectionKind, number> = {
  safety: 0,
  mode: 1,
  outcome: 2,
  plan: 3,
  scope: 4,
  recovery: 5,
  focus: 6,
  constitution: 7,
  context: 8,
};

const estimateTokens = (value: string): number => Math.ceil(value.length / 4);

/** Canonical composer used immediately before every provider request. */
export function composeAgentSystemPrompt(ctx: AgentPromptContext): ComposedPrompt {
  const modeSection: AgentPromptSection = {
    kind: "mode",
    mandatory: true,
    content: `CURRENT MODE: ${ctx.mode.toUpperCase()}\nMode is authoritative for this request.`,
  };
  const ordered = [modeSection, ...ctx.sections]
    .filter((section) => section.content.trim().length > 0)
    .sort((a, b) => priority[a.kind] - priority[b.kind]);
  const selected: AgentPromptSection[] = [];
  const omitted: PromptSectionKind[] = [];
  const maxChars = ctx.maxTokens === undefined ? Infinity : Math.max(0, ctx.maxTokens * 4);
  let used = 0;

  for (const section of ordered) {
    const separator = selected.length === 0 ? 0 : 2;
    const size = section.content.length + separator;
    if (section.mandatory || used + size <= maxChars) {
      selected.push(section);
      used += size;
    } else {
      omitted.push(section.kind);
    }
  }

  const content = selected.map((section) => section.content).join("\n\n");
  return {
    content,
    included: selected.map((section) => section.kind),
    omitted,
    estimatedTokens: estimateTokens(content),
  };
}
