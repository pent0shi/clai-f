/**
 * Print rendered agent/ask system prompt sizes (chars + rough token estimate).
 * Usage: npx tsx scripts/prompt-budget.ts
 */
import {
  renderAgentSystemPrompt,
  renderAskSystemPrompt,
  renderCompactAgentSystemPrompt,
} from "../src/prompts/index.js";
import {
  buildWorkflowDirective,
  pentestWorkflowDirective,
  pentestNoLocalServerDirective,
} from "../src/agent/tool-call-parser.js";
import { formatTaskAnalysisHint, analyzeTask } from "../src/agent/task-analyzer.js";
import { composeAgentSystemPrompt } from "../src/agent/prompt-composer.js";

function report(label: string, text: string): void {
  const chars = text.length;
  const tokens = Math.ceil(chars / 4);
  console.log(
    `${label.padEnd(42)} ${String(chars).padStart(7)} chars  ~${String(tokens).padStart(6)} tok`,
  );
}

const tools =
  "shell.exec, shell.start, fs.read, fs.write, fs.writeMany, fs.edit, plan.create, task.update, web.search, web.fetch, http.fetch, net.scan, dns.lookup, tool.check, tool.batch";

const agent = renderAgentSystemPrompt(tools);
const agentNative = renderAgentSystemPrompt(tools, { nativeTools: true });
const compact = renderCompactAgentSystemPrompt(tools);
const ask = renderAskSystemPrompt();

const buildTurn =
  agent +
  "\n\n" +
  buildWorkflowDirective() +
  "\n\n" +
  formatTaskAnalysisHint(analyzeTask("create a react todo app on Desktop"));

const pentestTurn =
  agent +
  "\n\n" +
  pentestWorkflowDirective() +
  "\n\n" +
  pentestNoLocalServerDirective() +
  "\n\n" +
  formatTaskAnalysisHint(analyzeTask("pentest example.com"));

console.log("clai prompt budget (chars/4 ≈ tokens)\n");
report("agent (fence)", agent);
report("agent (native tools)", agentNative);
report("agent compact", compact);
report("ask", ask);
report("buildWorkflowDirective", buildWorkflowDirective());
report("pentestWorkflowDirective", pentestWorkflowDirective());
report("typical BUILD turn (sys+directives)", buildTurn);
report("typical PENTEST turn (sys+directives)", pentestTurn);
console.log(
  "\nTargets (from revamp): core agent ~5–6k tok; build/pentest injects short FOCUS cards.",
);

const mandatorySections = [
  { kind: "constitution" as const, content: "CONSTITUTION_SENTINEL", mandatory: true },
  { kind: "mode" as const, content: "MODE_SENTINEL", mandatory: true },
  { kind: "outcome" as const, content: "OUTCOME_SENTINEL", mandatory: true },
  { kind: "plan" as const, content: "PLAN_SENTINEL", mandatory: true },
  { kind: "scope" as const, content: "SCOPE_SENTINEL", mandatory: true },
  { kind: "context" as const, content: "TASK_SENTINEL", mandatory: true },
];
const composed = composeAgentSystemPrompt({
  mode: "agent",
  nativeToolsActive: true,
  maxTokens: 32,
  sections: mandatorySections,
});
for (const section of mandatorySections) {
  if (!composed.content.includes(section.content)) {
    throw new Error(`Prompt contract failure: missing mandatory ${section.kind} section`);
  }
}
const MAX_CORE_AGENT_CHARS = 26_000;
if (agent.length > MAX_CORE_AGENT_CHARS || agentNative.length > MAX_CORE_AGENT_CHARS) {
  throw new Error(`Prompt budget exceeded: core agent must be <= ${MAX_CORE_AGENT_CHARS} chars`);
}
console.log(`Mandatory prompt sections                    ${mandatorySections.length}/6 present`);
