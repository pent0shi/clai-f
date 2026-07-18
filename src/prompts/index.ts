import { existsSync, readFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { detectSystem } from "../os/detect.js";
import { EMBEDDED_PROMPTS } from "./embedded.js";
import { getActiveSessionScratchDir } from "../store/session-workspace.js";


/**
 * Absolute path the agent should use for scratch / engagement notes.
 *
 * When a session workspace is bound (normal TUI/REPL), this is the unique
 * per-session folder under `{tmpdir}/clai/{code}-{dd}-{mm}-{yyyy}-…}`.
 * Without a bound session (unit tests, early boot), fall back to a
 * project-name path so existing callers stay stable.
 */
export function scratchDirFor(cwd: string): string {
  const active = getActiveSessionScratchDir();
  if (active) return active;
  const name =
    (basename(cwd) || "session").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48) ||
    "session";
  return join(tmpdir(), "clai", name);
}

const PROMPTS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Load a system prompt template.
 *
 * Prefer the compile-time embedded copy so `bun build --compile` single-file
 * binaries (Homebrew/Scoop) work — sibling `.md` files are NOT present under
 * Bun's virtual FS (`/$bunfs/root/`). Fall back to reading the on-disk
 * markdown when developing with plain Node/tsx and the file exists.
 */
function loadPromptFile(filename: string): string {
  const embedded = EMBEDDED_PROMPTS[filename];
  if (typeof embedded === "string" && embedded.length > 0) {
    return embedded.replace(/\r\n/g, "\n");
  }
  const onDisk = join(PROMPTS_DIR, filename);
  if (existsSync(onDisk)) {
    return readFileSync(onDisk, "utf8").replace(/\r\n/g, "\n");
  }
  throw new Error(
    `Missing system prompt "${filename}". Re-run: node scripts/embed-prompts.mjs`,
  );
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

After a tool result, next call or concise final answer. tool.batch for independent reads (on_fail=continue by default; cancel_pending/rules when dependents need it). No tool calls inside thinking tags.

# WORKING RULES

- Inspect state before changing it. Preserve existing stack/style. Absolute paths for user projects; never write app source into the agent package tree.
- Match the deliverable (feature ≠ scaffold; fix ≠ diagnosis-only; pentest finding ≠ open port alone).
- Multi-step: create working tasks → implement → automated checks (typecheck/build/tests when applicable) → live verify. Local apps: shell.start, leave running, report URL + job id.
- Task cycle: in_progress → work → read results → done only when that task's outcome holds → next. Never mark done on hope after firing a command.
- Debug: repro → localize → hypothesis → minimal fix → re-run the failing check. Never stop at narrating the fix.
- Pentest: map surface (ports beyond top-N when needed, subdomains, content enum), threat-model, stack-matched tools, real PoCs, residual risk honesty. Background long scans and continue other work. No local dev server for remote targets.
- Images: inspect attachments (vision/OCR); try path + scratch copy before asking the user to re-save.
- Side effects: emit the tool; clai handles confirmation. Never bypass denials.
- Background long-lived work; web.search/web.fetch for current facts; cite tool URLs.
- Fail → understand → fix → retry. Report blockers plainly.
- Stay in scope; OS-correct commands for {{os}} / {{shell}}. Scratch under {{scratch}} only.
`

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

const agentNativeToolsHeader = `# TOOLS

You have structured tools provided by the API. Call them via the platform tool interface. Do not invent tool names. Prefer the most specific tool. Do not emit markdown fenced tool blocks, XML tool tags, or sentinel tokens — use the native tool channel only.

Available tool names: {{tool_list}}

# FILE POLICY

Read: small files → fs.read {path}. Large/unknown → expect auto-head; if hasMore, continue with footer next offset/limit (never path-only again). Need a symbol → pattern or fs.search then offset around hits. Lines are 1-indexed (N: text). Write: prefer one complete fs.write for new/full rewrites; fs.writeMany for scaffolds; fs.edit for surgical edits; fs.append only after truncation with expectedPriorBytes. Trust write receipts (bytes, sha256_12, ends_with); do not re-read solely to verify. Never claim a write without a successful tool result.

`;

/** Full native prompt: short native tool protocol + full argument encyclopedia. */
const agentPromptNative =
  sectionBefore(agentPrompt, "# TOOL CALLS — HOW TO USE TOOLS") +
  agentNativeToolsHeader +
  agentToolsCatalog +
  sectionFrom(agentPrompt, "# OPERATING RULES");

/**
 * E6 slim native: rely on API tool schemas for argument names; keep FILE POLICY
 * and OPERATING RULES. Omits the long fence-protocol tool encyclopedia so the
 * stable system prefix is smaller and cache-friendlier when native tools are on.
 */
const agentPromptNativeSlim =
  sectionBefore(agentPrompt, "# TOOL CALLS — HOW TO USE TOOLS") +
  agentNativeToolsHeader +
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
- fs.read: small path-only OK; large files auto-head — follow hasMore next={offset,limit}; use pattern or fs.search for symbols. Never invent unread lines.
- Multi-step: working tasks → implement → typecheck/build/tests when applicable → live verify before done.
- Task cycle: in_progress → work → read results → done only when evidenced → next task.
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
- tool.batch {"calls":[{"name":"web.fetch","args":{...}}, ...],"concurrency":<1-6 optional>,"on_fail":"continue|cancel_pending"} — up to 20 read-only lookups; default on_fail=continue.
- fs.read {"path":"<file>","offset"|"startLine":<opt>,"limit":<opt>,"endLine":<opt>,"pattern":"<regex|/re/i>"} — small files full; large files auto-head (follow hasMore next offset — do not re-call path-only). Prefer pattern/range for big files. / fs.list {"path":"<dir>"} / fs.search {"pattern":"<regex>","path":"<dir>"} — path:line:text hits then fs.read around them.
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

/**
 * Environment clock for system prompts.
 *
 * Hour-stable on purpose: agent loops re-render the system prompt every step.
 * Second-precision ISO timestamps busted provider prompt-cache prefixes with no
 * capability gain (models only need current day/year for freshness queries).
 * Minutes/seconds are omitted so consecutive steps within the same local hour
 * produce an identical constitution string when nothing else changed.
 */
export function currentDateTimeContext(now = new Date()): string {
  const floored = floorToLocalHour(now);
  const local = floored.toLocaleString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
  // Floor ISO to the hour (UTC) so the string is stable across re-renders.
  const isoHour = `${floored.toISOString().slice(0, 13)}:00:00.000Z`;
  return `${local} (ISO hour: ${isoHour})`;
}

/** Local-hour floor used by {@link currentDateTimeContext} (exported for tests). */
export function floorToLocalHour(now: Date): Date {
  const d = new Date(now.getTime());
  d.setMinutes(0, 0, 0);
  return d;
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
  options?: {
    nativeTools?: boolean;
    /**
     * E6: omit long tool-arg encyclopedia when native schemas are attached.
     * Defaults to true when nativeTools is true (overridable via config /
     * CLAI_SLIM_NATIVE_PROMPT when callers pass nothing).
     */
    slimNative?: boolean;
  },
): string {
  const system = detectSystem();
  let template = agentPrompt;
  if (options?.nativeTools) {
    const slim =
      options.slimNative !== undefined
        ? options.slimNative
        : true;
    template = slim ? agentPromptNativeSlim : agentPromptNative;
  }
  return render(template, {
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

/** Injected when REPL mode is plan — deep research + comprehensive durable plan. */
export function planModeDirective(): string {
  return [
    "PLAN MODE — research and design a durable plan. Do not implement or fully exploit yet.",
    "Plan mode is NOT agent-mode task execution. Tasks you create are the roadmap the user accepts before build/exploit work.",
    "",
    "Time budget (research is unlimited; the deliverable is the plan):",
    "- You may take as many steps and as much time as you need to gather context: learn attack surface, stack, interesting features/areas, constraints, and success definition.",
    "- Research exists to inform a high-quality comprehensive plan — not to finish every test/exploit/report before plan.create.",
    "- Do not rush a thin plan. When research is sufficient for a high-quality roadmap, present plan.create rather than continuing indefinitely.",
    "",
    "How to research then plan (give full effort):",
    "- Prefer evidence: workspace/stack inspection, recon, docs, web.search for current APIs/CVEs/techniques when facts may be stale.",
    "- Consider alternatives, risks, edge cases, dependency order, and verification for each step.",
    "- For pentest: map surface thoroughly — ports (escalate beyond top-N when needed), subdomains, content/API enum, JS harvest, tech fingerprint, auth surfaces (nmap, ffuf, dig, http.fetch, shell.start long scans, …). Background long scans; continue other recon.",
    "- Capture confirmed unauth findings in plan detail as evidence; put remaining auth’d testing, exploit chains, and final report polish in tasks for after accept.",
    "- Do not scaffold, write project files, or run active C2/destructive exploits. Put implement/exploit steps as plan tasks for after accept.",
    "",
    "When context is enough, call plan.create once with:",
    "- goal + rich detail (context found, approach, architecture/threat model, risks, how each phase is verified)",
    "- a complete ordered task list (any count; only real work; no filler) covering remaining build/test/verify or test→exploit→report work as appropriate",
    "- for software: implement, automated checks, and live/runtime verification as separate tasks when they are distinct work",
    "After plan.create, STOP for accept / discard / view / suggest. Prefer evidence-based plans.",
  ].join("\n");
}

/** Injected when REPL mode is agent — execute with working tasks, verify before done. */
export function agentModeDirective(): string {
  return [
    "AGENT MODE — execute until the user's real success condition is evidenced.",
    "Tasks here are YOUR working checklist (not a user-facing plan document). They keep multi-phase work honest.",
    "",
    "Task discipline (agent mode):",
    "- For non-trivial work (multi-file feature, new app, pentest engagement, multi-step fix): decompose the goal into concrete outcome-titled tasks early, then work them. Skip task lists only for trivial one-shots.",
    "- Prefer more small, checkable tasks over one vague mega-task. No artificial cap; only relevant items.",
    "- Cycle for each task: task.update(in_progress) → run the real tools/commands → READ and analyze every result → if the task outcome is satisfied, task.update(done) and open the next task immediately; if not, keep working that task (fix, retry, change approach) until it is, then mark done.",
    "- Never mark done on hope or right after firing a command. Done means you saw evidence that this task's outcome holds.",
    "- Do not stop at thin proxies (scaffold without the feature, ports without tested findings, build without the requested behavior).",
    "",
    "Build / ship software:",
    "- After implementing: run stack checks that apply (typecheck, build, unit/integration tests). Fix failures before claiming success.",
    "- Then live/runtime verification when applicable (start app, probe routes/UI, leave server running, report URL + job id).",
    "- Only then tell the user it works — with what you actually observed.",
    "",
    "Long jobs: background them and continue other useful work. Prefer fixing failures over narrating them. Change approach after repeated identical failures.",
  ].join("\n");
}
