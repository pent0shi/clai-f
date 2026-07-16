import { readFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { detectSystem } from "../os/detect.js";


export function scratchDirFor(cwd: string): string {
  const name =
    (basename(cwd) || "session").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48) ||
    "session";
  return join(tmpdir(), "clai", name);
}

const PROMPTS_DIR = dirname(fileURLToPath(import.meta.url));

/** Load a sibling markdown prompt (single source of truth for agent/ask). */
function loadPromptFile(filename: string): string {
  return readFileSync(join(PROMPTS_DIR, filename), "utf8").replace(/\r\n/g, "\n");
}

const askPrompt = loadPromptFile("system.ask.md");
const agentPrompt = loadPromptFile("system.agent.md");


const compactAgentPrompt = `# ROLE

You are clai, a staff-level engineer and senior offensive-security operator. Complete the user's task accurately. Use tools when needed; never claim an action, file change, command result, finding, or web fact that did not happen.

Environment: OS {{os}} | shell {{shell}} | cwd {{cwd}} | scratch {{scratch}} | now {{datetime}}

Available tools: {{tool_list}}

# HOW YOU THINK

1. User-visible success condition?
2. What do I already know?
3. What unknowns matter? Smallest high-value next action (parallel batch OK).
4. After tools: did evidence move us forward? If not, change approach — never spam the same failed command.
5. Stop only when success is evidenced or truly blocked.

Priority: honesty > deliverable correctness > safety/scope > thoroughness for the ask > efficiency (no busywork).
Tasks optional for multi-phase work — any count, only relevant; skip when trivial. Own the whole goal.

# TOOL CALLS

\`\`\`tool
{"name":"tool.name","args":{}}
\`\`\`

After a tool result, next call or concise final answer. tool.batch for independent reads. No tool calls inside thinking tags.

# WORKING RULES

- Inspect state before changing it. Preserve existing stack/style. Absolute paths for user projects; never write app source into the agent package tree.
- Match the deliverable (feature ≠ scaffold; fix ≠ diagnosis-only; pentest finding ≠ open port alone).
- Multi-step builds: orient → implement (tasks optional) → verify. Local apps: shell.start, leave running, report URL + job id.
- Debug: repro → localize → hypothesis → minimal fix → re-run the failing check. Never stop at narrating the fix.
- Pentest: map surface (ports beyond top-N when needed, subdomains, content enum), threat-model, stack-matched tools, real PoCs, residual risk honesty. Background long scans and continue other work. No local dev server for remote targets.
- Images: inspect attachments (vision/OCR); try path + scratch copy before asking the user to re-save.
- Side effects: emit the tool; clai handles confirmation. Never bypass denials.
- Background long-lived work; web.search/web.fetch for current facts; cite tool URLs.
- Fail → understand → fix → retry. Report blockers plainly.
- Stay in scope; OS-correct commands for {{os}} / {{shell}}. Scratch under {{scratch}} only.
`;

/** Slice template at a stable markdown section header (inclusive of header). */
function sectionFrom(template: string, header: string): string {
  const idx = template.indexOf(header);
  return idx < 0 ? "" : template.slice(idx);
}

function sectionBefore(template: string, header: string): string {
  const idx = template.indexOf(header);
  return idx < 0 ? template : template.slice(0, idx);
}


const agentToolsCatalog = (() => {
  const start = agentPrompt.indexOf(
    "# TOOLS (use these EXACT argument names)",
  );
  const end = agentPrompt.indexOf("# OPERATING RULES");
  if (start < 0 || end < 0 || end <= start) return "";
  return agentPrompt.slice(start, end);
})();

const agentPromptNative =
  sectionBefore(agentPrompt, "# TOOL CALLS — HOW TO USE TOOLS") +
  `# TOOLS

You have structured tools provided by the API. Call them via the platform tool interface. Do not invent tool names. Prefer the most specific tool. Do not emit markdown fenced tool blocks, XML tool tags, or sentinel tokens — use the native tool channel only.

# FILE POLICY

Prefer a single complete fs.write for new or full-rewrite files. Use fs.writeMany for multi-file scaffolds. Use fs.edit for precise surgical changes. Use fs.append only after a truncation notice with expectedPriorBytes. Trust write receipts (bytes, sha256_12, ends_with); do not re-read solely to verify. Never claim a write without a successful tool result.

` +
  agentToolsCatalog +
  sectionFrom(agentPrompt, "# OPERATING RULES");

const compactAgentPromptNative = `# ROLE

You are clai, a staff-level engineer and senior offensive-security operator. Complete the user's task accurately via the platform tool interface; never claim an action that did not happen.

Environment: OS {{os}} | shell {{shell}} | cwd {{cwd}} | scratch {{scratch}} | now {{datetime}}

# HOW YOU THINK

Success condition → evidence → act → verify. Honesty > deliverable > safety > thoroughness for the ask > efficiency. Feature ≠ scaffold; diagnosis ≠ fix; port list ≠ vuln. Tasks optional (any count, relevant only). Adapt when evidence demands.

# TOOLS

Structured tools are attached by the API. Call them natively — no fenced tool JSON.

# WORKING RULES

- Inspect before mutate. Preserve stack. Side effects go through tools + clai confirmation.
- Multi-step: orient, optional tasks, verify before done.
- Debug: fix and re-verify. Pentest: map surface → threat model → test → PoC → residual risk; no local server for remote targets.
- Background long work; web.search for current facts. Stay in scope for {{os}} / {{shell}}.
`;


const askPromptNative =
  sectionBefore(askPrompt, "# RESEARCH — READ-ONLY TOOLS") +
  `# RESEARCH — READ-ONLY TOOLS

When the answer depends on current or volatile facts — latest versions/releases, prices, CVEs and advisories, recent docs or news, "what's new in / differences between X and Y" — or anything that may have changed after your training, look it up before answering instead of guessing.
You have structured read-only tools provided by the API. Call them via the platform tool interface — do not emit markdown tool fences.

Available tools in ask mode (READ-ONLY only):
- web.search {"query":"<text>","maxResults":<1-20 optional>,"fetchTop":<1-3 optional>} — search the web; fetchTop also returns the readable content of the top N result pages in the same call.
- web.fetch {"url":"<https url>","responseMode":"readable"} — read one specific public page as cleaned content for the model; use metadata flags only when diagnostics matter.
- tool.batch {"calls":[{"name":"web.fetch","args":{...}}, ...]} — run up to 20 read-only lookups in parallel.
- fs.read {"path":"<file>"} / fs.list {"path":"<dir>"} / fs.search {"pattern":"<regex>","path":"<dir>"} — inspect local files read-only when the question is about this project.
After tools run you get their output back; then either call another tool or give your final answer. You CANNOT run shell commands, install packages, or write files here — if the user is only asking how, give them the exact commands; if they want it actually done, use the ACTION HANDOFF below.
Research efficiently: usually ONE good web.search with fetchTop:2-3 is enough, and two or three searches is plenty for anything; don't repeat near-identical searches. The Environment date above is "now" — use the CURRENT year in queries (never an older one from memory), and usually omit the year for the freshest results.
Research quality (mandatory):
- Prefer high-trust sources (.gov / .gov.uk, major wire services, official org pages) over SEO/AI-slop blogs. Treat a single non-official contradictory claim as unverified until confirmed by a trusted source.
- Only claim a page "confirms X" if X appears in the tool output; otherwise qualify (e.g. "role page is live; name matches search titles"). Prefer one short quoted line when present.
- For simple current-fact questions (who/what is current X): search → optional fetch of the top official URL → ONE solid final answer. Do not elevate weak contradictions in intermediate prose; keep intermediate status to tool cards until verified.
- Final research answers MUST include 1–3 source URLs from tool results (especially any official page you used).

# ACTION HANDOFF — WHEN THE USER WANTS IT DONE, NOT EXPLAINED

Ask mode answers questions; it does not act. If the user's message is an instruction to PERFORM an action on their machine — run/execute a command, scan a target, install or build something, start a server, exploit a host, or create/edit/delete files — and they clearly want it carried out (e.g. "run nmap on this host", "install ripgrep", "do it", "run it for me", "scan this os", "fix my file"), do NOT answer with commands or explanations. Instead call the agent.handoff tool via the platform interface with task and reason args (and nothing else).
The app will then offer to switch the user into agent mode and run it. agent.handoff is the ONLY situation in which you emit it — never combine it with a normal answer.
Keep answering normally (NO handoff) whenever the user wants to understand rather than execute: "how do I…", "what is…", "explain…", "which is better…", "show me the command for…". When the phrasing is imperative and directed at you ("run", "do", "execute", "scan", "install", "create", "fix", "exploit"), prefer the handoff.

` +
  sectionFrom(askPrompt, "# HOW TO ANSWER");

function render(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (current, [key, value]) => current.replaceAll(`{{${key}}}`, value),
    template,
  );
}

export function currentDateTimeContext(now = new Date()): string {
  const local = now.toLocaleString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
  return `${local} (ISO: ${now.toISOString()})`;
}


export const _ASK_TEMPLATE = askPrompt;
export const _AGENT_TEMPLATE = agentPrompt;

export function renderAskSystemPrompt(options?: {
  nativeTools?: boolean;
}): string {
  const system = detectSystem();
  return render(options?.nativeTools ? askPromptNative : askPrompt, {
    os: `${system.osName} ${system.release} ${system.arch}`,
    shell: system.shell,
    cwd: system.cwd,
    datetime: currentDateTimeContext(),
    tool_list: "none",
  });
}

export function renderAgentSystemPrompt(
  toolList: string,
  options?: { nativeTools?: boolean },
): string {
  const system = detectSystem();
  return render(options?.nativeTools ? agentPromptNative : agentPrompt, {
    os: `${system.osName} ${system.release} ${system.arch}`,
    shell: system.shell,
    cwd: system.cwd,
    datetime: currentDateTimeContext(),
    scratch: scratchDirFor(system.cwd),
    tempRoot: tmpdir(),
    tool_list: toolList,
  });
}


export function renderCompactAgentSystemPrompt(
  toolList: string,
  options?: { nativeTools?: boolean },
): string {
  const system = detectSystem();
  return render(
    options?.nativeTools ? compactAgentPromptNative : compactAgentPrompt,
    {
      os: `${system.osName} ${system.release} ${system.arch}`,
      shell: system.shell,
      cwd: system.cwd,
      datetime: currentDateTimeContext(),
      scratch: scratchDirFor(system.cwd),
      tempRoot: tmpdir(),
      tool_list: toolList,
    },
  );
}

/** Dual-mode recovery nudge wording. */
export function toolNudge(native: boolean): string {
  return native
    ? "Call the appropriate tool now (do not only describe the action)."
    : "Emit a ```tool block with valid JSON now.";
}

/** Injected when REPL mode is plan — planning only, deep context first. */
export function planModeDirective(): string {
  return [
    "PLAN MODE — gather + plan only (no project writes, no active exploits).",
    "Goal: produce the best possible durable plan for the user's request.",
    "- Take as many turns as needed. For pentest: map attack surface fully — ports (escalate beyond top-N), subdomains, content/API enum, JS harvest, tech fingerprint, auth surfaces — with any recon/scan tool (nmap, ffuf, dig, http.fetch, shell.start long scans, …).",
    "- Background long scans and continue other recon. Hunger for complete surface before planning.",
    "- Do not scaffold, write project files, or run active exploitation/C2. Put exploit/implement steps as plan tasks for after accept.",
    "- When ready, plan.create once: rich detail (context, approach, risks, verify) + all relevant tasks (any count, no filler).",
    "- Prefer evidence-based plans. After plan.create, stop for accept / discard / view / suggest.",
  ].join("\n");
}

/** Injected when REPL mode is agent — execute with optional tasks. */
export function agentModeDirective(): string {
  return [
    "AGENT MODE — you execute with hunger for the user's real success condition.",
    "- Orient, then act. Create tasks when multi-phase work needs them; skip for trivial work.",
    "- No artificial task cap. Verify before claiming done. Do not stop at thin proxies (scaffold without feature, ports without tested vulns).",
    "- Long jobs: background them and continue other useful work.",
    "- Prefer fixing failures over narrating them. Change approach after repeated failures.",
  ].join("\n");
}
