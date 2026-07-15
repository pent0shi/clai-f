import chalk from "chalk";
import {
  createPlan,
  loadPlan,
  savePlan,
  markTask,
  type SessionPlan,
  type TaskState,
} from "../store/plan.js";
import { renderPlanChecklist } from "../ui/plan-pane.js";
import type { LoopGuard } from "./loop-guard.js";
import type { SessionPolicy } from "./session-policy.js";
import { isLumpedSingleTask } from "./tool-call-parser.js";
import type { ToolCall } from "../types.js";

/** Titles match for plan merge (exact or mutual long substring). */
export function titlesMatchForPlan(a: string, b: string): boolean {
  const t1 = a.trim().toLowerCase();
  const t2 = b.trim().toLowerCase();
  return (
    t1 === t2 ||
    (t1.length > 8 && t2.length > 8 && (t1.includes(t2) || t2.includes(t1)))
  );
}

/** Final coding-plan task: start server / probe localhost / leave running. */
export function looksLikeRunServerTask(title: string): boolean {
  const t = title.trim().toLowerCase();
  if (
    /\b(dev\s*server|npm\s+run\s+dev|pnpm\s+(run\s+)?dev|yarn\s+dev|bun\s+run\s+dev|shell\.start|localhost|leave\s+(it\s+)?running|verify\s+in\s+browser|open\s+in\s+browser|probe\s+(localhost|http)|http:\/\/localhost)\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (/\b(start|run)\b.+\b(server|dev|vite|next|preview)\b/.test(t)) return true;
  if (/\b(server|dev|vite|next|preview)\b.+\b(start|run|verify|tail|probe)\b/.test(t)) {
    return true;
  }
  // "run and verify" / "start app" style finals
  if (/\b(run|start)\b.+\b(app|verify)\b/.test(t) && /\b(server|dev|browser|localhost|url|port|job)\b/.test(t)) {
    return true;
  }
  return false;
}

export function looksLikeLocalAppScaffold(
  kind: string,
  goal: string,
  detail: string,
  tasks: string[],
): boolean {
  if (kind === "pentest") return false;
  const blob = `${kind} ${goal} ${detail} ${tasks.join(" ")}`.toLowerCase();
  // Pure libraries / CLIs with no server surface
  if (
    /\b(library|cli\b|command[- ]line|npm package|rust crate|go module)\b/.test(blob) &&
    !/\b(react|vite|next|vue|svelte|web\s*app|frontend|dev\s*server|localhost|todo\s*app|dashboard|spa)\b/.test(
      blob,
    )
  ) {
    return false;
  }
  if (kind === "coding") {
    // coding + no library-only signal → require run/verify when app-like
    return /\b(app|react|vite|next|vue|svelte|nuxt|angular|frontend|web|ui|todo|blog|dashboard|spa|server|localhost|scaffold)\b/.test(
      blob,
    );
  }
  return /\b(react|vite|next\.?js?|vue|svelte|nuxt|angular|web\s*app|frontend|spa|todo\s*app|blog\s*app|dashboard)\b/.test(
    blob,
  );
}

export function codingPlanNeedsRunVerifyTask(
  kind: string,
  goal: string,
  detail: string,
  tasks: string[],
): boolean {
  if (!looksLikeLocalAppScaffold(kind, goal, detail, tasks)) return false;
  return !tasks.some(looksLikeRunServerTask);
}

function looksLikeInstallTask(title: string): boolean {
  const t = title.toLowerCase();
  return (
    /\b(install|dependencies|deps|packages)\b/.test(t) &&
    !/\b(dev\s*server|localhost|probe|run\s+dev)\b/.test(t)
  );
}

function looksLikeScaffoldishTask(title: string): boolean {
  return /\b(scaffold|create|init|vite|next|bootstrap|cargo\s+new)\b/i.test(
    title,
  );
}

/**
 * Ensure coding app plans have an explicit install step after scaffold.
 * Avoids "implement blocked from npm install" + install attributed to wrong task.
 */
export function ensureCodingPlanInstallTask(
  kind: string,
  goal: string,
  detail: string,
  tasks: string[],
): string[] {
  if (!looksLikeLocalAppScaffold(kind, goal, detail, tasks)) return tasks;
  if (tasks.some(looksLikeInstallTask)) return tasks;
  if (!tasks.some(looksLikeScaffoldishTask)) return tasks;
  const out = [...tasks];
  const scaffoldIdx = out.findIndex(looksLikeScaffoldishTask);
  const insertAt = scaffoldIdx >= 0 ? scaffoldIdx + 1 : 0;
  out.splice(
    insertAt,
    0,
    "Install project dependencies (npm/yarn/pnpm/bun install in project root)",
  );
  return out;
}

/** Goal is only "run/start the existing app" — do not open a new plan. */
export function looksLikeRunOnlyGoal(goal: string, detail: string): boolean {
  const blob = `${goal} ${detail}`.toLowerCase();
  if (!/\b(run|start|launch|serve|dev\s*server|npm\s+run\s+dev)\b/.test(blob)) {
    return false;
  }
  // Exclude fresh scaffold goals
  if (/\b(scaffold|create|build|implement|add feature|from scratch|new app)\b/.test(blob)) {
    return false;
  }
  return /\b(existing|already|the app|dev server|server|verify|test it|open it)\b/.test(blob)
    || /^(run|start)\b/.test(blob.trim());
}

function nextTaskId(existingIds: string[]): string {
  let max = 0;
  for (const id of existingIds) {
    const m = /^t(\d+)$/i.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `t${max + 1}`;
}

/** Coerce model-sloppy plan.create fields into clean titles. */
function normalizePlanGoal(args: Record<string, unknown>): string {
  const raw = args.goal ?? args.objective ?? args.title ?? args.name;
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const k of ["title", "text", "goal", "name", "summary"]) {
      if (typeof o[k] === "string" && o[k]!.toString().trim()) {
        return String(o[k]).trim();
      }
    }
  }
  return "";
}

function normalizePlanDetail(args: Record<string, unknown>): string {
  const raw = args.detail ?? args.description ?? args.approach ?? args.notes;
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) {
    return raw
      .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
      .join("\n")
      .trim();
  }
  return "";
}

function normalizePlanKind(args: Record<string, unknown>): string {
  const raw = args.kind ?? args.type ?? args.category;
  if (typeof raw === "string" && raw.trim()) return raw.trim().toLowerCase();
  return "general";
}

function normalizeTaskTitle(t: unknown): string {
  if (typeof t === "string") return t.trim();
  if (typeof t === "number" && Number.isFinite(t)) return String(t);
  if (t && typeof t === "object") {
    const o = t as Record<string, unknown>;
    for (const k of [
      "title",
      "task",
      "name",
      "text",
      "description",
      "label",
      "step",
      "summary",
    ]) {
      if (typeof o[k] === "string" && o[k]!.toString().trim()) {
        return String(o[k]).trim();
      }
    }
  }
  return "";
}

export function slugifyTaskId(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

export interface NormalizedPlanTask {
  title: string;
  aliases: string[];
}

/**
 * Accept tasks as string[], object[], or a single newline/comma-separated string.
 * Models frequently emit `[{id,title}]` instead of plain strings.
 */
function normalizePlanTasks(args: Record<string, unknown>): string[] {
  return normalizePlanTaskEntries(args).map((t) => t.title);
}

/** Full entries including model-supplied id/name aliases (X3). */
export function normalizePlanTaskEntries(
  args: Record<string, unknown>,
): NormalizedPlanTask[] {
  const raw =
    args.tasks ?? args.steps ?? args.checklist ?? args.items ?? args.todos;
  if (typeof raw === "string") {
    return raw
      .split(/\n|;|(?:,\s*(?=[A-Z0-9\-]))/)
      .map((s) => s.replace(/^\s*[-*\d.)]+\s*/, "").trim())
      .filter(Boolean)
      .map((title) => ({ title, aliases: [] as string[] }));
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => {
      const title = normalizeTaskTitle(t);
      if (!title) return null;
      const aliases: string[] = [];
      if (t && typeof t === "object") {
        const o = t as Record<string, unknown>;
        for (const k of ["id", "taskId", "key", "slug"]) {
          if (typeof o[k] === "string" && o[k]!.toString().trim()) {
            aliases.push(String(o[k]).trim());
          }
        }
        // `name` is often the title; only alias if it differs.
        if (
          typeof o.name === "string" &&
          o.name.trim() &&
          o.name.trim().toLowerCase() !== title.toLowerCase()
        ) {
          aliases.push(o.name.trim());
        }
      }
      const slug = slugifyTaskId(title);
      if (slug && !aliases.includes(slug)) aliases.push(slug);
      return { title, aliases: [...new Set(aliases)] };
    })
    .filter((x): x is NormalizedPlanTask => Boolean(x));
}

/** Resolve model taskId (t1 or slug) to the canonical plan task id. */
export function resolvePlanTaskId(
  plan: SessionPlan,
  taskId: string,
): string | undefined {
  const raw = taskId.trim();
  if (!raw) return undefined;
  if (plan.tasks.some((t) => t.id === raw)) return raw;
  const lower = raw.toLowerCase();
  const slug = slugifyTaskId(raw);
  for (const t of plan.tasks) {
    if (t.aliases?.some((a) => a === raw || a.toLowerCase() === lower)) {
      return t.id;
    }
    if (slugifyTaskId(t.title) === slug) return t.id;
    if (
      slug.length > 4 &&
      (slugifyTaskId(t.title).includes(slug) ||
        slug.includes(slugifyTaskId(t.title)))
    ) {
      return t.id;
    }
  }
  return undefined;
}

/** Render the portable inline form; the Ink TUI owns its responsive sidebar. */
export function renderPlanForTerminal(plan: SessionPlan): string {
  return renderPlanChecklist(plan);
}

export interface PlanToolResult {
  handled: boolean;
  ok: boolean;
  plan?: SessionPlan | undefined;
  /** What to print to the user's terminal. */
  display: string;
  /** What to feed back to the model as the tool result. */
  modelNote: string;
}

/** Build the system-context block describing the session's active plan. */
export function planContextMessage(plan: SessionPlan, approved: boolean): string {
  const lines: string[] = [];
  lines.push(
    `ACTIVE PLAN for this session (goal: ${plan.goal}, status: ${plan.status}):`,
  );
  if (plan.detail.trim()) lines.push(plan.detail.trim());
  lines.push("Tasks:");
  plan.tasks.forEach((t, i) => {
    const aliasHint =
      t.aliases?.length && t.aliases[0] !== t.id
        ? ` [aliases: ${t.aliases.slice(0, 3).join(", ")}]`
        : "";
    lines.push(`  ${i + 1}. [${t.id}] (${t.state}) ${t.title}${aliasHint}`);
  });
  lines.push(
    "task.update taskId MUST be t1, t2, … from this list (or a listed alias) — never invent free-form slugs alone.",
  );
  if (approved) {
    const inProgress = plan.tasks.find((t) => t.state === "in_progress");
    const firstPending = plan.tasks.find((t) => t.state === "pending");
    lines.push("The user APPROVED this plan. Execute it task by task NOW.");
    if (inProgress) {
      lines.push(
        `RESUME TASK ${inProgress.id} (${inProgress.title}) — it was started but interrupted. ` +
          "Retry what was in progress; do NOT restart completed work from scratch. " +
          "Do NOT re-do tasks already marked done, and do NOT skip ahead to later tasks.",
      );
    } else if (firstPending) {
      lines.push(
        `START WITH TASK ${firstPending.id} (${firstPending.title}). ` +
          "Do NOT re-do tasks already marked done, and do NOT skip ahead to later tasks.",
      );
    }
    lines.push(
      "STRICT ORDER: call task.update {taskId, state:'in_progress'} → do the real work → " +
        "WAIT for and READ the tool result → only if you are satisfied it succeeded, " +
        "call task.update {taskId, state:'done'} → then open the NEXT task. " +
        "Never mark done before a successful tool result. Never start the next task's work " +
        "(or mark a later task in_progress) until the current one is done and verified. " +
        "If a tool fails, mark the task 'failed' with a note, fix, retry. " +
        "Never re-run tasks already marked done. " +
        "For run/verify: shell.start, leave server running, final message includes URL, port, and job id.",
    );
  } else {
    lines.push(
      "This plan is NOT yet approved, so you MUST NOT execute any of its tasks yet. " +
        "Any new free-text message from the user right now is a PLAN REVISION, not approval — even if it " +
        "sounds like an instruction (e.g. 'do not install new tools', 'use only X', 'also add Y', 'skip task 2'). " +
        "Treat it as feedback: call plan.create AGAIN with the revised goal/detail/tasks to produce an updated " +
        "plan, then STOP and wait. Do NOT call shell.exec, pkg.install, net.scan, tool.check, fs.write, or any " +
        "other execution tool. The user will APPROVE with /implement, or CANCEL with /discard. Only after " +
        "/implement may you begin executing.",
    );
  }
  return lines.join("\n");
}

/**
 * Handle plan.create / task.update inline. These are session-scoped and
 * persisted via the plan store so the user can view the plan (Ctrl+P) and
 * the agent keeps it in context across the whole session.
 */
export async function handlePlanTool(
  call: ToolCall,
  session: SessionPolicy,
  ctx: { loopGuard: LoopGuard; step: number },
): Promise<PlanToolResult> {
  void ctx;
  if (call.name === "plan.create") {
    const goal = normalizePlanGoal(call.args);
    const detail = normalizePlanDetail(call.args);
    const kind = normalizePlanKind(call.args);
    const taskEntries = normalizePlanTaskEntries(call.args);
    const taskTitles = taskEntries.map((t) => t.title);
    if (!goal || taskTitles.length === 0) {
      return {
        handled: true,
        ok: false,
        display: chalk.red(
          "  ✗ plan.create needs a non-empty goal and at least one task title\n",
        ),
        modelNote:
          "plan.create failed: provide a string goal and a non-empty tasks array. " +
          'Accepted task shapes: ["step 1","step 2"] or [{"title":"step 1"},{"id":"t1","title":"step 2"}]. ' +
          'Example: {"name":"plan.create","args":{"goal":"Assess example.com","detail":"…","tasks":["DNS enum","Port scan","HTTP fingerprint"],"kind":"pentest"}}',
      };
    }
    // Reject a low-quality "everything in one step" plan. A single task that
    // itself enumerates many files/actions (commas, "and", slashes) is a sign
    // the model lumped the whole build into one checkbox — split it so the
    // user gets a real, trackable checklist and the executor works step by step.
    if (isLumpedSingleTask(taskTitles)) {
      return {
        handled: true,
        ok: false,
        display: chalk.red(
          "  ✗ plan.create: that single task lumps the whole build into one step\n",
        ),
        modelNote:
          "plan.create rejected: you put everything into ONE task. Break it into 3-8 SEPARATE, " +
          "ordered tasks — each a distinct action, e.g. 'scaffold package.json + vite config', " +
          "'create index.html + entry (main.jsx)', 'build App + Post components', 'add posts data + styles', " +
          "'install deps and run dev server to verify'. Call plan.create again with that tasks array.",
      };
    }

    const existingPlan = await loadPlan(session.sessionId).catch(() => undefined);

    // X12: do not open a second full plan just to run an existing app.
    if (
      existingPlan &&
      (existingPlan.status === "completed" ||
        existingPlan.tasks.every(
          (t) =>
            t.state === "done" || t.state === "skipped" || t.state === "failed",
        )) &&
      looksLikeRunOnlyGoal(goal, detail)
    ) {
      return {
        handled: true,
        ok: false,
        display: chalk.yellow(
          "  ⚠ plan.create skipped — use tools to run the existing app\n",
        ),
        modelNote:
          "plan.create rejected: the previous plan is already finished and this goal is only run/verify. " +
          "Do NOT create a new plan or re-list old scaffold tasks. " +
          "Just shell.start the dev server, shell.tail until ready, probe localhost " +
          "(curl or http.fetch with iOwnThis:true), LEAVE the server running, and tell the user " +
          "the URL (http://localhost:<port>), port, and job id.",
      };
    }

    // X12: coding/local-app plans must include a final run/verify server task.
    if (codingPlanNeedsRunVerifyTask(kind, goal, detail, taskTitles)) {
      return {
        handled: true,
        ok: false,
        display: chalk.red(
          "  ✗ plan.create: coding app plan needs a final run/verify server task\n",
        ),
        modelNote:
          "plan.create rejected: for local web/app scaffolds (React/Vite/Next/etc.), tasks MUST end with a " +
          "final run/verify step — e.g. 'Start dev server (shell.start), tail until ready, probe localhost, " +
          "leave server running, report URL/port/job id'. Prefer shell.start (background); do not shell.stop " +
          "unless the user asks. Build alone is not enough. Add that final task and call plan.create again. " +
          "Pure libraries/CLIs with no server do not need this.",
      };
    }

    // Inject install step on fresh plans when model forgot it (avoids install
    // blocked under implement + wrong auto-start attribution). Skip rewrite on
    // merge/revise so completed task order stays stable.
    const normalizedTitles = existingPlan
      ? taskTitles
      : ensureCodingPlanInstallTask(kind, goal, detail, taskTitles);

    const plan = createPlan({
      sessionId: session.sessionId,
      goal,
      detail,
      taskTitles: normalizedTitles,
      kind,
    });
    // Attach model-supplied slug aliases so task.update can resolve them (X3).
    for (let i = 0; i < plan.tasks.length; i++) {
      const aliases = taskEntries[i]?.aliases ?? [];
      if (aliases.length) plan.tasks[i]!.aliases = aliases;
    }

    let additiveOnly = false;
    if (existingPlan) {
      const usedOldIds = new Set<string>();
      const mappedNewTasks = plan.tasks.map((task) => {
        const match = existingPlan.tasks.find(
          (t) =>
            !usedOldIds.has(t.id) && titlesMatchForPlan(t.title, task.title),
        );
        if (match) {
          usedOldIds.add(match.id);
          return {
            ...task,
            id: match.id,
            state: match.state,
            note: match.note,
          };
        }
        return task;
      });

      // Free ids for brand-new tasks (avoid clobbering preserved ids).
      const taken = new Set(mappedNewTasks.map((t) => t.id));
      for (const task of mappedNewTasks) {
        if (usedOldIds.has(task.id)) continue;
        if (
          existingPlan.tasks.some((t) => t.id === task.id) ||
          mappedNewTasks.filter((t) => t.id === task.id).length > 1
        ) {
          let id = nextTaskId([...taken]);
          while (taken.has(id)) id = nextTaskId([...taken, id]);
          task.id = id;
          taken.add(id);
        } else {
          taken.add(task.id);
        }
      }

      const oldTasksToKeep = existingPlan.tasks.filter(
        (oldTask) =>
          !mappedNewTasks.some((newTask) =>
            titlesMatchForPlan(oldTask.title, newTask.title),
          ),
      );

      plan.tasks = [...oldTasksToKeep, ...mappedNewTasks];

      // X7: keep approval when only additive pending work remains.
      const priorFinished = existingPlan.tasks.filter(
        (t) =>
          t.state === "done" || t.state === "skipped" || t.state === "failed",
      );
      const finishedStillFinished =
        priorFinished.length > 0 &&
        priorFinished.every((old) =>
          plan.tasks.some(
            (n) =>
              titlesMatchForPlan(old.title, n.title) &&
              (n.state === "done" ||
                n.state === "skipped" ||
                n.state === "failed"),
          ),
        );
      const hasNewPending = plan.tasks.some((t) => t.state === "pending");
      const noDoneReopened = !plan.tasks.some((n) => {
        const old = existingPlan.tasks.find((t) =>
          titlesMatchForPlan(t.title, n.title),
        );
        return (
          old &&
          (old.state === "done" || old.state === "skipped") &&
          n.state === "pending"
        );
      });
      additiveOnly =
        finishedStillFinished &&
        hasNewPending &&
        noDoneReopened &&
        (session.planApproved.value ||
          existingPlan.status === "approved" ||
          existingPlan.status === "in_progress" ||
          existingPlan.status === "completed");

      if (additiveOnly) {
        plan.status = "in_progress";
        plan.createdAt = existingPlan.createdAt;
      }
    }

    await savePlan(plan).catch(() => undefined);

    if (additiveOnly) {
      session.planApproved.value = true;
    } else {
      session.planApproved.value = false;
    }

    const checklist = renderPlanForTerminal(plan);
    const display = additiveOnly
      ? chalk.cyan("  ● plan updated (additive)\n") +
        checklist +
        "\n" +
        chalk.dim(
          "  ✦ done tasks preserved — continue from the first pending task only.\n" +
            "    Do NOT re-run completed scaffold/build work.\n",
        )
      : chalk.cyan("  ● planning\n") +
        checklist +
        "\n" +
        chalk.dim(
          "  ✦ plan created — press Ctrl+P to view it, /implement to approve and run it,\n" +
            "    or /discard to cancel it. Any other message refines this plan.\n",
        );

    const firstPending = plan.tasks.find((t) => t.state === "pending");
    return {
      handled: true,
      ok: true,
      plan,
      display,
      modelNote: additiveOnly
        ? `Plan updated with additive task(s); ${plan.tasks.filter((t) => t.state === "done" || t.state === "skipped").length} prior task(s) stay done. ` +
          "Do NOT re-execute completed tasks (no re-scaffold). " +
          (firstPending
            ? `Continue from [${firstPending.id}] "${firstPending.title}" only. `
            : "") +
          "If the only new work is run/verify on an existing app, prefer shell.start + probe + report URL — " +
          "do not reboot the world. When the run/verify task finishes, final message MUST include " +
          "http://localhost:<port>, port, job id, and that the server is still running."
        : `Plan saved with ${plan.tasks.length} task(s). STOP here and wait — produce NO other tool calls now. ` +
          "Do NOT start executing tasks until the user approves with /implement. " +
          "If the user's next message gives feedback instead of /implement, that is a REVISION: call plan.create " +
          "again with the updated plan and STOP again. The user may cancel the whole plan with /discard. " +
          "Only after /implement do you begin, working task by task, calling task.update to mark each " +
          "in_progress before and done after you finish it. " +
          "Do NOT call plan.create again only to add a run-dev-server step — put that in this plan's final task, " +
          "or after completion use shell.start + probe directly. " +
          "When run/verify completes: report URL, port, job id, and that the server is still running.",
    };
  }

  // task.update
  const plan = await loadPlan(session.sessionId).catch(() => undefined);
  if (!plan) {
    return {
      handled: true,
      ok: false,
      display: chalk.red(
        "  ✗ task.update: no active plan — call plan.create first\n",
      ),
      modelNote:
        "task.update failed: there is no active plan. Call plan.create first.",
    };
  }
  const taskIdRaw =
    typeof call.args.taskId === "string"
      ? call.args.taskId
      : typeof call.args.id === "string"
        ? call.args.id
        : "";
  const stateRaw = typeof call.args.state === "string" ? call.args.state : "";
  const note = typeof call.args.note === "string" ? call.args.note : undefined;
  const validStates: TaskState[] = [
    "pending",
    "in_progress",
    "done",
    "failed",
    "skipped",
  ];
  if (!validStates.includes(stateRaw as TaskState)) {
    return {
      handled: true,
      ok: false,
      display: chalk.red(
        `  ✗ task.update: state must be one of ${validStates.join(", ")}\n`,
      ),
      modelNote: `task.update failed: state must be one of ${validStates.join(", ")}.`,
    };
  }
  // X3: accept t1..tn or model slug aliases / title slugs.
  const taskId = resolvePlanTaskId(plan, taskIdRaw) ?? taskIdRaw;
  // Only one task may be in_progress at a time. This forces genuine
  // task-by-task execution: the model must close (done/failed/skipped) the
  // current task before opening the next one, instead of leaving a task
  // "in_progress" as an umbrella while it quietly works through the rest
  // of the plan underneath it.
  if (stateRaw === "in_progress") {
    const otherInProgress = plan.tasks.find(
      (t) => t.id !== taskId && t.state === "in_progress",
    );
    if (otherInProgress) {
      return {
        handled: true,
        ok: false,
        display: chalk.red(
          `  \u2717 task.update: task [${otherInProgress.id}] "${otherInProgress.title}" is still in_progress\n`,
        ),
        modelNote:
          `task.update failed: task [${otherInProgress.id}] "${otherInProgress.title}" is still in_progress. ` +
          "Finish it first \u2014 call task.update with state 'done' (or 'failed'/'skipped' with a note) " +
          `for [${otherInProgress.id}] before starting [${taskId}]. ` +
          "Use ONLY ids like t1, t2 from the plan context (not title slugs).",
      };
    }
  }
  // X8: cannot mark later task done while an earlier task is still open.
  if (stateRaw === "done") {
    const targetIdx = plan.tasks.findIndex((t) => t.id === taskId);
    if (targetIdx > 0) {
      const blocking = plan.tasks
        .slice(0, targetIdx)
        .filter(
          (t) =>
            t.state === "pending" ||
            t.state === "in_progress" ||
            t.state === "failed",
        );
      if (blocking.length > 0) {
        const b = blocking[0]!;
        return {
          handled: true,
          ok: false,
          display: chalk.red(
            `  ✗ task.update: cannot mark [${taskId}] done while [${b.id}] is ${b.state}\n`,
          ),
          modelNote:
            `task.update failed: cannot mark [${taskId}] done while earlier task ` +
            `[${b.id}] "${b.title}" is still ${b.state}. ` +
            `Finish or skip [${b.id}] first (state done/skipped), then mark [${taskId}] done.`,
        };
      }
    }
  }
  const ok = markTask(plan, taskId, stateRaw as TaskState, note);
  if (!ok) {
    const idMap = plan.tasks
      .map(
        (t) =>
          `${t.id}="${t.title}"` +
          (t.aliases?.length ? ` (also: ${t.aliases.join(", ")})` : ""),
      )
      .join("; ");
    return {
      handled: true,
      ok: false,
      display: chalk.red(
        `  ✗ task.update: unknown taskId "${taskIdRaw}" (have: ${plan.tasks.map((t) => t.id).join(", ")})\n`,
      ),
      modelNote:
        `task.update failed: unknown taskId "${taskIdRaw}". ` +
        `Valid ids (use these, not title text): ${idMap}.`,
    };
  }
  if (plan.status === "draft" || plan.status === "approved") {
    plan.status = "in_progress";
  }
  const allDone = plan.tasks.every(
    (t) => t.state === "done" || t.state === "skipped" || t.state === "failed",
  );
  if (allDone) plan.status = "completed";
  await savePlan(plan).catch(() => undefined);
  const checklist = renderPlanForTerminal(plan);
  const nextPending = plan.tasks.find((t) => t.state === "pending");
  let modelNote: string;
  if (allDone) {
    modelNote =
      "Task updated. ALL tasks are now finished. Verify the result and give your final summary. " +
      "If a dev server was started: report URL, port, job id, and that it is still running.";
  } else if (stateRaw === "done" && nextPending) {
    modelNote =
      `Task [${taskId}] marked done after verified work. ` +
      `NEXT: open only the next task with task.update {taskId:"${nextPending.id}", state:"in_progress"}, ` +
      `then do work for "${nextPending.title}" only. Wait for tool results before marking that one done. ` +
      "Do not batch later tasks. Do not start a later task's tools early.";
  } else if (stateRaw === "in_progress") {
    modelNote =
      `Task [${taskId}] is now in_progress. Do ONLY this task's work, wait for tool results, ` +
      `and mark done only when you are satisfied the results prove success. ` +
      `Then task.update {taskId:"${taskId}", state:"done"}. Do not open or work on later tasks yet.`;
  } else {
    modelNote = "Task updated. Continue with the next pending task.";
  }
  return {
    handled: true,
    ok: true,
    plan,
    display: checklist + "\n",
    modelNote,
  };
}
