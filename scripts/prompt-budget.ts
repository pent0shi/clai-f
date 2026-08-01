/**
 * Print rendered agent/ask system prompt sizes (chars + rough token estimate).
 * Usage: npx tsx scripts/prompt-budget.ts
 */
import {
  renderAgentSystemPrompt,
  renderAskSystemPrompt,
  renderCompactAgentSystemPrompt,
  renderRequestEnvironmentContext,
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

const agent = renderAgentSystemPrompt(tools, { stableEnvironment: true });
const agentNative = renderAgentSystemPrompt(tools, {
  nativeTools: true,
  stableEnvironment: true,
});
const agentPentest = renderAgentSystemPrompt(tools, {
  stableEnvironment: true,
  pentest: true,
});
const agentNativePentest = renderAgentSystemPrompt(tools, {
  nativeTools: true,
  stableEnvironment: true,
  pentest: true,
});
const compact = renderCompactAgentSystemPrompt(tools, {
  stableEnvironment: true,
});
const ask = renderAskSystemPrompt({ stableEnvironment: true });
const requestEnvironment = renderRequestEnvironmentContext();

const buildTurn =
  agent +
  "\n\n" +
  requestEnvironment +
  "\n\n" +
  buildWorkflowDirective() +
  "\n\n" +
  formatTaskAnalysisHint(analyzeTask("create a react todo app on Desktop"));

const pentestTurn =
  agentPentest +
  "\n\n" +
  requestEnvironment +
  "\n\n" +
  pentestWorkflowDirective() +
  "\n\n" +
  pentestNoLocalServerDirective() +
  "\n\n" +
  formatTaskAnalysisHint(analyzeTask("pentest example.com"));

console.log("clai prompt budget (chars/4 ≈ tokens)\n");
report("agent (fence)", agent);
report("agent (fence, pentest)", agentPentest);
report("agent (native tools)", agentNative);
report("agent (native tools, pentest)", agentNativePentest);
report("agent compact", compact);
report("ask", ask);
report("request environment suffix", requestEnvironment);
report("buildWorkflowDirective", buildWorkflowDirective());
report("pentestWorkflowDirective", pentestWorkflowDirective());
report("typical BUILD turn (sys+directives)", buildTurn);
report("typical PENTEST turn (sys+directives)", pentestTurn);
console.log(
  "\nTargets: core agent ~8–9k tok; build/pentest injects focused workflow directives.",
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

// Per-variant ceilings. The everyday paths (no pentest methodology attached)
// are held tightest because they are what most turns actually pay for.
for (const [label, text, limit] of [
  ["fence", agent, 35_000],
  ["fence+pentest", agentPentest, 39_000],
  ["native", agentNative, 22_000],
  ["native+pentest", agentNativePentest, 26_000],
] as const) {
  if (text.length > limit) {
    throw new Error(
      `Prompt budget exceeded: core agent (${label}) is ${text.length} chars, must be <= ${limit}`,
    );
  }
}

// The methodology block must be attached for a pentest turn and absent otherwise.
if (!agentPentest.includes("# PENTEST METHODOLOGY")) {
  throw new Error("Prompt contract failure: pentest turn lost the methodology block");
}
if (agent.includes("# PENTEST METHODOLOGY")) {
  throw new Error("Prompt budget failure: non-pentest turn still carries the methodology block");
}
if (!agentNativePentest.includes("# PENTEST METHODOLOGY")) {
  throw new Error("Prompt contract failure: native pentest turn lost the methodology block");
}
console.log(`Mandatory prompt sections                    ${mandatorySections.length}/6 present`);
