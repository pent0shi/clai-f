/**
 * Completion-time recovery decisions: when a tool-free (or incomplete)
 * final answer must be rejected and the agent forced to act.
 */

export interface RecoveryBudgets {
  actionIntent: number;
  errorFix: number;
  forcePlan: number;
  featureImpl: number;
  runtimeVerify: number;
  failedProbe: number;
  prematureComplete: number;
  shallowPentest: number;
  freshnessUsed: boolean;
}

export function createRecoveryBudgets(): RecoveryBudgets {
  return {
    actionIntent: 0,
    errorFix: 0,
    forcePlan: 0,
    featureImpl: 0,
    runtimeVerify: 0,
    failedProbe: 0,
    prematureComplete: 0,
    shallowPentest: 0,
    freshnessUsed: false,
  };
}

export type RecoveryKind =
  | "error_fix"
  | "narration"
  | "force_plan"
  | "feature_impl"
  | "runtime_verify"
  | "failed_probe"
  | "premature_complete"
  | "freshness"
  | "shallow_pentest";

export interface RecoveryAction {
  kind: RecoveryKind;
  /** User/model-facing instruction to append. */
  message: string;
  /** Short terminal notice. */
  notice: string;
  budgetKey: keyof RecoveryBudgets;
}

const LIMITS: Record<keyof RecoveryBudgets, number> = {
  actionIntent: 3,
  errorFix: 3,
  forcePlan: 2,
  featureImpl: 2,
  runtimeVerify: 2,
  failedProbe: 3,
  prematureComplete: 6,
  shallowPentest: 2,
  freshnessUsed: 1,
};

export function budgetRemaining(
  budgets: RecoveryBudgets,
  key: keyof RecoveryBudgets,
): boolean {
  if (key === "freshnessUsed") return !budgets.freshnessUsed;
  return budgets[key] < LIMITS[key];
}

export function consumeBudget(
  budgets: RecoveryBudgets,
  key: keyof RecoveryBudgets,
): void {
  if (key === "freshnessUsed") {
    budgets.freshnessUsed = true;
    return;
  }
  budgets[key] = (budgets[key] as number) + 1;
}

export function recoveryForErrorDiagnosis(nativeTools: boolean): RecoveryAction {
  return {
    kind: "error_fix",
    budgetKey: "errorFix",
    notice: "error diagnosed but not fixed — forcing tool call",
    message: nativeTools
      ? "You diagnosed an error and described the fix but called NO tool. " +
        "Apply the fix now (fs.edit / fs.write / shell.exec), then re-verify. " +
        "Do not stop after identifying the error."
      : "You diagnosed an error and described the fix but emitted NO tool call. " +
        "Apply the fix now, e.g.:\n" +
        '```tool\n{"name":"fs.edit","args":{"path":"<file>","oldText":"...","newText":"..."}}\n```\n' +
        "Then re-run the failing check.",
  };
}

export function recoveryForNarration(
  nativeTools: boolean,
  mode: "plan_open" | "pentest" | "web" | "build_plan_prose" | "build" | "generic",
): RecoveryAction {
  const base = {
    kind: "narration" as const,
    budgetKey: "actionIntent" as const,
    notice: "described an action but emitted no tool call",
  };
  if (mode === "plan_open") {
    return {
      ...base,
      message: nativeTools
        ? "You wrote a message but called NO tool. Call the next tool now (task.update / fs.write / shell.exec)."
        : "You wrote a message but emitted NO ```tool block. Emit the next tool call now.",
    };
  }
  if (mode === "pentest") {
    return {
      ...base,
      notice: "described a security action but emitted no tool call",
      message: nativeTools
        ? "You described security work but called NO tool. Call a real tool now (net.scan / http.fetch / dns.lookup / shell.exec)."
        : "You described security work but emitted NO ```tool block. Emit a real tool call now (e.g. sysinfo, net.scan, http.fetch).",
    };
  }
  if (mode === "web") {
    return {
      ...base,
      notice: "described a web action but emitted no tool call",
      message: nativeTools
        ? "You claimed a search/fetch but called NO tool. Call web.search or web.fetch now, then answer from results."
        : "You claimed a search/fetch but emitted NO ```tool block. Emit web.search or web.fetch now.",
    };
  }
  if (mode === "build_plan_prose") {
    return {
      ...base,
      notice: "plan was written as text, not created",
      message: nativeTools
        ? 'You wrote the plan as prose but did NOT call plan.create. Call plan.create now with goal, detail, tasks, and kind="coding" or "pentest".'
        : "You wrote the plan as prose but did NOT call plan.create. Emit one plan.create tool block now.",
    };
  }
  if (mode === "build") {
    return {
      ...base,
      message: nativeTools
        ? 'You described work but called NO tool. Call a tool now (e.g. fs.list path="."), then plan.create when ready.'
        : "You described work but emitted NO ```tool block. Explore first, then plan.create when ready.",
    };
  }
  return {
    ...base,
    message: nativeTools
      ? "You described an action but called NO tool. Call the appropriate tool now."
      : "You described an action but emitted NO ```tool block. Emit a real tool call now.",
  };
}

/** Plan mode only — agent mode must not force plan.create. */
export function recoveryForMissingPlan(nativeTools: boolean): RecoveryAction {
  return {
    kind: "force_plan",
    budgetKey: "forcePlan",
    notice: "plan mode missing plan.create",
    message: nativeTools
      ? "You are in plan mode and tried to finish without a durable plan. Gather any remaining context you need, then call plan.create " +
        "(goal, rich detail with context/approach/risks/verify, all relevant tasks — no artificial cap, kind=coding|pentest|general as appropriate). Do not implement yet."
      : "You are in plan mode and tried to finish without a durable plan. Gather context if needed, then emit plan.create with a comprehensive plan (any relevant task count). Do not implement yet.",
  };
}

export function recoveryForMissingFeature(projectRoot?: string): RecoveryAction {
  const rootHint = projectRoot
    ? ` Write under "${projectRoot}" with absolute paths.`
    : "";
  return {
    kind: "feature_impl",
    budgetKey: "featureImpl",
    notice: "feature not implemented — scaffold alone is incomplete",
    message:
      "INCOMPLETE: the user asked for a working product feature, not a blank framework starter. " +
      "Scaffold alone is a failure. Implement the requested feature now (replace starter boilerplate) " +
      "with fs.write / fs.writeMany. Do not shell.start until that feature exists." +
      rootHint,
  };
}

export function recoveryForRuntimeVerify(projectRoot?: string): RecoveryAction {
  const rootHint = projectRoot ? ` Use cwd "${projectRoot}".` : "";
  return {
    kind: "runtime_verify",
    budgetKey: "runtimeVerify",
    notice: "local app missing runtime proof",
    message:
      "This is a local app build: do not stop after writing files or only telling the user how to run it. " +
      "Prove the app is running with ANY of: shell.start + shell.tail ready, port LISTEN (lsof/ss), " +
      "or localhost GET (http.fetch or curl). If the server is already listening, do NOT restart it " +
      "just to re-mint evidence — confirm once, leave it running, task.update done, report URL + port + job id." +
      rootHint,
  };
}

export function recoveryForFailedProbe(): RecoveryAction {
  return {
    kind: "failed_probe",
    budgetKey: "failedProbe",
    notice: "localhost probe failed — fix and re-verify",
    message:
      "The local HTTP probe failed (4xx/5xx or connection refused). Do not stop. " +
      "Diagnose from the error, apply a real fix with fs.edit/fs.write, re-probe, and only then mark verify done. " +
      "Identifying the error without a tool call is incomplete.",
  };
}

export function recoveryForPrematureComplete(input: {
  unfinished: Array<{ id: string; title: string; state: string }>;
  next: { id: string; title: string; state: string };
  pentest: boolean;
  errorFix: boolean;
}): RecoveryAction {
  const list = input.unfinished
    .map((t) => `[${t.id}] ${t.title}`)
    .join("; ");
  let instruction = `Resume task ${input.next.id} ("${input.next.title}"): `;
  if (input.errorFix) {
    instruction =
      `Fix the failure with a tool first (fs.edit/fs.write), then continue task ${input.next.id} ("${input.next.title}"): `;
  }
  if (input.pentest) {
    instruction +=
      `task.update in_progress, then recon/test with real tools (dns/http/net.scan — not a local dev server), verify, mark done. `;
  } else if (input.next.state === "pending") {
    instruction +=
      `task.update in_progress, do the work, verify, mark done. `;
  } else {
    instruction += `finish the work, verify, mark done. `;
  }
  instruction += "Continue until every task is finished.";

  return {
    kind: "premature_complete",
    budgetKey: "prematureComplete",
    notice: `${input.unfinished.length} plan task(s) still unfinished`,
    message:
      `You have not finished the approved plan: ${input.unfinished.length} task(s) remain (${list}). ` +
      `Do not claim completion without tool evidence. ${instruction}`,
  };
}

export function recoveryForFreshness(extra: string): RecoveryAction {
  return {
    kind: "freshness",
    budgetKey: "freshnessUsed",
    notice: "current-info question — search before answering",
    message: extra,
  };
}

/** True when a final pentest write-up looks like skim recon without real coverage. */
export function looksLikeShallowPentestReport(
  text: string,
  opts: { productiveSteps: number; sawActiveTest: boolean },
): boolean {
  if (opts.sawActiveTest) return false;
  if (opts.productiveSteps < 3) return false;
  const t = text.trim();
  if (t.length < 80) return false;
  const lower = t.toLowerCase();
  if (!/\b(finding|vulnerab|assessment|report|recon|open port|security posture|risk rating)\b/.test(lower)) {
    return false;
  }
  const deep =
    /\b(idor|broken access|injection|xss|csrf|ssrf|rce|sqli|auth.?bypass|privilege|jwt|poc|exploit|confirmed|reproduc|ffuf|gobuster|ferox|directory enum|content discovery|crt\.sh|certificate transparency)\b/i.test(
      t,
    );
  if (deep) return false;
  const shallow =
    /\b(open ports?|port\s+\d+|server header|missing (?:security )?header|http\/1|tls|banner|robots\.txt|top[- ]?ports?|mature (?:security )?posture|overall risk rating:\s*low)\b/i.test(
      t,
    );
  const claimsComplete =
    /\b(no critical|no high|mature|strong security posture|not vulnerable)\b/i.test(
      t,
    ) &&
    !/\b(untested|residual|not (?:tested|enumerated|scanned)|limited scope)\b/i.test(
      t,
    );
  return shallow || claimsComplete;
}

export function recoveryForShallowPentest(): RecoveryAction {
  return {
    kind: "shallow_pentest",
    budgetKey: "shallowPentest",
    notice: "pentest coverage looks thin — expand surface mapping",
    message:
      "Coverage looks thin (ports/headers/robots or early closure without residual risk). " +
      "Before finalizing: write a short threat model (top hypotheses for this stack), " +
      "expand attack surface — escalate ports if only top-N was used, " +
      "subdomain strategy beyond a few digs, content/API discovery (ffuf/gobuster + wordlist.find), " +
      "JS harvest, then actively test high-value vectors. " +
      "Background long scans while doing other recon. End with residual/untested honesty — " +
      "do not claim mature posture if major classes were never attempted.",
  };
}

export function freestyleClaimsAppReady(text: string): boolean {
  return (
    /\b(?:npm|pnpm|yarn|bun)\s+run\s+dev\b/i.test(text) ||
    /\b(?:cargo\s+run|flask\s+run|uvicorn|rails\s+s|python\s+-m\s+http\.server)\b/i.test(
      text,
    ) ||
    /\bopen\s+http:\/\/localhost\b/i.test(text) ||
    /\bhow to run\b/i.test(text) ||
    /\b(?:created|built|ready|complete)\b/i.test(text)
  );
}
