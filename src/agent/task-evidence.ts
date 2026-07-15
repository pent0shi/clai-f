import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolCall } from "../types.js";
import { getActiveProjectRoot } from "./project-root.js";

/**
 * Tracks successful non-meta tool work under the currently open plan task.
 * Models (esp. GPT-OSS) must not mark done or jump ahead without real
 * evidence from tool results this task has already received.
 */
export interface TaskWorkLedger {
  taskId: string;
  /** Successful work tools since this task became in_progress. */
  successWorkCount: number;
  lastOkTool?: string | undefined;
}

export function isMetaPlanTool(name: string): boolean {
  return name === "plan.create" || name === "task.update" || name === "agent.handoff";
}

/** Tools that count as real work/verify evidence for the open task. */
export function isEvidenceWorkTool(name: string): boolean {
  return !isMetaPlanTool(name);
}

export function recordTaskWorkSuccess(
  ledger: TaskWorkLedger | null,
  taskId: string | undefined,
  toolName: string,
): TaskWorkLedger | null {
  if (!taskId || !isEvidenceWorkTool(toolName)) return ledger;
  if (!ledger || ledger.taskId !== taskId) {
    return { taskId, successWorkCount: 1, lastOkTool: toolName };
  }
  return {
    taskId,
    successWorkCount: ledger.successWorkCount + 1,
    lastOkTool: toolName,
  };
}

export function openTaskLedger(taskId: string): TaskWorkLedger {
  return { taskId, successWorkCount: 0 };
}

export function canMarkTaskDone(
  ledger: TaskWorkLedger | null,
  taskId: string,
): { ok: true } | { ok: false; reason: string } {
  if (!ledger || ledger.taskId !== taskId) {
    return {
      ok: false,
      reason:
        `Cannot mark [${taskId}] done: no work ledger for this task. ` +
        `Call task.update {taskId:"${taskId}", state:"in_progress"}, do the real work, ` +
        `inspect the tool result, and only then mark done if you are satisfied.`,
    };
  }
  if (ledger.successWorkCount < 1) {
    return {
      ok: false,
      reason:
        `Cannot mark [${taskId}] done: no successful tool result observed since it went in_progress. ` +
        `Do the work, wait for the tool output, verify it succeeded, and only mark done when satisfied. ` +
        (ledger.lastOkTool
          ? ""
          : "Example: fs.write / shell.exec / shell.start must return ok first."),
    };
  }
  return { ok: true };
}

function commandOf(call: ToolCall): string {
  return typeof call.args.command === "string" ? call.args.command : "";
}

/** One-shot scaffolders — must NEVER be treated as "start the dev server". Stack-agnostic. */
export function isScaffoldCreateCommand(cmd: string): boolean {
  return /\b(?:npm\s+create|npm\s+init|yarn\s+create|pnpm\s+create|bun\s+create|npx\s+(?:--yes\s+)?create-[\w-]+|create-vite|create-next-app|create-react-app|cargo\s+new|cargo\s+init|go\s+mod\s+init|poetry\s+new|django-admin\s+startproject|rails\s+new|composer\s+create-project|mix\s+new|flutter\s+create|dotnet\s+new)\b/i.test(
    cmd,
  );
}

/**
 * True only for actually running a long-lived dev server — not create-vite /
 * npm create which merely contain the word "vite".
 */
export function isDevServerCall(call: ToolCall): boolean {
  const cmd = commandOf(call);
  if (isScaffoldCreateCommand(cmd)) return false;

  if (call.name === "shell.start") {
    // Explicit background job is usually a server; still exclude create-*.
    if (!cmd) return true;
    return (
      /\bnpm\s+run\s+dev\b|\byarn\s+dev\b|\bpnpm\s+(run\s+)?dev\b|\bbun\s+(run\s+)?dev\b|\bnext\s+dev\b|\bnuxt\s+dev\b|\bcargo\s+watch\b|\bflask\s+run\b|\buvicorn\b|\bgunicorn\b|\brails\s+s(?:erver)?\b|\bdjango(-admin)?\s+runserver\b|\bdotnet\s+run\b|\bgo\s+run\b/i.test(
        cmd,
      ) ||
      // bare `vite` / `vite --host` as the process — not `create vite`
      /(?:^|[;&|]\s*)vite(?:\s|$)/i.test(cmd) ||
      /\b(python3?\s+-m\s+http\.server|php\s+-S)\b/i.test(cmd)
    );
  }

  return (
    /\bnpm\s+run\s+dev\b|\byarn\s+dev\b|\bpnpm\s+(run\s+)?dev\b|\bbun\s+(run\s+)?dev\b|\bnext\s+dev\b|\bnuxt\s+dev\b|\brails\s+s(?:erver)?\b|\bdjango(-admin)?\s+runserver\b/i.test(
      cmd,
    ) || /(?:^|[;&|]\s*)vite(?:\s|$)/i.test(cmd)
  );
}

/** Preflight / inspect tools allowed before the model opens a task. */
export function isPlanPreflightTool(name: string): boolean {
  return (
    name === "tool.check" ||
    name === "sysinfo" ||
    name === "fs.list" ||
    name === "fs.read" ||
    name === "fs.search" ||
    name === "net.context"
  );
}

/**
 * Tools allowed on a coding BUILD turn before plan.create exists.
 * Explore + optional web research + plan — no scaffold/write/install freestyle.
 */
export function isBuildPrePlanAllowedTool(name: string): boolean {
  return (
    name === "plan.create" ||
    isPlanPreflightTool(name) ||
    name === "tool.batch" ||
    name === "fs.search" ||
    // Research before planning (docs/examples) is fine; it does not mutate the project
    name === "web.search" ||
    name === "web.fetch"
  );
}

/**
 * Commands that legitimately sit quiet for minutes (npm install, create-next-app).
 * Must not be killed by the short "no output" stall watchdog.
 */
export function isLongQuietInstallOrScaffoldCommand(cmd: string): boolean {
  if (!cmd.trim()) return false;
  if (isScaffoldCreateCommand(cmd)) return true;
  return (
    /\b(?:npm|pnpm|yarn|bun)\s+i(?:nstall)?\b/i.test(cmd) ||
    /\b(?:npm|pnpm|yarn|bun)\s+(?:ci|update)\b/i.test(cmd) ||
    /\bpip(?:3)?\s+install\b/i.test(cmd) ||
    /\bpoetry\s+install\b/i.test(cmd) ||
    /\bcomposer\s+install\b/i.test(cmd) ||
    /\bbundle\s+install\b/i.test(cmd) ||
    /\bcargo\s+(?:build|fetch|install)\b/i.test(cmd) ||
    /\bgo\s+mod\s+(?:download|tidy)\b/i.test(cmd) ||
    /\bdotnet\s+restore\b/i.test(cmd)
  );
}

/** Stall watchdog budget: scaffold/install can be silent for a long time. */
export function toolStallBudgetMs(call: {
  name: string;
  args: Record<string, unknown>;
}): number {
  const cmd = typeof call.args.command === "string" ? call.args.command : "";
  if (call.name === "pkg.install") return 10 * 60_000;
  if (
    (call.name === "shell.exec" || call.name === "shell.start") &&
    isLongQuietInstallOrScaffoldCommand(cmd)
  ) {
    return 15 * 60_000; // create-next-app + npm install often 2–10+ min with quiet stretches
  }
  return 60_000;
}

/** Harmless version/which probes models use instead of tool.check before planning. */
export function isReadOnlyVersionProbeCommand(cmd: string): boolean {
  const c = cmd.trim();
  if (!c || /[;&|`]/.test(c)) return false; // no chains
  return (
    /^(?:node|nodejs|npm|npx|pnpm|yarn|bun|deno|python3?|pip3?|go|rustc|cargo|ruby|php|java|dotnet|flutter|swift)\s+(?:-v|--version|version)\s*$/i.test(
      c,
    ) || /^(?:which|command\s+-v|type)\s+[A-Za-z0-9._-]+\s*$/i.test(c)
  );
}

/**
 * Multi-step coding builds must plan before mutate (scaffold/write/install).
 * Trivial one-liners and non-build prompts skip this.
 */
export function codingBuildRequiresPlan(
  prompt: string,
  opts?: { informational?: boolean; idle?: boolean; pentest?: boolean },
): boolean {
  if (opts?.informational || opts?.idle || opts?.pentest) return false;
  const p = prompt.trim();
  if (!p) return false;
  // Explicit single-file micro edits can skip the plan
  if (
    p.length < 100 &&
    /\b(fix|typo|rename|bump|tweak)\b/i.test(p) &&
    !/\b(app|project|scaffold|create|build|todo|blog)\b/i.test(p)
  ) {
    return false;
  }
  return true; // caller already checked looksLikeBuildTask
}

function isLocalHttpProbe(call: ToolCall): boolean {
  const blob = `${call.name} ${commandOf(call)} ${JSON.stringify(call.args)}`;
  return (
    /\b(localhost|127\.0\.0\.1)\b/i.test(blob) &&
    (call.name === "shell.exec" ||
      call.name === "http.fetch" ||
      call.name === "web.fetch" ||
      /\bcurl\b/i.test(blob))
  );
}

export function looksLikeInstallTaskTitle(title: string): boolean {
  const t = title.toLowerCase();
  return (
    /\b(install|dependencies|deps|packages)\b/.test(t) &&
    !/\b(dev\s*server|localhost|probe|run\s+dev)\b/.test(t)
  );
}

export function looksLikeScaffoldTaskTitle(title: string): boolean {
  const t = title.toLowerCase();
  return (
    /\b(scaffold|create-vite|create vite|create-next|init project|bootstrap|cargo\s+new|rails\s+new|poetry\s+new)\b/.test(
      t,
    ) ||
    (/\b(create|init|generate)\b/.test(t) &&
      /\b(project|app|package|crate|module|vite)\b/.test(t) &&
      !/\b(feature|component|endpoint|todo|style|persist)\b/.test(t))
  );
}

export function isPackageInstallCommand(cmd: string): boolean {
  return /\bnpm\s+i(nstall)?\b|\byarn\s+install\b|\bpnpm\s+i(nstall)?\b|\bbun\s+install\b|\bpip\s+install\b|\bpoetry\s+install\b|\bcargo\s+build\b|\bcomposer\s+install\b|\bbundle\s+install\b|\bgo\s+mod\s+tidy\b/.test(
    cmd,
  );
}

/**
 * Soft scope check: refuse run/verify tools while the open task is only
 * scaffold / implement / install.
 * When `planTaskTitles` is provided, install is only blocked on implement
 * tasks if the plan actually has a dedicated install task (otherwise allow).
 */
export function workOutOfScopeForTask(
  taskTitle: string,
  call: ToolCall,
  opts?: { planTaskTitles?: string[] },
): string | undefined {
  if (isMetaPlanTool(call.name)) return undefined;
  const t = taskTitle.toLowerCase();
  const isRunVerifyTask =
    /\b(dev\s*server|run\s+dev|start\s+.*server|localhost|shell\.start|leave\s+.*running|probe|verify\s+in\s+browser)\b/.test(
      t,
    ) ||
    (/\b(start|run)\b/.test(t) && /\b(server|dev|app|verify)\b/.test(t));

  if (isRunVerifyTask) return undefined;

  const isInstallOnly = looksLikeInstallTaskTitle(taskTitle);
  const isScaffoldOnly = looksLikeScaffoldTaskTitle(taskTitle);
  const isImplementOnly =
    !isInstallOnly &&
    !isScaffoldOnly &&
    (/\b(implement|integrate|feature|rewrite|write\s+src|add\s+\w+\s+(component|module|handler|endpoint|page|route|model)|persist|localstorage|styling|styles?)\b/.test(
      t,
    ) ||
      (/\b(component|module|handler|endpoint|ui|page|todo)\b/.test(t) &&
        !/\b(install|scaffold|dev\s*server|create\s+project)\b/.test(t)));

  // Install always OK under scaffold or install tasks
  if (
    (isScaffoldOnly || isInstallOnly) &&
    call.name === "shell.exec" &&
    isPackageInstallCommand(commandOf(call))
  ) {
    return undefined;
  }

  if (
    (isInstallOnly || isScaffoldOnly || isImplementOnly) &&
    (isDevServerCall(call) || isLocalHttpProbe(call))
  ) {
    return (
      `Out of scope for current task "${taskTitle}": do not start the dev server or probe localhost yet. ` +
      `Finish and VERIFY this task's own work, mark it done only when satisfied, then open the run/verify task with task.update in_progress.`
    );
  }

  if (
    isImplementOnly &&
    call.name === "shell.exec" &&
    isPackageInstallCommand(commandOf(call))
  ) {
    const planTitles = opts?.planTaskTitles;
    const planHasInstallTask =
      !planTitles ||
      planTitles.length === 0 ||
      planTitles.some((title) => looksLikeInstallTaskTitle(title));
    if (planHasInstallTask) {
      return (
        `Out of scope for current task "${taskTitle}": run package install under the install task, not while implementing files.`
      );
    }
    // No install task in the plan — allow install so work is not stuck.
    return undefined;
  }

  return undefined;
}

/**
 * Choose which pending plan task should own this tool call (auto-start).
 * Prevents npm install from being attributed to "localStorage" / style tasks.
 */
export function pickPendingTaskForToolCall<T extends { id: string; title: string }>(
  pending: T[],
  call: ToolCall,
  allTitles?: string[],
): T | undefined {
  if (pending.length === 0) return undefined;
  const titles = allTitles ?? pending.map((p) => p.title);
  const cmd = commandOf(call);

  const score = (title: string): number => {
    if (workOutOfScopeForTask(title, call, { planTaskTitles: titles })) {
      return -100;
    }
    let s = 1; // any in-scope pending task is viable
    if (isPackageInstallCommand(cmd)) {
      if (looksLikeInstallTaskTitle(title)) s += 20;
      else if (looksLikeScaffoldTaskTitle(title)) s += 10;
      else s -= 5; // prefer not to attach install to feature tasks
    }
    if (isDevServerCall(call) || isLocalHttpProbe(call)) {
      if (
        /\b(dev\s*server|run\s+dev|localhost|shell\.start|probe|verify)\b/i.test(
          title,
        )
      ) {
        s += 20;
      } else s -= 10;
    }
    if (
      call.name === "fs.write" ||
      call.name === "fs.writeMany" ||
      call.name === "fs.edit"
    ) {
      if (looksLikeInstallTaskTitle(title)) s -= 15;
      if (
        /\b(component|feature|todo|implement|style|persist|localstorage|ui|page)\b/i.test(
          title,
        )
      ) {
        s += 12;
      }
    }
    return s;
  };

  let best: T | undefined;
  let bestScore = -Infinity;
  for (const p of pending) {
    const sc = score(p.title);
    if (sc > bestScore) {
      best = p;
      bestScore = sc;
    }
  }
  if (!best || bestScore < 0) return undefined;
  return best;
}

/**
 * User asked for a product feature app (todo, blog, …), not "just scaffold framework X".
 * Stack-agnostic: detects intent, not a particular framework.
 */
export function userAskedForFeatureApp(prompt: string): boolean {
  const p = prompt.trim().toLowerCase();
  if (!p) return false;
  if (/\b(just|only)\s+(scaffold|init|initialize|boilerplate|starter|template)\b/.test(p)) {
    return false;
  }
  // Named product feature + app/project shape
  if (
    /\b(todo|to-?do|blog|dashboard|chat|kanban|notes?|crm|shop|store|cart|auth|login|signup|crud|calendar|inbox|quiz|portfolio|gallery|tracker|inventory|booking|counter|timer|weather)\b/.test(
      p,
    ) &&
    /\b(app|application|project|site|page|ui|list|board|service|api)\b/.test(p)
  ) {
    return true;
  }
  // "build a full … with X feature"
  if (
    /\b(?:with|including|that\s+has|that\s+supports)\b[\s\S]{0,40}\b(todo|auth|crud|login|dashboard|blog)\b/.test(
      p,
    )
  ) {
    return true;
  }
  return false;
}

/** Paths that look like application source (not lockfiles / build output). */
export function isAppSourcePath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  if (
    /(?:^|\/)(?:node_modules|\.next|dist|build|coverage|\.git|vendor|target)(?:\/|$)/i.test(
      p,
    )
  ) {
    return false;
  }
  if (/(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/i.test(p)) {
    return false;
  }
  return /\.(jsx?|tsx?|vue|svelte|py|go|rs|java|kt|rb|php|swift|cs|css|scss|sass|less|html|mdx)$/i.test(
    p,
  );
}

export function extractWritePathsFromCall(call: ToolCall): string[] {
  const paths: string[] = [];
  if (
    call.name === "fs.write" ||
    call.name === "fs.edit" ||
    call.name === "fs.replaceLines" ||
    call.name === "fs.append"
  ) {
    if (typeof call.args.path === "string") paths.push(call.args.path);
  }
  if (call.name === "fs.writeMany" && Array.isArray(call.args.files)) {
    for (const f of call.args.files) {
      if (f && typeof f === "object" && typeof (f as { path?: unknown }).path === "string") {
        paths.push((f as { path: string }).path);
      }
    }
  }
  return paths;
}

/**
 * True when a successful tool call implements product feature code (not only scaffold).
 */
export function isFeatureImplementationCall(call: ToolCall): boolean {
  const paths = extractWritePathsFromCall(call);
  if (paths.some(isAppSourcePath)) return true;
  // Hand-written multi-file setup without official scaffolder
  if (call.name === "fs.writeMany" && paths.length >= 2) return true;
  return false;
}

/**
 * Soft block: don't start the local server until the product feature exists.
 * Returns a message when the open work is still scaffold-only for a feature ask.
 */
export function incompleteFeatureBeforeServerMessage(
  userPrompt: string,
  sawFeatureImpl: boolean,
  call: ToolCall,
): string | undefined {
  if (!userAskedForFeatureApp(userPrompt)) return undefined;
  if (sawFeatureImpl) return undefined;
  if (!isDevServerCall(call) && !(call.name === "shell.start")) return undefined;
  return (
    `Feature incomplete: the user asked for a product app (not just a blank scaffold). ` +
    `Implement the requested feature first (real UI/state or API — replace starter boilerplate), ` +
    `THEN start the server. Do not shell.start / npm run dev until the feature is written.`
  );
}

/**
 * User said work belongs on the Desktop (or similar). Returns absolute path.
 */
export function resolveUserDestinationHint(
  prompt: string,
  home = homedir(),
): string | undefined {
  const p = prompt.trim();
  if (!p) return undefined;

  // Explicit absolute /Users/.../Desktop/... already in the prompt — prefer that root
  const absDesktop = p.match(
    /((?:\/Users\/[^/\s]+|~)\/Desktop(?:\/[\w.-]+)?)/i,
  );
  if (absDesktop?.[1]) {
    const raw = absDesktop[1].replace(/^~(?=\/|$)/, home);
    // If they named a subfolder in the path, use parent Desktop for cwd default
    if (/\/Desktop$/i.test(raw) || /\/Desktop\//i.test(raw)) {
      const desk = raw.match(/^(.*?\/Desktop)/i);
      return desk?.[1] ?? raw;
    }
  }

  if (
    /\b(?:in|on|into|under|to)\s+(?:the\s+)?desktop(?:\s+directory|\s+folder)?\b/i.test(
      p,
    ) ||
    /\bdesktop\s+(?:directory|folder)\b/i.test(p) ||
    /\bcreate\b.+\b(?:on|in)\s+desktop\b/i.test(p)
  ) {
    return join(home, "Desktop");
  }
  return undefined;
}

/**
 * Default shell cwd when the model omitted it but a project root / Desktop hint exists.
 */
export function applyDestinationCwd(
  call: ToolCall,
  destinationHint: string | undefined,
): ToolCall {
  if (call.name !== "shell.exec" && call.name !== "shell.start") return call;
  if (typeof call.args.cwd === "string" && call.args.cwd.trim()) return call;
  const cmd = commandOf(call);
  // Prefer sticky project root (todo-app) over bare Desktop for install/dev.
  const cwd = getActiveProjectRoot() ?? destinationHint;
  if (!cwd) return call;

  const looksCreate = isScaffoldCreateCommand(cmd);
  // create into named subfolder: cwd should be parent of project if sticky root is the project
  if (looksCreate) {
    const nameMatch = cmd.match(
      /(?:create-vite(?:@\S+)?|create-next-app(?:@\S+)?|cargo\s+new|rails\s+new|poetry\s+new|flutter\s+create|mix\s+new|django-admin\s+startproject)\s+([A-Za-z0-9._-]+)/i,
    );
    if (nameMatch?.[1] && !nameMatch[1].startsWith("-")) {
      const parent = cwd.replace(/[/\\][^/\\]+$/, "");
      const useParent =
        cwd.endsWith(nameMatch[1]) ||
        cwd.endsWith("/" + nameMatch[1]) ||
        cwd.endsWith("\\" + nameMatch[1]);
      return {
        ...call,
        args: { ...call.args, cwd: useParent && parent ? parent : cwd },
      };
    }
    // Prefer destination parent (Desktop) for create when sticky root is already a project
    return { ...call, args: { ...call.args, cwd: destinationHint ?? cwd } };
  }

  const looksProjectLocal =
    /\b(npm\s+i(nstall)?|npm\s+run|yarn\s|pnpm\s|bun\s|pip\s+install|poetry\s+|cargo\s+|go\s+run|go\s+build|composer\s+|bundle\s+|dotnet\s+|flutter\s+|mix\s+|rails\s+|django)/i.test(
      cmd,
    ) || call.name === "shell.start";
  if (!looksProjectLocal) return call;
  return {
    ...call,
    args: { ...call.args, cwd },
  };
}
