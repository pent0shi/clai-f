import chalk from "chalk";

import { join } from "node:path";
import type {
  ChatMessage,
  ChatImage,
  Mode,
  NativeToolCall,
  ProviderId,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "../types.js";
import { streamWithProvider, completeWithProvider } from "../llm/router.js";
import { resolveToolDialect } from "../llm/capabilities.js";
import {
  syntheticToolCallId,
  isTextOnlyModel,
  fromWireName,
} from "../llm/tool-protocol.js";
import { sanitizeAssistantText } from "../ui/ansi-box.js";
import { randomUUID } from "node:crypto";
import { jobManager, type BackgroundJob } from "../tools/jobs.js";
import {
  agentModeDirective,
  planModeDirective,
  renderAgentSystemPrompt,
  renderCompactAgentSystemPrompt,
  scratchDirFor,
  toolNudge,
} from "../prompts/index.js";
import { getConfig } from "../store/config.js";
import { groqInputTokenBudget } from "../llm/groq.js";
import {
  classifyToolCall,
  isPentestToolCall,
  scopeHint,
  scopeTargetForToolCall,
} from "../safety/classifier.js";
import {
  availableToolNames,
  normalizeToolCall,
  runToolCall,
  BATCH_SAFE_TOOLS,
} from "../tools/registry.js";
import {
  getToolDefinitions,
  getCompactToolDefinitions,
  PLAN_TOOL_NAMES,
} from "../tools/definitions.js";
import {
  appendAssistantWithTools,
  appendToolResult,
  assertValidToolProtocol,
  fillMissingToolResults,
} from "./tool-history.js";
import { formatViewportHint, registerViewport } from "../ui/output-pane.js";
import {
  compactMessagesWithSummary,
  estimateTokens,
  estimateMessagesTokens,
  AUTO_COMPACT_TOKEN_BUDGET,
  COMPACTION_MEMORY_PREFIX,
  PLAN_IMPLEMENT_MEMORY_PREFIX,
  isCompactionMemoryMessage,
} from "./context-manager.js";
import { auditLog } from "../store/logs.js";
import { loadProjectContext } from "../store/project.js";
import { loadScope, isScopeActive } from "../store/scope.js";
import { ensureProviderConfigured } from "../commands/providers.js";
import {
  createThinkingStreamParser,
  rememberThinkingFromText,
  renderThinkingSummary,
  stripThinking,
} from "../ui/thinking.js";
import { renderMarkdown, indentAndWrapText } from "../ui/markdown.js";
import { startThinkingSpinner, type ThinkingSpinner } from "../ui/spinner.js";
import { safeCwd } from "../os/cwd.js";
import {
  analyzeTask,
  formatTaskAnalysisHint,
  isNarrowExplicitNmapOperation,
} from "./task-analyzer.js";
import { computeMaxIterations, computeStepBudget } from "./step-budget.js";
import { isScratchOnlyWrite } from "./scratch-write.js";
import {
  COMPACTION_SYSTEM_PROMPT,
} from "./compaction-summary.js";
import { maybeAppendPlanModeReminder } from "./plan-mode-reminders.js";
import { LoopGuard } from "./loop-guard.js";
import {
  loadPlan,
  savePlan,
  markTask,
  readyPlanTasks,
  isPlanTerminal,
  isPlanSuccessful,
  type SessionPlan,
} from "../store/plan.js";
import type { AgentEvent } from "./events.js";
import {
  fsWrite,
  isOutsideWorkingDirectory,
  resolveFsToolPath,
} from "../tools/fs.js";
import {
  stripSentinelTokens,
  parseToolCall,
  recognizeBareToolJson,
  looksLikeTruncatedToolCall,
  salvageTruncatedWrite,
  salvageTruncatedWriteFromNative,
  countToolFences,
  parseAllToolCalls,
  groupToolCallsForExecution,
  buildTurnHistory,
  collapseRepeatedText,
  textBeforeToolCall,
  formatToolArgs,
  looksLikePentestTask,
  looksLikeBuildTask,
  looksLikeInformationalQuery,
  looksLikeIdleOrSocialPrompt,
  looksLikeActionNarration,
  looksLikeWebActionNarration,
  looksLikePlanNarration,
  looksLikeErrorDiagnosisWithFixIntent,
  localHttpProbeIsFailure,
  localHttpProbeIsSuccess,
  requiresFreshWebSearch,
  freshnessGuardMessage,
  buildWorkflowDirective,
  narrowNmapOperationDirective,
  pentestWorkflowDirective,
  pentestNoLocalServerDirective,
  shouldDimToolChatter,
  looksLikePromptLeak,
} from "./tool-call-parser.js";
import {
  createSessionPolicy,
  isPreApprovalAllowedTool,
  isPlanModeAllowedShellCommand,
  isPlanModeAllowedTool,
  isPlanApprovedByStatus,
  planHasOpenWork,
  isAbortError,
  shouldEnableImageOcr,
  type SessionPolicy,
} from "./session-policy.js";
import {
  saveToolOutput,
  summarizeOutput,
  formatToolContext,
} from "./tool-output-formatting.js";
import {
  renderPlanForTerminal,
  planContextMessage,
  handlePlanTool,
  resolvePlanTaskId,
} from "./plan-tool.js";
import {
  absorbLooseWorkIntoLedger,
  applyDestinationCwd,
  canMarkTaskDone,
  hasLocalRuntimeProof,
  hasRemoteWorkProof,
  isDevServerCall,
  isEvidenceWorkTool,
  isFeatureImplementationCall,
  isPackageInstallCommand,
  isPlanPreflightTool,
  isPortListeningOutput,
  isReadOnlyReconTool,
  isReadOnlyVersionProbeCommand,
  isRemoteActiveTestCall,
  isRemoteObservationTask,
  isRemoteReconToolCall,
  isRuntimeObservationTask,
  isScaffoldCreateCommand,
  isServerReadyOutput,
  ledgerFromTaskEvidence,
  pickPendingTaskForToolCall,
  recordTaskWorkSuccess,
  resolveUserDestinationHint,
  taskEvidenceFromLedger,
  TOOL_ABORT_GRACE_MS,
  toolHardBudgetMs,
  toolStallBudgetMs,
  type LooseWorkReceipt,
  userAskedForFeatureApp,
  type TaskWorkLedger,
  type TaskWorkSignals,
} from "./task-evidence.js";
import {
  buildSessionStateBlock,
  inferNextHint,
  upsertSessionStateMessage,
  type SessionStateSnapshot,
} from "./session-state.js";
import { detectPackageManager } from "./workspace-orient.js";
import {
  budgetRemaining,
  consumeBudget,
  createRecoveryBudgets,
  freestyleClaimsAppReady,
  looksLikeShallowPentestReport,
  recoveryForErrorDiagnosis,
  recoveryForFailedProbe,
  recoveryForFreshness,
  recoveryForMissingFeature,
  recoveryForMissingPlan,
  recoveryForNarration,
  recoveryForPrematureComplete,
  recoveryForRuntimeVerify,
  recoveryForShallowPentest,
} from "./must-continue.js";
import { scopeContextMessage } from "./scope-context.js";
import {
  EngagementPolicyEngine,
  actionFromUrl,
  engagementActionForToolCall,
  evaluateEngagementAction,
  type PolicyLease,
} from "../safety/engagement-policy.js";
import { patchPlanMeta } from "../store/plan.js";
import {
  extractProjectRootFromPlan,
  extractProjectRootFromScaffold,
  extractProjectRootFromText,
  getActiveProjectRoot,
  setActiveProjectRootIfValid,
} from "./project-root.js";
import {
  buildWorkspaceOrientation,
  discoverImmediateProjectRoots,
  guessProjectFolderName,
  isBareParentDirectory,
  isScaffoldCancelledOutput,
  scaffoldLooksMaterialized,
  scaffoldTargetConflictMessage,
  resolveScaffoldTargetPath,
} from "./workspace-orient.js";
import {
  inquirerConfirmPort,
  restoreInteractiveStdin,
  ensurePentestAuthorization,
  confirmToolExecution,
  type ConfirmPort,
} from "./confirm-port.js";
import { buildRichStopSummary } from "./stop-summary.js";
import { composeAgentSystemPrompt, type AgentPromptSection } from "./prompt-composer.js";
import {
  createGovernorState,
  governProgress,
  type GovernorState,
} from "./evidence-governor.js";
import {
  createTurnState,
  transitionTurn,
  type TurnState,
  type TurnStateSnapshot,
} from "./turn-state.js";
import {
  deriveOutcomeStatus,
  inferOutcomeKind,
  openOutcomeState,
  recordAnswerEvidence,
  recordFailedHypothesis,
  recordToolEvidence,
  saveOutcomeState,
  validateCriterionEvidence,
  type OutcomeEnvelope,
} from "./outcomes.js";
import { createTurnOutcome, renderTurnOutcome, type TurnOutcomeStatus } from "./turn-outcome.js";
import {
  beginEngagementAction,
  finishEngagementAction,
  recordEngagementCheckpoint,
  reconcileEngagementJob,
  openEngagement,
  saveEngagement,
  type EngagementActionRecord,
  type EngagementGraph,
} from "../store/engagement.js";


export * from "./tool-call-parser.js";
export {
  createSessionPolicy,
  isPreApprovalAllowedTool,
  isPlanApprovedByStatus,
  planHasOpenWork,
  shouldEnableImageOcr,
  type SessionPolicy,
} from "./session-policy.js";
export { type ConfirmPort } from "./confirm-port.js";

export function styleToolChatter(call: ToolCall, text: string): string {
  return shouldDimToolChatter(call) ? chalk.dim(text) : text;
}

export interface AgentRunOptions {
  provider?: ProviderId | undefined;
  model?: string | undefined;
  history?: ChatMessage[] | undefined;
  autoConfirm?: boolean | undefined;
  maxSteps?: number | undefined;
  signal?: AbortSignal | undefined;
  images?: ChatImage[] | undefined;
  onToolStart?: ((call: ToolCall) => void) | undefined;
  onToolResult?: ((call: ToolCall, result: ToolResult) => void) | undefined;
  onEvent?: ((event: AgentEvent) => void) | undefined;
  /**
   * Called when a turn ends with the FULL conversation for the turn — the user
   * message, every assistant tool-call, every tool result, and the final
   * answer (system prompts excluded). Callers persist this so a resumed
   * session gives the model back what it actually did (commands, outputs,
   * results), not just its prose answers.
   */
  onMessages?: ((messages: ChatMessage[]) => void) | undefined;
  onOutcome?: ((outcome: import("./turn-outcome.js").TurnOutcome) => void) | undefined;
  confirm?: ConfirmPort | undefined;
  requestSecret?:
  | ((request: {
    title: string;
    prompt: string;
  }) => Promise<string | undefined>)
  | undefined;
  session?: SessionPolicy | undefined;
  /** REPL mode: agent executes; plan is planning-only. */
  mode?: Mode | undefined;
  /**
   * Transcript YOU bubble. `null` hides implement/revision choreography from
   * chat; model still receives `prompt`. Omit to show `prompt`.
   */
  displayPrompt?: string | null | undefined;
}

export async function runAgentTurn(
  prompt: string,
  options: AgentRunOptions = {},
): Promise<import("./turn-outcome.js").TurnOutcome> {
  const agentMode: Mode =
    options.mode === "plan" || options.mode === "agent" || options.mode === "ask"
      ? options.mode
      : "agent";
  const isPlanMode = agentMode === "plan";
  const writesDirectly = !options.onEvent;
  const emit = (event: AgentEvent): void => options.onEvent?.(event);
  // Whether the CURRENT model iteration has already committed its visible
  // prose to the transcript with an `assistant-message` event. The recovery
  // paths preserve streamed prose before retrying (so it isn't wiped by the
  // next tool-call/turn event); this flag stops them from re-committing prose
  // the normal tool path already surfaced, which would render it twice. Reset
  // at the top of every loop iteration.
  let visibleCommitted = false;
  const noopSpinner: ThinkingSpinner = {
    setLabel: () => { },
    bumpReasoning: () => { },
    pushPreview: () => { },
    stop: () => { },
  };
  const writeStatus = (text: string, rendered = chalk.dim(text)): void => {
    // Footer activity is single-line; strip classic stdout newlines/indents.
    // Never surface /output path hints as activity (garbles the status bar).
    let cleaned = text.replace(/\s+/g, " ").trim();
    if (
      /\/output\b|open full output|Ctrl\+O or|\.clai\/outputs/i.test(cleaned)
    ) {
      return;
    }
    if (cleaned.length > 64) {
      const short = cleaned.match(/^[\w./-]+/);
      cleaned = short ? short[0]! : cleaned.slice(0, 61) + "…";
    }
    emit({ type: "status", text: cleaned || "working" });
    if (writesDirectly) process.stdout.write(rendered);
  };
  const writeNotice = (
    level: "info" | "warn",
    text: string,
    rendered: string,
  ): void => {
    emit({ type: "notice", level, text });
    if (writesDirectly) process.stdout.write(rendered);
  };
  const writeAssistantMessage = (text: string): void => {
    // Never surface an empty message: the reducer drops it and a direct
    // stdout writer would print a stray blank line.
    const clean = sanitizeAssistantText(text);
    if (!clean.trim()) return;
    visibleCommitted = true;
    emit({ type: "assistant-message", text: clean });
    const rendered = renderMarkdown(clean);
    if (writesDirectly) {
      process.stdout.write(clean.endsWith("\n") ? rendered : `${rendered}\n`);
    }
  };
  const writeThinkingBlock = (content: string): void => {
    emit({ type: "thinking-block", content });
    if (writesDirectly)
      process.stdout.write(`${renderThinkingSummary(content)}\n`);
  };
  const writeToolOutput = (
    id: string,
    chunk: string,
    rendered: string,
    options?: { replace?: boolean },
  ): void => {
    emit({
      type: "tool-output",
      id,
      chunk,
      ...(options?.replace ? { replace: true } : {}),
    });
    if (writesDirectly && rendered) process.stdout.write(rendered);
  };
  const writeToolCall = (
    id: string,
    call: ToolCall,
    rendered: string,
  ): void => {
    emit({
      type: "tool-call",
      id,
      name: call.name,
      argsDisplay: formatToolArgs(call),
    });
    if (writesDirectly) process.stdout.write(rendered);
  };
  const writePlanUpdate = (plan: SessionPlan, rendered: string): void => {
    emit({ type: "plan-update", plan });
    if (writesDirectly) process.stdout.write(rendered);
  };
  const writeToolBlocked = (
    id: string,
    name: string,
    reason: string,
    rendered: string,
  ): void => {
    emit({ type: "tool-blocked", id, name, reason });
    if (writesDirectly) process.stdout.write(rendered);
  };
  const writeAbort = (): void => {
    emit({ type: "turn-aborted" });
    if (writesDirectly) process.stdout.write(chalk.yellow("  ⏹ Aborted.\n"));
  };
  const emitToolResult = (
    id: string,
    result: ToolResult,
    summary: string,
    artifactPath?: string,
  ): void => {
    const event: Extract<AgentEvent, { type: "tool-result" }> = {
      type: "tool-result",
      id,
      ok: result.ok,
      summary,
    };
    if (typeof result.exitCode === "number") {
      event.exitCode = result.exitCode;
    }
    if (artifactPath) {
      event.artifactPath = artifactPath;
    }
    if (result.fileChanges && result.fileChanges.length > 0) {
      event.fileChanges = result.fileChanges;
    }
    emit(event);
  };
  /** Strip a known prefix from a string, returning the remainder unchanged. */
  const insertedText = (value: string, prefix: string): string =>
    value.startsWith(prefix) ? value.slice(prefix.length) : value;
  /**
   * Surface the compacted-context summary to both the TUI (via an event)
   * and, when running with a direct stdout writer, as a rendered box.
   * Token-count stats are always emitted for logs.
   */
  const writeCompacted = (
    summary: string,
    beforeTokens: number,
    afterTokens: number,
  ): void => {
    emit({ type: "compacted", summary, beforeTokens, afterTokens });
    if (writesDirectly) {
      const header = chalk.dim("  \u2726 Compacted Context");
      const footer = chalk.dim(
        `  ~${beforeTokens.toLocaleString()} \u2192 ~${afterTokens.toLocaleString()} tokens`,
      );
      const body = summary ? renderMarkdown(summary) : "(empty summary)";
      process.stdout.write(`${header}\n\n${body}\n${footer}\n`);
    }
  };
  // Points at the live message array so finishTurn can hand the full
  // conversation back to the caller. Assigned once `messages` is built below;
  // all later mutations are in-place so this reference stays current.
  let liveMessages: ChatMessage[] = [];
  const finishTurn = (
    answer: string,
    steps: number,
    status: TurnOutcomeStatus = "succeeded",
    remainingCriteria: readonly string[] = [],
    reason?: string,
  ): import("./turn-outcome.js").TurnOutcome => {
    const outcome = createTurnOutcome({
      status,
      answer,
      steps,
      remainingCriteria,
      reason,
    });
    const rendered = renderTurnOutcome(outcome);
    writeAssistantMessage(rendered);
    if (options.onMessages) {
      try {
        options.onMessages(buildTurnHistory(liveMessages, rendered));
      } catch {
        // Persisting history must never break the turn.
      }
    }
    options.onOutcome?.(outcome);
    emit({ type: "turn-end", outcome, finalAnswer: rendered, steps });
    return outcome;
  };

  try {
    emit({
      type: "turn-start",
      prompt,
      ...(options.displayPrompt !== undefined
        ? { displayPrompt: options.displayPrompt }
        : {}),
    });
    const config = getConfig();
    const maxSteps = options.maxSteps ?? 70;
    const confirmPort = options.confirm ?? inquirerConfirmPort;
    const projectContext = await loadProjectContext();
    const hasAttachedImages = Boolean(options.images?.length);
    const imageOcrEnabled = shouldEnableImageOcr(prompt, hasAttachedImages);
    // A vision-capable request already carries the actual image bytes. Hiding
    // image.ocr from the model prevents it from replacing visual inspection
    // with a lossy Tesseract pass (which produced fabricated screenshot text).
    const toolNames = availableToolNames().filter(
      (name) => name !== "image.ocr" || imageOcrEnabled,
    );
    // Build / scaffold / continuation turns must NEVER be diverted into a
    // web.search for "current info". The /implement directive ("Execute it
    // now…") and prompts like "create a react app" contain words such as
    // "now"/"latest" that trip the volatile-info regex; without this guard the
    // agent burns its turn searching the date instead of writing files.
    const buildLikeTurn = looksLikeBuildTask(prompt, options.history);
    const pentestLikeTurn = looksLikePentestTask(prompt, options.history);
    const narrowNmapOperation = isNarrowExplicitNmapOperation(prompt);
    // A plain informational follow-up ("what do you know so far", "summarize
    // the findings") in a resumed/continuing build or pentest session must
    // NOT inherit that session's "must act" behavior — it should be answered
    // from context, not treated as a signal to start executing or to invent a
    // brand-new plan (the exact failure where "what do u know till now"
    // triggered explore→plan and created an unrelated "Enhance clai" plan).
    const informationalQuery = looksLikeInformationalQuery(prompt);
    // Greetings / thanks / short acks must never force tools, plans, or
    // freshness retries — a false "act don't narrate" path burned tokens on
    // web.search recovery loops after a simple "hi".
    const idleOrSocialPrompt = looksLikeIdleOrSocialPrompt(prompt);
    const freshWebSearchRequired =
      !buildLikeTurn &&
      !pentestLikeTurn &&
      !idleOrSocialPrompt &&
      toolNames.includes("web.search") &&
      requiresFreshWebSearch(prompt);
    let provider = options.provider ?? config.defaultProvider;
    await ensureProviderConfigured(provider);
    let model = options.model ?? config.defaultModel;
    // Some Groq free-tier models have a per-request/per-minute input budget
    // below the normal agent prompt alone. Select a purpose-built compact
    // instruction set before the request is made, rather than treating the
    // provider's 413 as a context-window failure after the fact.
    const inputTokenBudget =
      provider === "groq" ? groqInputTokenBudget(model) : undefined;
    const useCompactSystemPrompt = inputTokenBudget !== undefined;
    const resolveNativeTools = (
      p: ProviderId,
      m: string,
    ): { dialect: ReturnType<typeof resolveToolDialect>; native: boolean } => {
      const dialect = resolveToolDialect(p, m, config.toolCalling);
      return { dialect, native: dialect !== "none" };
    };
    let { dialect: toolDialect, native: nativeToolsActive } = resolveNativeTools(
      provider,
      model,
    );
    const selectToolDefs = (
      native: boolean,
      compact: boolean,
    ): ToolDefinition[] | undefined => {
      if (!native) return undefined;
      const base = compact
        ? getCompactToolDefinitions()
        : getToolDefinitions();
      const allow = new Set([...toolNames, ...PLAN_TOOL_NAMES]);
      return base.filter((d) => allow.has(d.name));
    };
    let lastAnswer = "";
    const session: SessionPolicy = options.session ?? createSessionPolicy();

    // Active plan context
    // If this session already has a plan, inject it so the model keeps it in
    // context. When the user has approved it (via /implement) we instruct the
    // agent to execute task by task; otherwise the agent should refine/wait.
    const activePlan = await loadPlan(session.sessionId).catch(() => undefined);
    if (activePlan && isPlanApprovedByStatus(activePlan.status)) {
      // session.planApproved is in-memory only (never persisted), so a
      // resumed session (via /history) or a fresh SessionPolicy after
      // context compaction always starts it back at false — even when the
      // plan's OWN durable status shows it was already approved/executed/
      // completed via /implement. Re-derive the flag from the plan's status
      // on every load so resuming a session never re-blocks tool calls
      // behind a stale "awaiting approval" gate for a plan that already ran.
      session.planApproved.value = true;
    }

    const destinationHint = resolveUserDestinationHint(prompt);
    const orientationSourceText = [
      prompt,
      activePlan?.goal,
      activePlan?.detail,
      activePlan?.tasks.map((task) => task.title).join(" "),
    ].filter(Boolean).join("\n");
    const fromPlan = extractProjectRootFromPlan(activePlan);
    const fromPrompt = extractProjectRootFromText(prompt);
    const guessedName = guessProjectFolderName(orientationSourceText);
    const orientationParent =
      destinationHint ?? (isBareParentDirectory(safeCwd()) ? safeCwd() : undefined);
    const guessedProject =
      orientationParent && guessedName ? join(orientationParent, guessedName) : undefined;
    const discoveredProjects = orientationParent
      ? discoverImmediateProjectRoots(orientationParent)
      : [];

    // Sticky project root so relative fs paths never hit the agent package.
    // Preference is explicit durable plan metadata, explicit prompt paths,
    // exact natural-language folder guesses, then one unambiguous discovered
    // project. Never pin bare Desktop/home or invent a path before it exists.
    let pinnedProject = false;
    for (const candidate of [fromPlan, fromPrompt, guessedProject]) {
      if (setActiveProjectRootIfValid(candidate)) {
        pinnedProject = true;
        break;
      }
    }
    if (!pinnedProject && discoveredProjects.length === 1) {
      setActiveProjectRootIfValid(discoveredProjects[0]);
    }
    const buildSystemContent = (native: boolean): string => {
      const sections = [
        (useCompactSystemPrompt
          ? renderCompactAgentSystemPrompt
          : renderAgentSystemPrompt)(toolNames.join(", "), {
            nativeTools: native,
          }),
      ];
      if (projectContext) {
        sections.push(
          `Project context from .clai/context.md:\n${projectContext}`,
        );
      }
      const projectRoot = getActiveProjectRoot();
      if (projectRoot) {
        sections.push(
          `ACTIVE PROJECT ROOT: ${projectRoot}\n` +
          `All relative paths (./src/…, manifests, configs) resolve under this directory — NOT the agent process cwd. ` +
          `Prefer absolute paths under this root. shell cwd for install / run / build must be this root ` +
          `(or its parent when creating a NEW named subfolder with a scaffolder). ` +
          `Never write user app source into the agent package tree.`,
        );
      } else if (destinationHint) {
        sections.push(
          `USER DESTINATION: create or continue work under "${destinationHint}" (parent folder). ` +
          `Pick or detect a project subfolder; do not scaffold into the agent working tree unless the user asked for that.`,
        );
      }
      // Stack-agnostic PWD / existing-project snapshot so weak models cannot
      // skip explore and re-scaffold into non-empty dirs.
      if (
        buildLikeTurn &&
        !informationalQuery &&
        !idleOrSocialPrompt
      ) {
        const guessedName = guessProjectFolderName(
          [prompt, activePlan?.goal, activePlan?.detail, activePlan?.tasks.map((t) => t.title).join(" ")]
            .filter(Boolean)
            .join("\n"),
        );
        const extraPaths: string[] = [];
        if (destinationHint && guessedName) {
          extraPaths.push(join(destinationHint, guessedName));
        }
        const fromText =
          extractProjectRootFromPlan(activePlan) ??
          extractProjectRootFromText(prompt);
        if (fromText) extraPaths.push(fromText);
        const orientInput: {
          cwd: string;
          destinationHint?: string;
          candidateProject?: string;
          extraPaths: string[];
        } = {
          cwd: safeCwd(),
          extraPaths,
        };
        if (destinationHint) orientInput.destinationHint = destinationHint;
        const candidate = getActiveProjectRoot() ?? fromText;
        if (candidate) orientInput.candidateProject = candidate;
        sections.push(buildWorkspaceOrientation(orientInput));
      }
      if (freshWebSearchRequired) {
        sections.push(freshnessGuardMessage());
      }
      return sections.join("\n\n");
    };
    const systemSections = [buildSystemContent(nativeToolsActive)];
    if (activePlan) {
      systemSections.push(
        planContextMessage(activePlan, session.planApproved.value),
      );
    }

    if (isPlanMode) {
      systemSections.push(planModeDirective());
    } else if (agentMode === "agent") {
      systemSections.push(agentModeDirective());
    }

    // Build focus card: orientation + feature quality, not forced plan theater.
    if (
      buildLikeTurn &&
      !informationalQuery &&
      !idleOrSocialPrompt &&
      !isPlanMode
    ) {
      systemSections.push(buildWorkflowDirective());
    }
    if (
      isPlanMode &&
      buildLikeTurn &&
      !informationalQuery &&
      !idleOrSocialPrompt
    ) {
      systemSections.push(buildWorkflowDirective());
    }

    // A bounded explicit nmap request is one operation, not an invitation to
    // manufacture a full engagement plan or add unrelated recon steps.
    if (
      narrowNmapOperation &&
      !informationalQuery &&
      !idleOrSocialPrompt &&
      !isPlanMode
    ) {
      systemSections.push(narrowNmapOperationDirective());
    }

    // Broader pentest / security engagements need a different shape than a coding
    // build: recon first, then a plan built from real findings, then
    // incremental task additions as new attack surface appears.
    if (
      pentestLikeTurn &&
      !narrowNmapOperation &&
      !activePlan &&
      !informationalQuery &&
      !idleOrSocialPrompt
    ) {
      systemSections.push(pentestWorkflowDirective());
    }

    // Any remote/security engagement (even with an existing or completed plan)
    // must never fall into the coding "start localhost dev server" habit.
    const pentestSession =
      pentestLikeTurn ||
      activePlan?.kind === "pentest" ||
      (activePlan?.kind !== "coding" &&
        Boolean(
          activePlan?.goal &&
          /pentest|vulnerab|recon|security assess|attack surface|red team/i.test(
            activePlan.goal,
          ),
        ));
    if (pentestSession && !idleOrSocialPrompt) {
      systemSections.push(pentestNoLocalServerDirective());
    }

    {
      const engScope = await loadScope().catch(() => undefined);
      const scopeBlock = scopeContextMessage(engScope);
      if (scopeBlock && (pentestSession || pentestLikeTurn) && !idleOrSocialPrompt) {
        systemSections.push(scopeBlock);
      }
    }

    // Soft task analysis for multi-step work (never a forced plan script).
    {
      const earlyAnalysis = analyzeTask(prompt);
      if (
        !idleOrSocialPrompt &&
        !informationalQuery &&
        !narrowNmapOperation &&
        (earlyAnalysis.shouldPlan ||
          earlyAnalysis.complexity === "complex" ||
          buildLikeTurn ||
          pentestLikeTurn)
      ) {
        systemSections.push(formatTaskAnalysisHint(earlyAnalysis));
      }
    }

    const promptSections = (): AgentPromptSection[] => {
      const sections: AgentPromptSection[] = systemSections.slice(1).map((content) => ({
        kind: content.startsWith("ACTIVE PLAN")
          ? "plan"
          : content.startsWith("ENGAGEMENT SCOPE")
            ? "scope"
            : content.includes("MODE")
              ? "mode"
              : content.includes("OUTCOME")
                ? "outcome"
                : content.includes("WORKFLOW") || content.includes("FOCUS")
                  ? "focus"
                  : "context",
        content,
        mandatory:
          content.startsWith("ACTIVE PLAN") ||
          content.startsWith("ENGAGEMENT SCOPE") ||
          content.includes("MODE") ||
          content.includes("OUTCOME"),
      }));
      const has = (kind: AgentPromptSection["kind"]): boolean =>
        sections.some((section) => section.kind === kind);
      if (!has("outcome")) {
        sections.push({
          kind: "outcome",
          content: `OUTCOME CONTRACT\nGoal: ${prompt}\nSuccess requires evidence that the requested result is complete; otherwise return partial, blocked, failed, aborted, or paused_budget with remaining criteria.`,
          mandatory: true,
        });
      }
      if (!has("plan")) {
        sections.push({
          kind: "plan",
          content: "ACTIVE PLAN\nNo persisted plan is active for this turn.",
          mandatory: true,
        });
      }
      if (!has("scope")) {
        sections.push({
          kind: "scope",
          content: "ENGAGEMENT SCOPE\nNo active remote-security scope applies to this turn.",
          mandatory: true,
        });
      }
      sections.push({
        kind: "context",
        content: `TASK STATE\nMode: ${agentMode}. Current request: ${prompt}`,
        mandatory: true,
      });
      return sections;
    };
    const composeCurrentSystemPrompt = (native: boolean): string =>
      composeAgentSystemPrompt({
        mode: agentMode,
        nativeToolsActive: native,
        maxTokens: inputTokenBudget
          ? Math.min(2_000, Math.floor(inputTokenBudget * 0.4))
          : undefined,
        sections: [
          {
            kind: "constitution",
            content: buildSystemContent(native),
            mandatory: true,
          },
          ...promptSections(),
        ],
      }).content;
    const fullSystemPrompt = composeCurrentSystemPrompt(nativeToolsActive);
    const userMessage: ChatMessage = { role: "user", content: prompt };
    if (options.images && options.images.length > 0) {
      userMessage.images = options.images;
    }
    const messages: ChatMessage[] = [
      { role: "system", content: fullSystemPrompt },
      ...(options.history ?? []),
      userMessage,
    ];
    liveMessages = messages;
    /** Assigned after session flags exist — see below. */
    let refreshSessionState: (
      plan?: SessionPlan | null | undefined,
    ) => void = () => undefined;
    /** Model-only nudge — never shown as a YOU bubble / WARN in the chat UI. */
    const recoveryUserMessage = (content: string): ChatMessage => {
      const message: ChatMessage = { role: "user", content, internal: true };
      if (options.images && options.images.length > 0) {
        // Some OpenAI-compatible gateways/models attend most strongly to the
        // latest user turn. Keep the image attached on recovery nudges so a
        // thinking-only retry does not degrade into OCR/tool guessing.
        message.images = options.images;
      }
      return message;
    };

    const recoveryProse = (content: string): string | undefined => {
      const text = textBeforeToolCall(stripSentinelTokens(content)).trim();
      if (
        !text ||
        /^```|^\{|<tool_call>|<\|tool_call(?:s_section)?_begin\|>/i.test(
          text,
        ) ||
        /\n\s*\{[\s\S]*\}\s*$/.test(text)
      ) {
        return undefined;
      }
      return text;
    };
    const pushAssistantHistory = (content: string): void => {

      const cleaned = sanitizeAssistantText(content);
      if (!visibleCommitted) {
        const prose = recoveryProse(cleaned);
        if (prose) writeAssistantMessage(prose);
      }
      messages.push({
        role: "assistant",
        content: cleaned.trim()
          ? cleaned
          : "[No visible assistant response was produced.]",
      });
    };


    const loopGuard = new LoopGuard();
    const engagementPolicy = new EngagementPolicyEngine();

    // Track consecutive thinking-only responses so we can nudge the model
    // to actually act instead of silently returning an empty answer.
    let emptyVisibleRetries = 0;

    let retryWithoutThinking = false;

    // Track tool calls truncated by the token limit so we can ask the model
    // to retry in smaller pieces instead of leaking broken JSON as an answer.
    let truncatedToolRetries = 0;


    let bareToolJsonRetries = 0;

    // Track a ```tool fence that is present but whose JSON could not be parsed
    // (e.g. malformed extra/missing braces that are NOT simple truncation). We
    // retry instead of leaking the raw block as the final answer.
    let malformedFenceRetries = 0;

    let sawFreshWebSearch = false;

    const recovery = createRecoveryBudgets();
    let sawServerStart = false;
    let sawPlanCreateOk = false;
    let sawServerTail = false;
    let sawLocalHttpProbe = false;
    let sawFailedLocalHttpProbe = false;
    let sawLocalAppMaterialWork = false;
    let sawScaffoldOk = false;
    let sawFeatureImplWrite = false;
    let sawActivePentestTest = false;
    const featureAppAsk = userAskedForFeatureApp(prompt);
    let taskWorkLedger: TaskWorkLedger | null = null;
    /**
     * Successful real tools this turn that may not yet be credited to a task
     * (preflight tool.check before in_progress, or work before plan existed).
     * Absorbed into the task ledger when opening or marking done.
     */
    const sessionLooseWork: LooseWorkReceipt[] = [];

    const planHasVerifiedRuntime = (plan: SessionPlan): boolean =>
      plan.tasks.some((task) => hasLocalRuntimeProof(task.evidence));

    const planHasVerifiedRemoteWork = (plan: SessionPlan): boolean =>
      plan.tasks.some((task) => hasRemoteWorkProof(task.evidence));

    /** Rehydrate turn-local runtime/remote flags from durable plan evidence (resume). */
    const rehydrateSessionFlagsFromPlan = (plan: SessionPlan | undefined): void => {
      if (!plan) return;
      for (const task of plan.tasks) {
        const e = task.evidence;
        if (!e) continue;
        if (e.sawDevServerStart || e.sawServerReady || e.sawPortListening) {
          sawServerStart = true;
        }
        if (e.sawServerReady || e.sawDevServerStart) sawServerTail = true;
        if (e.sawLocalHttpProbeOk) sawLocalHttpProbe = true;
        if (e.sawRemoteActiveTestOk) sawActivePentestTest = true;
      }
    };
    rehydrateSessionFlagsFromPlan(activePlan);

    /** Merge loose turn work + live ledger for a task before evidence gates. */
    const ledgerForTaskGate = (
      plan: SessionPlan,
      taskId: string,
    ): TaskWorkLedger | null => {
      const task = plan.tasks.find((candidate) => candidate.id === taskId);
      const durableLedger = ledgerFromTaskEvidence(taskId, task?.evidence);
      let ledger: TaskWorkLedger | null =
        taskWorkLedger?.taskId === taskId &&
        taskWorkLedger.successWorkCount >= durableLedger.successWorkCount
          ? taskWorkLedger
          : durableLedger;
      ledger = absorbLooseWorkIntoLedger(
        ledger,
        taskId,
        task?.title ?? "",
        sessionLooseWork,
        { planKind: plan.kind },
      );
      // Keep the live ledger in sync so subsequent tools append correctly.
      if (ledger && ledger.successWorkCount > 0) {
        if (
          !taskWorkLedger ||
          taskWorkLedger.taskId !== taskId ||
          taskWorkLedger.successWorkCount < ledger.successWorkCount
        ) {
          taskWorkLedger = ledger;
        }
      }
      return ledger;
    };

    const completionGateForTask = (
      plan: SessionPlan,
      taskId: string,
    ): ReturnType<typeof canMarkTaskDone> => {
      const task = plan.tasks.find((candidate) => candidate.id === taskId);
      const ledger = ledgerForTaskGate(plan, taskId);
      return canMarkTaskDone(ledger, taskId, {
        taskTitle: task?.title,
        featureAppRequired: featureAppAsk,
        existingProject: scaffoldLooksMaterialized(getActiveProjectRoot()),
        runtimeVerified: planHasVerifiedRuntime(plan),
        planKind: plan.kind,
        remoteWorkVerified: planHasVerifiedRemoteWork(plan),
      });
    };


    const reconcileOpenTaskBeforeFinalizing = async (): Promise<SessionPlan | undefined> => {
      const plan = await loadPlan(session.sessionId).catch(() => undefined);
      const open = plan?.tasks.find((task) => task.state === "in_progress");
      if (!plan || !open) return plan;
      const gate = completionGateForTask(plan, open.id);
      if (!gate.ok) return plan;

      const reconciledTaskIds = [open.id];
      markTask(plan, open.id, "done", "Completion reconciled from verified task evidence.");

      while (true) {
        const observation = readyPlanTasks(plan).find(
          (task) =>
            isRuntimeObservationTask(task.title) ||
            (plan.kind === "pentest" && isRemoteObservationTask(task.title)),
        );
        if (!observation) break;
        const observationGate = completionGateForTask(plan, observation.id);
        if (!observationGate.ok) break;
        markTask(
          plan,
          observation.id,
          "done",
          plan.kind === "pentest"
            ? "Satisfied by verified remote evidence from the preceding task."
            : "Satisfied by the verified runtime evidence from the preceding task.",
        );
        reconciledTaskIds.push(observation.id);
      }
      if (plan.status === "draft" || plan.status === "approved") {
        plan.status = "in_progress";
      }
      if (isPlanTerminal(plan)) {
        plan.status = isPlanSuccessful(plan) ? "completed" : "abandoned";
      }
      await savePlan(plan).catch(() => undefined);
      writePlanUpdate(plan, renderPlanForTerminal(plan) + "\n");
      writeNotice(
        "info",
        `reconciled ${reconciledTaskIds.map((id) => `[${id}]`).join(", ")} from verified evidence`,
        chalk.dim(
          `  ℹ reconciled ${reconciledTaskIds.map((id) => `[${id}]`).join(", ")} from verified evidence — no duplicate verification\n`,
        ),
      );
      taskWorkLedger = null;
      return plan;
    };

    async function persistProjectRootOnPlan(root: string): Promise<void> {
      const live = await loadPlan(session.sessionId).catch(() => undefined);
      if (!live) return;
      const pm = detectPackageManager(root);
      patchPlanMeta(live, {
        projectRoot: root,
        ...(pm ? { packageManager: pm } : {}),
      });
      await savePlan(live).catch(() => undefined);
    }

    refreshSessionState = (plan?: SessionPlan | null | undefined): void => {
      if (idleOrSocialPrompt || informationalQuery) return;
      if (!buildLikeTurn && !pentestLikeTurn && !plan && !activePlan) return;
      const p = plan ?? activePlan;
      const root = getActiveProjectRoot() ?? p?.meta?.projectRoot;
      const pm =
        p?.meta?.packageManager ??
        (root ? detectPackageManager(root) : undefined);
      const open = p?.tasks.find((t) => t.state === "in_progress");
      const pending = p?.tasks
        .filter((t) => t.state === "pending")
        .map((t) => `[${t.id}] ${t.title}`);
      const done = p?.tasks
        .filter((t) => t.state === "done" || t.state === "skipped")
        .map((t) => t.id);
      const snap: SessionStateSnapshot = {
        goal: p?.goal ?? prompt.slice(0, 160),
        projectRoot: root,
        packageManager: pm,
        planStatus: p?.status,
        planKind: p?.kind,
        openTask: open ? `[${open.id}] ${open.title}` : undefined,
        pendingTasks: pending,
        doneTasks: done,
        featureAppRequired: featureAppAsk,
        featureSeen: sawFeatureImplWrite,
        scaffoldOk: sawScaffoldOk,
        serverStarted: sawServerStart,
        serverProbedOk: sawLocalHttpProbe,
        lastProbeFailed: sawFailedLocalHttpProbe,
        lastOkTool: taskWorkLedger?.lastOkTool,
        engagementNote: pentestSession
          ? "remote/security engagement — no local dev server as completion"
          : undefined,
      };
      snap.nextHint = inferNextHint(snap);
      upsertSessionStateMessage(messages, buildSessionStateBlock(snap));
    };
    refreshSessionState(activePlan);


    let pendingCalls: ToolCall[] = [];
    let narrowNmapDispatchCount = 0;

    const deferredPostToolMessages: ChatMessage[] = [];


    const analysis = analyzeTask(prompt);
    const hasHistory = (options.history?.length ?? 0) > 0;
    const buildLike = buildLikeTurn;
    const pentestLike = looksLikePentestTask(prompt, options.history);
    const continueExistingOutcome =
      /^(?:continue|resume|proceed|keep\s+going|finish|next)\b/i.test(prompt.trim()) ||
      Boolean(activePlan && !isPlanTerminal(activePlan));
    const outcomeState: OutcomeEnvelope = await openOutcomeState({
      sessionId: session.sessionId,
      userIntent: prompt,
      kind: inferOutcomeKind({ userIntent: prompt, buildLike, pentestLike }),
      continueExisting: continueExistingOutcome,
    });
    await saveOutcomeState(outcomeState);
    let governorState: GovernorState = createGovernorState();
    let governorPauseReason: string | undefined;
    let turnState: TurnStateSnapshot = createTurnState();
    const moveTurn = (to: TurnState, reason?: string): void => {
      if (turnState.state === to) return;
      try {
        turnState = transitionTurn(turnState, to, reason);
      } catch {
        // Recovery paths may skip an intermediate presentation state; route
        // active work through verifying/exploring rather than forging state.
        if (to === "succeeded" || to === "partial") {
          if (turnState.state === "understanding") {
            turnState = transitionTurn(
              turnState,
              "exploring",
              "response prepared for verification",
            );
          }
          if (turnState.state === "acting" || turnState.state === "exploring") {
            turnState = transitionTurn(turnState, "verifying", reason);
          }
          turnState = transitionTurn(turnState, to, reason);
        }
      }
    };
    let retryDependenciesChanged = false;
    let retryEnvironmentChanged = false;
    const stepBudget = computeStepBudget({
      analysis,
      maxSteps,
      buildLike,
      pentestLike,
      hasHistory,
    });
    // Iteration count is only an emergency protection for recovery/model loops;
    // normal continuation is governed by evidence and resource deltas above.
    const maxIterations = Math.max(210, computeMaxIterations(stepBudget));

    let productiveSteps = 0;
    /** Successful file mutation this turn — kills false "error diagnosed but not fixed". */
    let sawSuccessfulMutation = false;
    let step = -1;
    let nextToolEventId = 0;
    const alreadyPrintedIds = new Set<string>();

    const promptMutex = {
      promise: Promise.resolve(),
      async acquire(): Promise<() => void> {
        let release = () => { };
        const next = new Promise<void>((r) => {
          release = r;
        });
        const current = this.promise;
        this.promise = current.then(() => next);
        await current;
        return release;
      },
    };

    async function executeSingleTool(
      rawCall: ToolCall,
      toolEventId: string,
      parentSignal: AbortSignal,
    ): Promise<{
      ok: boolean;
      call: ToolCall;
      result: ToolResult;
      contextOutput: string;
      lastAnswer?: string | undefined;
      blockOrCancel?: boolean | undefined;
    }> {

      const scratchDir = scratchDirFor(safeCwd());
      let call = normalizeToolCall(rawCall);

      let dispatchedTaskId: string | undefined;
      let engagementLease: PolicyLease | undefined;
      let engagementGraph: EngagementGraph | undefined;
      let engagementRecord: EngagementActionRecord | undefined;

      if (call.args?.__nativeParseError) {
        const raw = String(call.args._raw ?? "").slice(0, 200);
        const reason =
          "Tool call arguments were not valid JSON (truncated or malformed). " +
          "Retry with smaller content, or use fs.writeMany / fs.append continuation. " +
          (raw ? `Partial: ${raw}` : "");
        const result = { ok: false, output: reason, exitCode: 1 };
        emitToolResult(toolEventId, result, reason);
        return { ok: false, call, result, contextOutput: reason };
      }

      if (call.name === "image.ocr" && !imageOcrEnabled) {
        writeNotice(
          "info",
          "skipped OCR because the original image is attached to the vision model",
          chalk.dim(
            "  ℹ skipped OCR — inspecting the attached image directly\n",
          ),
        );
        const recoveryText =
          "The original image is attached to this message and you can inspect it directly. " +
          "Do not call image.ocr or infer text from OCR. Answer the user's question from the actual image pixels now.";
        const result = { ok: true, output: recoveryText };
        return { ok: true, call, result, contextOutput: recoveryText };
      }

      if (narrowNmapOperation) {
        const allowed = new Set(["net.scan", "shell.tail", "shell.jobs"]);
        if (!allowed.has(call.name)) {
          const reason =
            `Narrow nmap request: ${call.name} was not run because the user requested only one nmap operation. ` +
            `Call net.scan with the requested target/options; do not create a plan or add DNS, WHOIS, HTTP, recon, or vulnerability steps.`;
          const result = { ok: false, output: reason, exitCode: 1 };
          emitToolResult(toolEventId, result, reason);
          return { ok: false, call, result, contextOutput: reason };
        }
        if (call.name === "net.scan") {
          if (narrowNmapDispatchCount >= 1) {
            const reason =
              "Narrow nmap request: a scan has already been dispatched this turn. " +
              "Do not broaden or retry it automatically; report the existing result/job status and ask before another scan.";
            const result = { ok: false, output: reason, exitCode: 1 };
            emitToolResult(toolEventId, result, reason);
            return { ok: false, call, result, contextOutput: reason };
          }
          narrowNmapDispatchCount += 1;
        }
      }

      const retryReasonRaw = call.args._retryReason;
      const retryReason =
        retryReasonRaw && typeof retryReasonRaw === "object"
          ? {
            code: String((retryReasonRaw as Record<string, unknown>).code ?? ""),
            detail: String((retryReasonRaw as Record<string, unknown>).detail ?? ""),
          }
          : undefined;
      const loopCheck = loopGuard.shouldBlock(call.name, call.args, {
        dependenciesChanged: retryDependenciesChanged,
        environmentChanged: retryEnvironmentChanged,
        ...(retryReason ? { retryReason } : {}),
      });
      if (loopCheck.block) {
        const reason =
          loopCheck.reason ??
          `${call.name} was already called with the same arguments. Use the prior result and choose a different next step.`;

        writeNotice("warn", reason, chalk.yellow(`  ⚠ ${reason}\n`));
        const result = { ok: false, output: reason, exitCode: 1 };
        return {
          ok: false,
          call,
          result,
          contextOutput: reason,
        };
      }
      if (loopCheck.reason) {
        writeNotice(
          "info",
          loopCheck.reason,
          chalk.dim(`  ℹ ${loopCheck.reason}\n`),
        );
      }

      if (call.name === "plan.create" || call.name === "task.update") {
        // Evidence gate: refuse done until at least one successful work tool
        // ran under this task (model must see results and be satisfied).
        if (call.name === "task.update") {
          const stateRaw =
            typeof call.args.state === "string" ? call.args.state : "";
          const taskIdRaw =
            typeof call.args.taskId === "string"
              ? call.args.taskId
              : typeof call.args.id === "string"
                ? call.args.id
                : "";
          if (stateRaw === "done" && taskIdRaw) {
            const live = await loadPlan(session.sessionId).catch(() => undefined);
            const resolved =
              (live ? resolvePlanTaskId(live, taskIdRaw) : undefined) ??
              taskIdRaw;
            const target = live?.tasks.find((task) => task.id === resolved);
            // Soft-auto: pending + deps complete is allowed through to plan-tool,
            // which will open then complete in one call. Only hard-block when
            // the task is not ready for that path (failed / deps / missing).
            const depsIncomplete =
              target?.dependencies?.some((dependency) => {
                const dependencyTask = live?.tasks.find((t) => t.id === dependency);
                return (
                  !dependencyTask ||
                  (dependencyTask.state !== "done" && dependencyTask.state !== "skipped")
                );
              }) ?? false;
            const canSoftComplete =
              target?.state === "pending" && !depsIncomplete;
            const gate = !live
              ? {
                ok: false as const,
                reason: `Task ${resolved} cannot be marked done because its active plan is unavailable.`,
              }
              : target?.state === "in_progress" || canSoftComplete
                ? completionGateForTask(live, resolved)
                : target?.state === "failed"
                  ? {
                    ok: false as const,
                    reason: `Task ${resolved} is failed — retry with in_progress first, then mark done after recovery work.`,
                  }
                  : {
                    ok: false as const,
                    reason: `Task ${resolved} must be in_progress before it can be marked done. Start or retry the task, perform fresh work, then complete it.`,
                  };
            if (!gate.ok) {
              writeNotice(
                "warn",
                gate.reason,
                chalk.yellow(`  ⚠ ${gate.reason}\n`),
              );
              if (!alreadyPrintedIds.has(toolEventId)) {
                const toolCallLine =
                  chalk.cyan(`  ▶ ${call.name}`) +
                  chalk.gray(` ${formatToolArgs(call)}`);
                writeToolCall(
                  toolEventId,
                  call,
                  styleToolChatter(call, toolCallLine) + "\n",
                );
                alreadyPrintedIds.add(toolEventId);
              }
              const result = {
                ok: false,
                output: gate.reason,
                exitCode: 1,
              };
              emitToolResult(toolEventId, result, gate.reason);
              writeToolOutput(
                toolEventId,
                "failed\n",
                chalk.red("  ✗") + "\n",
              );
              return {
                ok: false,
                call,
                result,
                contextOutput: gate.reason,
              };
            }
          }
        }

        const planResult = await handlePlanTool(call, session, {
          loopGuard,
          step,
          autoApprove: !isPlanMode,
        });
        if (planResult.handled) {
          loopGuard.recordAttempt(step, call.name, call.args, planResult.ok, 0);

          if (planResult.ok && call.name === "task.update") {
            const stateRaw =
              typeof call.args.state === "string" ? call.args.state : "";
            const taskIdRaw =
              typeof call.args.taskId === "string"
                ? call.args.taskId
                : typeof call.args.id === "string"
                  ? call.args.id
                  : "";
            const resolved =
              (planResult.plan
                ? resolvePlanTaskId(planResult.plan, taskIdRaw)
                : undefined) ?? taskIdRaw;
            if (stateRaw === "in_progress" && resolved) {
              // Keep accumulated evidence when recon already credited this task
              // before an explicit in_progress (common on pentest plans).
              // Also absorb turn-level preflight (tool.check before open).
              const persisted = planResult.plan?.tasks.find(
                (task) => task.id === resolved,
              );
              const baseLed =
                taskWorkLedger?.taskId === resolved
                  ? taskWorkLedger
                  : ledgerFromTaskEvidence(resolved, persisted?.evidence);
              const led =
                absorbLooseWorkIntoLedger(
                  baseLed,
                  resolved,
                  persisted?.title ?? "",
                  sessionLooseWork,
                  { planKind: planResult.plan?.kind },
                ) ?? baseLed;
              taskWorkLedger = led;
              if (planResult.plan && led && led.successWorkCount > 0 && persisted) {
                persisted.evidence = taskEvidenceFromLedger(led);
                await savePlan(planResult.plan).catch(() => undefined);
              }
            } else if (stateRaw === "done" && resolved) {
              // Persist absorbed evidence before clearing the live ledger.
              if (planResult.plan && taskWorkLedger?.taskId === resolved) {
                const t = planResult.plan.tasks.find((x) => x.id === resolved);
                if (t) {
                  t.evidence = taskEvidenceFromLedger(taskWorkLedger);
                  await savePlan(planResult.plan).catch(() => undefined);
                }
              }
              taskWorkLedger = null;
            } else if (
              (stateRaw === "failed" || stateRaw === "skipped") &&
              taskWorkLedger?.taskId === resolved
            ) {
              taskWorkLedger = null;
            }
          }

          if (!alreadyPrintedIds.has(toolEventId)) {
            const toolCallLine =
              chalk.cyan(`  ▶ ${call.name}`) + chalk.gray(` ${formatToolArgs(call)}`);
            writeToolCall(
              toolEventId,
              call,
              styleToolChatter(call, toolCallLine) + "\n",
            );
            alreadyPrintedIds.add(toolEventId);
          }

          if (planResult.plan) {
            writePlanUpdate(planResult.plan, planResult.display);
            // Refresh sticky root only if path already exists (not bare Desktop).
            const root = extractProjectRootFromPlan(planResult.plan);
            if (root) setActiveProjectRootIfValid(root);
          }

          const result = { ok: planResult.ok, output: planResult.modelNote };
          emitToolResult(toolEventId, result, planResult.modelNote);
          const statusIcon = result.ok ? chalk.green("  ✓") : chalk.red("  ✗");
          writeToolOutput(
            toolEventId,
            result.ok ? "ok\n" : "failed\n",
            statusIcon + "\n",
          );

          return {
            ok: planResult.ok,
            call,
            result,
            contextOutput: planResult.modelNote,
          };
        }
      }

      const scope = await loadScope();
      const decision = classifyToolCall(call, { scope });
      await auditLog("tool.classified", {
        call,
        decision,
        scope: isScopeActive(scope) ? (scope.name ?? "(unnamed)") : "(none)",
      });

      const livePlanForPreGate = await loadPlan(session.sessionId).catch(
        () => undefined,
      );

      // Plan mode: gather freely while the draft awaits accept. Once the user
      // approves (planApproved), mutates must run even if mode still says "plan"
      // for a beat — otherwise implement loops forever on gather-only blocks.
      if (
        isPlanMode &&
        !session.planApproved.value &&
        !isScratchOnlyWrite(call, scratchDir)
      ) {
        const cmd =
          typeof call.args.command === "string" ? call.args.command : "";
        const shellBlocked =
          (call.name === "shell.exec" || call.name === "shell.start") &&
          !isPlanModeAllowedShellCommand(cmd);
        const allowed = isPlanModeAllowedTool(call.name) && !shellBlocked;
        if (!allowed) {
          const reason =
            `plan mode — ${call.name} is blocked (gather-only). ` +
            `Use any recon/enum/scan/research tool; do not write project files or run active exploits. ` +
            `Put exploit/implement steps in plan.create tasks for after accept. ` +
            `Accept the plan (y/i or /implement) to switch to agent and execute.`;
          writeNotice("warn", reason, chalk.yellow(`  ⚠ ${reason}\n`));
          if (!alreadyPrintedIds.has(toolEventId)) {
            const toolCallLine =
              chalk.cyan(`  ▶ ${call.name}`) +
              chalk.gray(` ${formatToolArgs(call)}`);
            writeToolCall(
              toolEventId,
              call,
              styleToolChatter(call, toolCallLine) + "\n",
            );
            alreadyPrintedIds.add(toolEventId);
          }
          const result = { ok: false, output: reason, exitCode: 1 };
          emitToolResult(toolEventId, result, reason);
          writeToolOutput(
            toolEventId,
            "failed\n",
            chalk.red("  ✗") + "\n",
          );
          return {
            ok: false,
            call,
            result,
            contextOutput: reason,
          };
        }
      }

      const isMutatingAction =
        (decision.level === "confirm" || decision.level === "block") &&
        !isPreApprovalAllowedTool(call.name) &&
        !isScratchOnlyWrite(call, scratchDir);

      if (isMutatingAction) {
        const planNow =
          livePlanForPreGate ??
          (await loadPlan(session.sessionId).catch(() => undefined));
        if (planNow && !session.planApproved.value) {
          const reason = `plan awaiting approval — ${call.name} is blocked until the plan is accepted (/implement or Accept)`;
          writeNotice("warn", reason, chalk.yellow(`  ⚠ ${reason}\n`));
          const result = { ok: false, output: reason, exitCode: 1 };
          return {
            ok: false,
            call,
            result,
            contextOutput: reason,
            blockOrCancel: true,
          };
        }
      }


      if (session.planApproved.value) {
        const livePlanForGate = await loadPlan(session.sessionId).catch(
          () => undefined,
        );
        if (livePlanForGate) {
          const unfinished = livePlanForGate.tasks.some(
            (t) => t.state === "pending" || t.state === "in_progress",
          );
          const inProgress = livePlanForGate.tasks.find(
            (t) => t.state === "in_progress",
          );
          if (unfinished && !inProgress) {
            // tool.check / fs.list preflight: allow without auto-opening a task
            // (auto-start on preflight made models skip task.update and confused scope).
            const skipTaskGate =
              isPlanPreflightTool(call.name) ||
              (livePlanForGate.kind === "pentest" &&
                isReadOnlyReconTool(call.name));
            if (skipTaskGate) {
              // fall through
            } else {
              const pending = readyPlanTasks(livePlanForGate);
              // Title/command matching is only a soft ownership hint. If no
              // heuristic matches, preserve plan order instead of blocking.
              const nextPending =
                pickPendingTaskForToolCall(
                  pending,
                  call,
                  livePlanForGate.tasks.map((t) => t.title),
                ) ?? pending[0];
              if (nextPending) {
                markTask(livePlanForGate, nextPending.id, "in_progress");
                if (
                  livePlanForGate.status === "draft" ||
                  livePlanForGate.status === "approved"
                ) {
                  livePlanForGate.status = "in_progress";
                }
                await savePlan(livePlanForGate).catch(() => undefined);
                // Preserve evidence already credited to this task (e.g. pentest
                // recon that ran before the task was formally opened).
                if (
                  !taskWorkLedger ||
                  taskWorkLedger.taskId !== nextPending.id
                ) {
                  taskWorkLedger = ledgerFromTaskEvidence(
                    nextPending.id,
                    nextPending.evidence,
                  );
                }
                writePlanUpdate(
                  livePlanForGate,
                  renderPlanForTerminal(livePlanForGate) + "\n",
                );
                writeNotice(
                  "info",
                  `auto-started [${nextPending.id}] so work can continue`,
                  chalk.dim(
                    `  ℹ no task was in_progress — auto-started [${nextPending.id}] "${nextPending.title}" before ${call.name}\n`,
                  ),
                );
              }
            }
          }
        }
      }


      call = applyDestinationCwd(
        call,
        destinationHint ?? getActiveProjectRoot(),
      );

      // Soft preflight: refuse scaffold into an existing non-empty project
      // (avoids endless "Operation cancelled" retries across all stacks).
      if (
        (call.name === "shell.exec" || call.name === "shell.start") &&
        typeof call.args.command === "string" &&
        isScaffoldCreateCommand(call.args.command)
      ) {
        const cwdArg =
          typeof call.args.cwd === "string" ? call.args.cwd : undefined;
        const conflict = scaffoldTargetConflictMessage(
          call.args.command,
          cwdArg,
        );
        if (conflict) {
          const target = resolveScaffoldTargetPath(call.args.command, cwdArg);
          const materialized = scaffoldLooksMaterialized(target);
          if (target && materialized && setActiveProjectRootIfValid(target, { force: true })) {
            await persistProjectRootOnPlan(target);
          }
          const message = materialized
            ? `Scaffold skipped: the target already contains a usable project${target ? ` at ${target}` : ""}. Continue that project directly; do not re-run the scaffolder.`
            : `Scaffold was not run: the existing target${target ? ` at ${target}` : ""} is incomplete. Inspect and repair it before completing the scaffold task; do not retry the scaffolder into this non-empty directory.`;
          writeNotice(
            "info",
            message,
            chalk.dim(`  ℹ ${message}\n`),
          );
          if (!alreadyPrintedIds.has(toolEventId)) {
            const toolCallLine =
              chalk.cyan(`  ▶ ${call.name}`) +
              chalk.gray(` ${formatToolArgs(call)}`);
            writeToolCall(
              toolEventId,
              call,
              styleToolChatter(call, toolCallLine) + "\n",
            );
            alreadyPrintedIds.add(toolEventId);
          }
          const result = { ok: true, output: message, exitCode: 0 };
          emitToolResult(toolEventId, result, message);
          writeToolOutput(
            toolEventId,
            "ok\n",
            chalk.green("  ✓") + "\n",
          );
          return {
            ok: true,
            call,
            result,
            contextOutput: message,
          };
        }
      }

      if (call.name === "web.search") {
        sawFreshWebSearch = true;
      }

      if (!alreadyPrintedIds.has(toolEventId)) {
        const toolCallLine =
          chalk.cyan(`  ▶ ${call.name}`) + chalk.gray(` ${formatToolArgs(call)}`);
        writeToolCall(
          toolEventId,
          call,
          styleToolChatter(call, toolCallLine) + "\n",
        );
        alreadyPrintedIds.add(toolEventId);
      }

      const scopeTarget = scopeTargetForToolCall(call);
      const engagementAction =
        pentestSession || isPentestToolCall(call) || Boolean(scope)
          ? engagementActionForToolCall(call)
          : undefined;
      const engagementDecision = engagementAction
        ? evaluateEngagementAction(scope, engagementAction)
        : undefined;
      if (engagementAction && engagementDecision) {
        if (scope) {
          engagementGraph = await openEngagement(scope);
          engagementRecord = beginEngagementAction(engagementGraph, {
            tool: call.name,
            target: engagementDecision.normalizedTarget || engagementAction.target,
            phase: engagementDecision.phase,
            capability: engagementDecision.capability,
            authorized: engagementDecision.allowed,
            reason: engagementDecision.reason,
          });
          await saveEngagement(engagementGraph);
        }
        await auditLog("engagement.policy", {
          ...(engagementGraph ? { engagementId: engagementGraph.id } : {}),
          ...(engagementRecord ? { actionId: engagementRecord.id } : {}),
          tool: call.name,
          target: engagementDecision.normalizedTarget,
          phase: engagementDecision.phase,
          capability: engagementDecision.capability,
          allowed: engagementDecision.allowed,
          reason: engagementDecision.reason,
        });
        if (!engagementDecision.allowed) {
          const target = engagementDecision.normalizedTarget || scopeTarget || engagementAction.target;
          const reason =
            `Blocked engagement action for ${target}: ${engagementDecision.reason}. ` +
            scopeHint(target);
          writeToolBlocked(
            toolEventId,
            call.name,
            reason,
            chalk.red(`  ✗ ${reason}\n`),
          );
          const result = { ok: false, output: reason, exitCode: 1 };
          emitToolResult(toolEventId, result, reason);
          return { ok: false, call, result, contextOutput: reason };
        }
      }

      if (decision.level === "block") {
        writeToolBlocked(
          toolEventId,
          call.name,
          decision.reason,
          chalk.red(`  ✗ blocked: ${decision.reason}`) + "\n",
        );
        const message = `Blocked: ${call.name} — ${decision.reason}`;
        const result = { ok: false, output: message, exitCode: 1 };

        return {
          ok: false,
          call,
          result,
          contextOutput: `${message}\nThis tool call did not run. Continue the task using a safer allowed method; do not retry the same blocked command unchanged.`,
        };
      }

      let authorized = true;
      let pentestJustConfirmed = false;

      const releasePrompt = await promptMutex.acquire();
      try {
        parentSignal.throwIfAborted();
        const needsPentestAuth =
          isPentestToolCall(call) &&
          !getConfig().pentestAuthorized &&
          !session.pentestAuthorized.value;
        authorized = await ensurePentestAuthorization(
          call,
          Boolean(options.autoConfirm),
          session,
          confirmPort,
        );
        restoreInteractiveStdin();
        if (!authorized) {
          const lastAnswer = "Pentest authorization not confirmed.";
          writeToolBlocked(
            toolEventId,
            call.name,
            lastAnswer,
            chalk.red(`  ✗ ${lastAnswer}`) + "\n",
          );
          const result = { ok: false, output: lastAnswer, exitCode: 1 };
          return {
            ok: false,
            call,
            result,
            contextOutput: lastAnswer,
            lastAnswer,
            blockOrCancel: true,
          };
        }
        if (needsPentestAuth) {
          pentestJustConfirmed = true;
        }

        // Always confirm destructive deletes and any write outside cwd —
        // even when permissions=allow-all or -y (user requirement).
        let forceConfirm = call.name === "fs.delete";
        if (
          call.name === "fs.write" ||
          call.name === "fs.writeMany" ||
          call.name === "fs.edit" ||
          call.name === "fs.append" ||
          call.name === "fs.replaceLines" ||
          call.name === "fs.delete"
        ) {
          const paths: string[] = [];
          if (typeof call.args.path === "string") paths.push(call.args.path);
          if (Array.isArray(call.args.files)) {
            for (const entry of call.args.files) {
              if (
                entry &&
                typeof entry === "object" &&
                typeof (entry as { path?: unknown }).path === "string"
              ) {
                paths.push((entry as { path: string }).path);
              }
            }
          }
          for (const p of paths) {
            try {
              if (isOutsideWorkingDirectory(resolveFsToolPath(p))) {
                forceConfirm = true;
                break;
              }
            } catch {
              forceConfirm = true;
              break;
            }
          }
        }

        if (
          (decision.level === "confirm" || forceConfirm) &&
          !pentestJustConfirmed
        ) {
          const ok = await confirmToolExecution(
            call,
            forceConfirm ? false : Boolean(options.autoConfirm),
            session,
            confirmPort,
            forceConfirm ? { forceConfirm: true } : undefined,
          );
          restoreInteractiveStdin();
          if (!ok) {
            const lastAnswer = "Cancelled.";
            writeToolBlocked(
              toolEventId,
              call.name,
              lastAnswer,
              chalk.red(`  ✗ cancelled`) + "\n",
            );
            const result = { ok: false, output: lastAnswer, exitCode: 1 };
            return {
              ok: false,
              call,
              result,
              contextOutput: lastAnswer,
              lastAnswer,
              blockOrCancel: true,
            };
          }
        }
      } finally {
        releasePrompt();
      }

      parentSignal.throwIfAborted();
      const planAtDispatch = await loadPlan(session.sessionId).catch(
        () => undefined,
      );
      dispatchedTaskId = planAtDispatch?.tasks.find(
        (task) => task.state === "in_progress",
      )?.id;
      if (!dispatchedTaskId && planAtDispatch?.kind === "pentest") {
        const candidate = pickPendingTaskForToolCall(
          readyPlanTasks(planAtDispatch),
          call,
          planAtDispatch.tasks.map((task) => task.title),
        );
        dispatchedTaskId = candidate?.id;
      }
      if (
        dispatchedTaskId &&
        (!taskWorkLedger || taskWorkLedger.taskId !== dispatchedTaskId)
      ) {
        const dispatchedTask = planAtDispatch?.tasks.find(
          (task) => task.id === dispatchedTaskId,
        );
        taskWorkLedger = ledgerFromTaskEvidence(
          dispatchedTaskId,
          dispatchedTask?.evidence,
        );
      }
      if (engagementAction) {
        engagementLease = engagementPolicy.acquire(scope, engagementAction);
        if (!engagementLease.decision.allowed) {
          const reason = `Blocked engagement action: ${engagementLease.decision.reason}`;
          const result = { ok: false, output: reason, exitCode: 1 };
          emitToolResult(toolEventId, result, reason);
          return { ok: false, call, result, contextOutput: reason };
        }
      }
      if (turnState.state === "understanding" || turnState.state === "exploring") {
        moveTurn("acting", `executing ${call.name}`);
      }
      options.onToolStart?.(call);
      // Card was "queued" since writeToolCall; flip to running only when work starts.
      emit({ type: "tool-start", id: toolEventId });
      writeStatus(call.name, chalk.dim(`  → ${call.name}\n`));

      // Elevation uses the secure secret modal (TUI) or is refused — never
      // a raw TTY "Password:" that freezes the UI. No misleading notice.

      const toolAc = new AbortController();
      const onParentAbort = () => toolAc.abort();
      parentSignal.addEventListener("abort", onParentAbort);

      let result: ToolResult;
      let liveBytes = 0;
      // Stream every live byte — never drop mid-run. After the tool finishes we
      // still replace the spool with the authoritative full `result.output`.
      const printLive = (chunk: string): void => {
        if (
          call.name === "fs.read" ||
          call.name === "fs.list" ||
          call.name === "fs.search"
        )
          return;
        if (!chunk) return;
        liveBytes += chunk.length;
        const indented = chunk.replace(/\r/g, "").replace(/\n(?!$)/g, "\n  ");
        const body = indented.startsWith("\n") ? indented : `  ${indented}`;
        writeToolOutput(toolEventId, chunk, chalk.dim(body));
      };

      const jobId = randomUUID().slice(0, 8);
      const emptyJobArtifact = () => ({
        path: "",
        chunks: [] as string[],
        bytes: 0,
        droppedBytes: 0,
        redacted: false,
        sha256: "",
      });
      const backgroundJob: BackgroundJob = {
        id: jobId,
        command: `${call.name} ${formatToolArgs(call)}`,
        commandDisplay: `${call.name} ${formatToolArgs(call)}`,
        cwd: safeCwd(),
        status: "running",
        startedAt: new Date().toISOString(),
        artifactPath: "",
        stdoutArtifact: "",
        stderrArtifact: "",
        artifacts: { stdout: emptyJobArtifact(), stderr: emptyJobArtifact() },
        redactionProfile: "provider-secrets-v1",
        ownerSessionId: session.sessionId,
      };
      jobManager.registerJob(jobId, backgroundJob, toolAc);


      const TOOL_STALL_ABORT_MS = toolStallBudgetMs(call);
      const TOOL_HARD_BUDGET_MS = toolHardBudgetMs(call);
      const stallSecs = Math.round(TOOL_STALL_ABORT_MS / 1000);
      const hardSecs = Math.round(TOOL_HARD_BUDGET_MS / 1000);
      let stallTimer: NodeJS.Timeout | undefined;
      let hardTimer: NodeJS.Timeout | undefined;
      let graceTimer: NodeJS.Timeout | undefined;
      let stalledByWatchdog = false;
      let hardTimedOut = false;
      let forceSettled = false;
      const resetStallTimer = (): void => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          if (!toolAc.signal.aborted) {
            stalledByWatchdog = true;
            writeNotice(
              "warn",
              `${call.name} has been running for >${stallSecs}s without output — cancelling stalled tool`,
              chalk.yellow(
                `  ⏳ ${call.name} stalled for >${stallSecs}s without output — cancelling\n`,
              ),
            );
            toolAc.abort();
          }
        }, TOOL_STALL_ABORT_MS);
        // Node: do not keep the process alive solely for the stall timer.
        (stallTimer as unknown as { unref?: () => void }).unref?.();
      };
      resetStallTimer();

      /**
       * Force-settle a hung tool promise after abort or hard budget.
       * Some transports ignore AbortSignal; without this race the agent
       * could freeze for minutes after "cancelling stalled tool".
       */
      const runToolWithForcedSettle = (): Promise<ToolResult> => {
        const work = runToolCall(call, {
          signal: toolAc.signal,
          requestSecret: options.requestSecret,
          onOutput: (chunk) => {
            if (toolAc.signal.aborted) return;
            resetStallTimer();
            printLive(chunk);
          },
          confirmed: true,
          userPrompt: prompt,
          ...(engagementAction && scope
            ? {
              engagementAuthorization: {
                target: engagementDecision?.normalizedTarget || engagementAction.target,
                ...(scope.expiresAt ? { expiresAt: scope.expiresAt } : {}),
              },
              authorizeNetworkHop: async (url: string, resolvedAddresses: string[]) => {
                const hop = actionFromUrl({
                  url,
                  method: engagementAction.method,
                  phase: engagementAction.phase,
                  capability: engagementAction.capability,
                  resolvedAddresses,
                });
                const hopDecision = evaluateEngagementAction(scope, hop);
                await auditLog("engagement.policy.hop", {
                  ...(engagementGraph ? { engagementId: engagementGraph.id } : {}),
                  ...(engagementRecord ? { actionId: engagementRecord.id } : {}),
                  url,
                  resolvedAddresses,
                  allowed: hopDecision.allowed,
                  reason: hopDecision.reason,
                });
                return { allowed: hopDecision.allowed, reason: hopDecision.reason };
              },
            }
            : {}),
        });

        return new Promise<ToolResult>((resolve, reject) => {
          let settled = false;
          const finishOk = (r: ToolResult): void => {
            if (settled) return;
            settled = true;
            if (graceTimer) clearTimeout(graceTimer);
            resolve(r);
          };
          const finishErr = (err: unknown): void => {
            if (settled) return;
            settled = true;
            if (graceTimer) clearTimeout(graceTimer);
            reject(err);
          };
          const forceCancelResult = (): ToolResult => {
            forceSettled = true;
            if (stalledByWatchdog) {
              return {
                ok: false,
                output: `Tool timed out after ${stallSecs}s without output (force-cancelled).`,
                exitCode: 124,
              };
            }
            if (hardTimedOut) {
              return {
                ok: false,
                output: `Tool hard-timeout after ${hardSecs}s — cancelled.`,
                exitCode: 124,
              };
            }
            return {
              ok: false,
              output: "Tool aborted before it could complete (force-cancelled).",
              exitCode: 130,
            };
          };
          const armGraceForceSettle = (): void => {
            if (settled || graceTimer) return;
            graceTimer = setTimeout(() => {
              if (settled) return;
              writeNotice(
                "warn",
                `${call.name} did not stop after cancel — force-settling`,
                chalk.yellow(
                  `  ⏳ ${call.name} ignore cancel — force-settling hung tool\n`,
                ),
              );
              finishOk(forceCancelResult());
            }, TOOL_ABORT_GRACE_MS);
            (graceTimer as unknown as { unref?: () => void }).unref?.();
          };

          work.then(finishOk, finishErr);

          // Hard wall-clock: abort + force-settle after budget.
          hardTimer = setTimeout(() => {
            if (settled) return;
            hardTimedOut = true;
            writeNotice(
              "warn",
              `${call.name} exceeded ${hardSecs}s hard budget — cancelling`,
              chalk.yellow(
                `  ⏳ ${call.name} hard-timeout (${hardSecs}s) — cancelling\n`,
              ),
            );
            if (!toolAc.signal.aborted) toolAc.abort();
            armGraceForceSettle();
          }, TOOL_HARD_BUDGET_MS);
          (hardTimer as unknown as { unref?: () => void }).unref?.();

          // After any abort (stall, user Esc/Ctrl+C, parent), force-settle
          // if the tool promise does not resolve within the grace window.
          const onToolAbort = (): void => armGraceForceSettle();
          if (toolAc.signal.aborted) onToolAbort();
          else toolAc.signal.addEventListener("abort", onToolAbort, { once: true });
        });
      };

      try {
        result = await runToolWithForcedSettle();
        // User Esc/Ctrl+C: force-settle may resolve with a cancel result
        // instead of throwing — still end the turn as aborted.
        if (parentSignal.aborted && !stalledByWatchdog && !hardTimedOut) {
          writeAbort();
          return {
            ok: false,
            call,
            result: { ok: false, output: "Aborted." },
            contextOutput: "Aborted.",
            lastAnswer: "Aborted.",
          };
        }
        if (liveBytes > 0) {
          writeToolOutput(toolEventId, "\n", "\n");
        }
        jobManager.updateJobStatus(
          jobId,
          result.ok ? "exited" : "failed",
          result.exitCode,
        );
      } catch (toolError) {
        jobManager.updateJobStatus(jobId, "failed", 1);
        if (isAbortError(toolError, toolAc.signal) || forceSettled) {
          if (parentSignal.aborted && !stalledByWatchdog && !hardTimedOut) {
            writeAbort();
            return {
              ok: false,
              call,
              result: { ok: false, output: "Aborted." },
              contextOutput: "Aborted.",
              lastAnswer: "Aborted.",
            };
          }
          result = {
            ok: false,
            output: stalledByWatchdog
              ? `Tool timed out after ${TOOL_STALL_ABORT_MS / 1_000}s without output.`
              : hardTimedOut
                ? `Tool hard-timeout after ${hardSecs}s — cancelled.`
                : "Tool aborted before it could complete.",
            exitCode: stalledByWatchdog || hardTimedOut ? 124 : 130,
          };
        } else {
          const errMsg =
            toolError instanceof Error ? toolError.message : String(toolError);
          result = { ok: false, output: `Tool error: ${errMsg}`, exitCode: 1 };
        }
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
        if (hardTimer) clearTimeout(hardTimer);
        if (graceTimer) clearTimeout(graceTimer);
        engagementLease?.release();
        parentSignal.removeEventListener("abort", onParentAbort);
      }


      if (
        (call.name === "shell.exec" || call.name === "shell.start") &&
        typeof call.args.command === "string" &&
        isScaffoldCreateCommand(call.args.command)
      ) {
        const cmd = call.args.command;
        const cwdArg =
          typeof call.args.cwd === "string" ? call.args.cwd : undefined;
        const out = result.output ?? "";
        // Prefer path reported by the scaffolder (handles quoted-cd mis-parse leftovers).
        const fromOutput = out.match(
          /Scaffolding project in\s+([^\n]+?)\s*\.{0,3}\s*$/im,
        )?.[1]?.trim().replace(/['"]/g, "");
        const fromScaffold =
          (fromOutput && fromOutput.startsWith("/")
            ? fromOutput
            : undefined) ??
          extractProjectRootFromScaffold(cmd, cwdArg);
        const cancelled = isScaffoldCancelledOutput(out);
        let materialized = scaffoldLooksMaterialized(fromScaffold);
        // One re-check: create-vite can report success before FS snapshot is visible.
        if (!materialized && fromScaffold) {
          materialized = scaffoldLooksMaterialized(fromScaffold);
        }
        const abortedMid =
          !result.ok &&
          (result.exitCode === 124 ||
            result.exitCode === 130 ||
            /timed out|aborted|Command aborted/i.test(out));
        const resumableMaterialized = Boolean(
          fromScaffold && materialized && (cancelled || abortedMid || !result.ok),
        );
        if (resumableMaterialized && fromScaffold) {
          setActiveProjectRootIfValid(fromScaffold, { force: true });
          await persistProjectRootOnPlan(fromScaffold);
          result = {
            ...result,
            ok: true,
            exitCode: 0,
            output:
              out +
              (out.endsWith("\n") ? "" : "\n") +
              `The scaffold reported ${cancelled ? "cancellation/refusal" : "interruption"}, but a usable project tree already exists at ${fromScaffold} ` +
              `(package/manifest present). Treat this as resumable: do NOT re-run the scaffolder. ` +
              `Inspect the existing files, finish any missing install, implement the requested feature, then run/verify.`,
          };
          writeNotice(
            "info",
            `project root → ${fromScaffold} (existing materialized scaffold — continue)`,
            chalk.dim(
              `  ℹ existing scaffold at ${fromScaffold} — continue, do not re-create\n`,
            ),
          );
        } else if (result.ok && cancelled && !materialized) {
          result = {
            ok: false,
            output:
              out +
              (out.endsWith("\n") ? "" : "\n") +
              `Scaffold FAILED: tool reported cancel/refuse. ` +
              (fromScaffold ? `Expected project at ${fromScaffold}. ` : "") +
              `If the folder already exists, CONTINUE it (do not re-scaffold). Otherwise use a new empty name or hand-write a minimal tree.`,
            exitCode:
              result.exitCode && result.exitCode !== 0 ? result.exitCode : 1,
          };
        } else if (result.ok && !materialized) {
          // Soft warn only when we truly see no tree — do not flip ok if output
          // clearly scaffolded (path may still resolve on next tool).
          const claimedScaffold = /Scaffolding project in\b/i.test(out);
          if (!claimedScaffold) {
            result = {
              ok: false,
              output:
                out +
                (out.endsWith("\n") ? "" : "\n") +
                `Scaffold FAILED: target project tree was not created. ` +
                (fromScaffold ? `Expected project at ${fromScaffold}. ` : "") +
                `If the folder already exists, CONTINUE it (do not re-scaffold). Otherwise use a new empty name or hand-write a minimal tree.`,
              exitCode:
                result.exitCode && result.exitCode !== 0 ? result.exitCode : 1,
            };
          } else if (fromScaffold) {
            setActiveProjectRootIfValid(fromScaffold, { force: true });
            await persistProjectRootOnPlan(fromScaffold);
            writeNotice(
              "info",
              `project root → ${fromScaffold} (scaffold output claimed success — continue)`,
              chalk.dim(`  ℹ project root set to ${fromScaffold}\n`),
            );
          }
        } else if (result.ok && fromScaffold && materialized) {
          setActiveProjectRootIfValid(fromScaffold, { force: true });
          await persistProjectRootOnPlan(fromScaffold);
          writeNotice(
            "info",
            `project root → ${fromScaffold}`,
            chalk.dim(`  ℹ project root set to ${fromScaffold}\n`),
          );
        }
      }

      const output = result.output.trim();
      // Always keep a full on-disk copy of tool output (any size) so the
      // pager never depends on a truncated in-memory preview.
      const savedOutputPath =
        result.outputPath ??
        (output ? await saveToolOutput(call, output) : undefined);
      const resultWithArtifact: ToolResult = {
        ...result,
        outputPath: savedOutputPath,
        truncated: result.truncated ?? Boolean(savedOutputPath),
      };

      if (savedOutputPath) {
        const storedJob = jobManager.getJob(jobId);
        if (storedJob) {
          storedJob.artifactPath = savedOutputPath;
        }
      }

      const contextOutput = formatToolContext(call, resultWithArtifact);
      emitToolResult(
        toolEventId,
        resultWithArtifact,
        contextOutput,
        savedOutputPath,
      );
      options.onToolResult?.(call, resultWithArtifact);
      await auditLog("tool.result", {
        call,
        ok: result.ok,
        exitCode: result.exitCode,
        output: result.output.slice(0, 4_000),
      });
      if (engagementGraph && engagementRecord) {
        if (result.backgroundJob) {
          const checkpointInput = {
            jobId: result.backgroundJob.id,
            status: result.backgroundJob.status,
            artifactPath: result.backgroundJob.artifactPath,
            offset: result.backgroundJob.nextOffset ?? 0,
            observation: result.output.slice(0, 16_000),
          };
          const reconciled = reconcileEngagementJob(engagementGraph, checkpointInput);
          if (!reconciled || reconciled.actionId !== engagementRecord.id) {
            recordEngagementCheckpoint(engagementGraph, {
              actionId: engagementRecord.id,
              ...checkpointInput,
            });
          }
        } else {
          finishEngagementAction(engagementGraph, engagementRecord.id, {
            ok: result.ok,
            observation: result.output.slice(0, 16_000),
            ...(savedOutputPath ? { artifactPath: savedOutputPath } : {}),
            scannerLead: call.name === "net.scan" || call.name.startsWith("pentest."),
          });
        }
        await saveEngagement(engagementGraph);
      }

      const newEvidence = recordToolEvidence(outcomeState, {
        tool: call.name,
        callId: toolEventId,
        ok: result.ok,
        output: result.output,
        ...(savedOutputPath ? { artifact: savedOutputPath } : {}),
        ...(dispatchedTaskId ? { taskId: dispatchedTaskId } : {}),
        args: call.args,
      });
      let hypothesisDelta = 0;
      if (!result.ok) {
        const before = outcomeState.failedHypotheses.length;
        recordFailedHypothesis(outcomeState, {
          signature: `${call.name}:${result.exitCode ?? 1}`,
          premise: `${call.name} with ${JSON.stringify(call.args).slice(0, 1_000)}`,
        });
        hypothesisDelta = outcomeState.failedHypotheses.length - before;
        retryDependenciesChanged = false;
        retryEnvironmentChanged = false;
        moveTurn("exploring", `${call.name} failed; revise the premise`);
      } else {
        const mutatesDependencies =
          /^(?:fs\.(?:write|writeMany|edit|replaceLines|append|delete)|pkg\.install)$/.test(call.name) ||
          ((call.name === "shell.exec" || call.name === "shell.start") &&
            /\b(?:install|mkdir|create|generate|build)\b/i.test(String(call.args.command ?? "")));
        retryDependenciesChanged ||= mutatesDependencies;
        retryEnvironmentChanged ||=
          call.name === "pkg.install" ||
          ((call.name === "shell.exec" || call.name === "shell.start") &&
            isPackageInstallCommand(String(call.args.command ?? "")));
      }
      const governed = governProgress(governorState, "activity", {
        evidenceDelta: newEvidence.length,
        hypothesisDelta,
        repetitionScore: loopGuard.getAttemptCount(call.name, call.args) > 1 ? 1 : 0,
        policy: {
          resourceEnvelope: Math.max(12, maxSteps),
          emergencyCeiling: Math.max(70, maxSteps * 3),
          reflectionAfterNoDelta: 3,
          pauseAfterNoDelta: 6,
          repetitionThreshold: 0.8,
        },
      });
      governorState = governed.state;
      if (governed.recommendation === "reflect") {
        deferredPostToolMessages.push({
          role: "system",
          content: `PROGRESS GOVERNOR: ${governed.reason}. Reassess the current premise and choose the next action that can produce criterion-linked evidence.`,
        });
      } else if (governed.recommendation === "paused_budget") {
        governorPauseReason = governed.reason;
      }
      await saveOutcomeState(outcomeState);

      loopGuard.recordAttempt(
        step,
        call.name,
        call.args,
        result.ok,
        result.exitCode,
      );

      // Evidence for verify-before-done: only successful real work counts.
      if (result.ok && isEvidenceWorkTool(call.name)) {
        const liveAfter = await loadPlan(session.sessionId).catch(
          () => undefined,
        );
        // Never credit whichever task happens to be open after execution: a
        // later task.update in the same batch may already have changed it.
        const creditId = dispatchedTaskId;
        const cmd =
          typeof call.args.command === "string" ? call.args.command : "";
        const signals: TaskWorkSignals = {};
        if (isFeatureImplementationCall(call)) signals.featureWrite = true;
        if (
          call.name === "fs.write" ||
          call.name === "fs.writeMany" ||
          call.name === "fs.edit" ||
          call.name === "fs.replaceLines" ||
          call.name === "fs.append"
        ) {
          signals.sourceWrite = true;
        }
        if (
          (call.name === "shell.exec" || call.name === "shell.start") &&
          isPackageInstallCommand(cmd)
        ) {
          signals.installOk = true;
        }
        if (
          (call.name === "shell.exec" || call.name === "shell.start") &&
          isScaffoldCreateCommand(cmd)
        ) {
          signals.scaffoldOk = true;
        }
        if (isDevServerCall(call)) signals.devServerStart = true;
        const out = result.output ?? "";
        if (
          (call.name === "shell.tail" || call.name === "shell.start") &&
          isServerReadyOutput(out)
        ) {
          signals.serverReady = true;
        }
        if (
          call.name === "shell.exec" &&
          isPortListeningOutput(cmd, out)
        ) {
          signals.portListening = true;
        }
        if (
          localHttpProbeIsSuccess(out) ||
          (sawLocalHttpProbe && !sawFailedLocalHttpProbe)
        ) {
          // Prefer explicit success parse on this result
          if (
            /\b(localhost|127\.0\.0\.1)\b/i.test(
              `${call.name} ${cmd} ${JSON.stringify(call.args)}`,
            )
          ) {
            if (localHttpProbeIsSuccess(out)) {
              signals.localHttpProbeOk = true;
            }
          }
        }
        // Remote/pentest evidence — never conflate with local app runtime
        if (isRemoteReconToolCall(call)) signals.remoteReconOk = true;
        if (isRemoteActiveTestCall(call)) signals.remoteActiveTestOk = true;
        // Always bank the success for later absorb (preflight / no open task).
        sessionLooseWork.push({
          toolName: call.name,
          ...(Object.keys(signals).length > 0 ? { signals } : {}),
        });
        taskWorkLedger = recordTaskWorkSuccess(
          taskWorkLedger,
          creditId,
          call.name,
          signals,
        );
        // If nothing was open, still try to attach to the next ready explore
        // task so "Check Node/npm" can complete without thrash.
        if ((!creditId || !taskWorkLedger || taskWorkLedger.taskId !== creditId) && liveAfter) {
          const ready = readyPlanTasks(liveAfter)[0];
          if (ready) {
            const absorbed = absorbLooseWorkIntoLedger(
              ledgerFromTaskEvidence(ready.id, ready.evidence),
              ready.id,
              ready.title,
              [{ toolName: call.name, signals }],
              { planKind: liveAfter.kind },
            );
            if (absorbed && absorbed.successWorkCount > 0) {
              const task = liveAfter.tasks.find((t) => t.id === ready.id);
              if (task) {
                task.evidence = taskEvidenceFromLedger(absorbed);
                if (
                  !taskWorkLedger ||
                  taskWorkLedger.taskId !== ready.id ||
                  taskWorkLedger.successWorkCount < absorbed.successWorkCount
                ) {
                  taskWorkLedger = absorbed;
                }
                await savePlan(liveAfter).catch(() => undefined);
              }
            }
          }
        }
        if (liveAfter && creditId && taskWorkLedger?.taskId === creditId) {
          const task = liveAfter.tasks.find((candidate) => candidate.id === creditId);
          if (task) {
            task.evidence = taskEvidenceFromLedger(taskWorkLedger);
            await savePlan(liveAfter).catch(() => undefined);
          }
        }
        refreshSessionState(liveAfter);
      }


      if (!result.ok) {
        const reflection = loopGuard.getFailureReflection();
        if (reflection) {
          deferredPostToolMessages.push({ role: "system", content: reflection });
          const failCount = loopGuard.consecutiveFailureCount();
          writeNotice(
            "warn",
            `${failCount} consecutive failures — model evaluating approach`,
            chalk.yellow(
              `  ⚠ ${failCount} consecutive failures — evaluating approach\n`,
            ),
          );
        }
      }

      const statusIcon = result.ok ? chalk.green("  ✓") : chalk.red("  ✗");
      // Classic stdout gets a short status glyph; the event stream / spool
      // must NOT be polluted with "ok"/"failed" (the card already shows status).
      if (writesDirectly) {
        process.stdout.write(statusIcon + "\n");
      }
      if (output) {
        // Authoritative FULL body — replace any live stream so the pager
        // never shows a truncated mid-run preview. Never cap for the UI.
        const fullChunk = output.endsWith("\n") ? output : `${output}\n`;
        if (!writesDirectly) {
          writeToolOutput(toolEventId, fullChunk, "", { replace: true });
        } else {
          // Classic stdout: short preview only; full text is on disk.
          const displayMax = 6_000;
          const displaySummary = summarizeOutput(output, displayMax);
          const displayText = displaySummary.truncated
            ? `${displaySummary.text}${savedOutputPath ? chalk.dim(`\n  ... full output saved to ${savedOutputPath}`) : ""}`
            : displaySummary.text;
          const renderedOutput = indentAndWrapText(displayText);
          process.stdout.write(styleToolChatter(call, renderedOutput) + "\n");
          if (savedOutputPath && displaySummary.truncated) {
            process.stdout.write(
              chalk.dim(`  full output saved to ${savedOutputPath}\n`),
            );
          }
        }
      }

      if (output) {
        const viewport = registerViewport({
          toolName: call.name,
          argsDisplay: formatToolArgs(call),
          artifactPath: savedOutputPath,
          summary: contextOutput,
        });

        if (writesDirectly && savedOutputPath) {
          const short = chalk.dim(`  saved ${savedOutputPath}\n`);
          process.stdout.write(short);
        } else if (writesDirectly) {
          const viewportHint = `${formatViewportHint(viewport)}\n`;
          process.stdout.write(viewportHint);
        }
      }

      return { ok: result.ok, call, result, contextOutput };
    }


    const AUTO_COMPACT_KEEP_RECENT = 6;
    let lastCompactionMsgCount = 0;

    const summarizeForCompaction = async (
      summaryPrompt: string,
    ): Promise<string> => {
      const response = await completeWithProvider({
        provider,
        model,
        messages: [
          { role: "system", content: COMPACTION_SYSTEM_PROMPT },
          { role: "user", content: summaryPrompt },
        ],
        temperature: 0.1,
        maxTokens: 4_096,
        signal: options.signal,
      });
      return response.text;
    };

    async function maybeAutoCompact(
      reason: string,
      force = false,
    ): Promise<void> {
      const beforeTokens = estimateMessagesTokens(messages);
      if (!force && beforeTokens < AUTO_COMPACT_TOKEN_BUDGET) return;
      if (messages.length <= AUTO_COMPACT_KEEP_RECENT + 2) return;
      // Avoid compaction loops: don't re-compact until enough new messages have
      // accumulated since the last compaction.
      if (messages.length <= lastCompactionMsgCount + 4) return;
      try {
        const result = await compactMessagesWithSummary(
          messages,
          summarizeForCompaction,
          { budgetTokens: 0, keepRecent: AUTO_COMPACT_KEEP_RECENT },
        );
        if (!result.summarized || result.afterTokens >= beforeTokens) return;
        messages.splice(0, messages.length, ...result.messages);
        loopGuard.resetReadOnly();
        // Token stats BEFORE plan re-injection so the reduction is accurate.
        const compactedTokens = estimateMessagesTokens(messages);
        // Re-inject the live plan so the model keeps full plan awareness even
        // after older turns (which carried the plan context) were summarized.
        const livePlan = await loadPlan(session.sessionId).catch(
          () => undefined,
        );
        if (livePlan) {
          messages.push({
            role: "system",
            content: planContextMessage(livePlan, session.planApproved.value),
          });
        }
        // Re-inject live SESSION STATE after compaction (older flags survive).
        refreshSessionState(livePlan);
        lastCompactionMsgCount = messages.length;
        // Final count the model actually receives (may include re-injected plan).
        const afterTokens = estimateMessagesTokens(messages);
        await auditLog("agent.compact", {
          newLength: messages.length,
          estimatedTokens: afterTokens,
          reason,
        });

        const insertedSummary =
          messages.find((m) => isCompactionMemoryMessage(m))?.content ?? "";
        const summaryText = insertedSummary.startsWith(
          `${PLAN_IMPLEMENT_MEMORY_PREFIX}\n\n`,
        )
          ? insertedText(insertedSummary, `${PLAN_IMPLEMENT_MEMORY_PREFIX}\n\n`)
          : insertedSummary.startsWith(`${COMPACTION_MEMORY_PREFIX}\n\n`)
            ? insertedText(insertedSummary, `${COMPACTION_MEMORY_PREFIX}\n\n`)
            : insertedText(
                insertedSummary,
                insertedSummary.startsWith(PLAN_IMPLEMENT_MEMORY_PREFIX)
                  ? PLAN_IMPLEMENT_MEMORY_PREFIX
                  : COMPACTION_MEMORY_PREFIX,
              );
        // Card shows pre/post of the summarization; plan re-injection is noted.
        writeCompacted(summaryText, beforeTokens, compactedTokens);
        const planNote =
          afterTokens > compactedTokens
            ? ` (compacted to ~${compactedTokens.toLocaleString()}, +plan → ~${afterTokens.toLocaleString()})`
            : "";
        writeNotice(
          "info",
          `context auto-compacted to fit the window (~${beforeTokens.toLocaleString()} → ~${compactedTokens.toLocaleString()} tokens${planNote})`,
          chalk.dim(
            `  ℹ context auto-compacted (~${beforeTokens.toLocaleString()} → ~${compactedTokens.toLocaleString()} tokens${planNote})\n`,
          ),
        );
      } catch (error) {
        if (
          error instanceof Error &&
          (error.name === "AbortError" || error.message.includes("aborted"))
        ) {
          throw error;
        }
        // Summarization failed — DO NOT fall back to a mechanical dump. Keep the
        // current context and continue; we'll try again as it keeps growing.
        await auditLog("agent.compact.failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {

      visibleCommitted = false;
      // `step` is the productive-step index (used for display + audit). It only
      // advances when the previous iteration actually executed a tool.
      step = productiveSteps;
      if (governorPauseReason) {
        const richSummary = await buildRichStopSummary(
          messages,
          session,
          productiveSteps,
        );
        outcomeState.outcome.status = "paused_budget";
        await saveOutcomeState(outcomeState);
        moveTurn("paused_budget", governorPauseReason);
        lastAnswer = richSummary;
        return finishTurn(
          lastAnswer,
          productiveSteps,
          "paused_budget",
          outcomeState.outcome.criteria
            .filter((criterion) => criterion.required && criterion.status !== "proven")
            .map((criterion) => criterion.statement),
          governorPauseReason,
        );
      }
      options.signal?.throwIfAborted();


      let call: ToolCall | undefined;
      let assistantText: {
        visible: string;
        thinkContent: string;
        hasThinking: boolean;
      };
      let recoveredFromBareJson = false;

      if (pendingCalls.length > 0) {

        call = pendingCalls.shift()!;
        assistantText = { visible: "", thinkContent: "", hasThinking: false };
        const batchStatus = `  ↳ continuing batch (${pendingCalls.length} more queued)\n`;
        writeStatus(batchStatus, chalk.dim(batchStatus));
      } else {

        await maybeAutoCompact("auto-token-budget");

        const streamLabel =
          step === 0 ? "waiting for model" : `step ${step + 1}`;
        let spinner = writesDirectly
          ? startThinkingSpinner(streamLabel, options.signal)
          : noopSpinner;
        if (!writesDirectly) {
          emit({ type: "status", text: streamLabel });
        }
        let sawReasoning = false;
        let inThinking = false;
        let emittedThinkingStatus = false;
        let generatedTokens = 0;
        let accumulatedText = "";
        const callIds: string[] = [];
        let streamedCallsCount = 0;

        const deferredToolCalls: { eventId: string; call: ToolCall; rendered: string }[] = [];
        const deltaParser = writesDirectly
          ? undefined
          : createThinkingStreamParser(
            (text) => emit({ type: "assistant-delta", text }),
            (text) => {
              if (!emittedThinkingStatus) {
                emittedThinkingStatus = true;
                emit({ type: "status", text: "thinking" });
              }
              emit({ type: "thinking-delta", text });
            },
          );
        let completion;
        let toolsAttached = false;
        try {
          // Re-resolve dialect each step so /model or sticky fallback apply.
          ({ dialect: toolDialect, native: nativeToolsActive } =
            resolveNativeTools(provider, model));
          if (messages[0]?.role === "system") {
            messages[0] = {
              role: "system",
              content: composeCurrentSystemPrompt(nativeToolsActive),
            };
          }
          const turnTools = selectToolDefs(
            nativeToolsActive,
            useCompactSystemPrompt,
          );
          toolsAttached = Boolean(turnTools?.length);
          await auditLog("agent.turn", {
            provider,
            model,
            tool_protocol: toolsAttached ? "native" : "text",
            dialect: toolDialect,
            step,
          });
          assertValidToolProtocol(messages);
          completion = await streamWithProvider(
            {
              provider,
              model,

              allowModelFallback: false,
              messages,

              temperature: /minimax-m3/i.test(model) ? 1.0 : 0.2,

              maxTokens: 32_768,
              signal: options.signal,
              thinking: retryWithoutThinking
                ? { ...config.thinking, enabled: false, effort: "low" }
                : config.thinking,
              ...(toolsAttached
                ? {
                  tools: turnTools,
                  toolChoice:
                    freshWebSearchRequired && !sawFreshWebSearch
                      ? ({ type: "function", name: "web.search" } as const)
                      : ("auto" as const),
                  parallelToolCalls: true,
                  // P2-3: emit tool cards as soon as the function name arrives.
                  onToolCallDelta: (delta) => {
                    if (!delta.name) return;
                    const name =
                      fromWireName(delta.name) ?? delta.name;
                    const existing = deferredToolCalls[delta.index];
                    if (existing) {
                      if (
                        delta.argumentsBytes &&
                        delta.argumentsBytes >= 4096 &&
                        !writesDirectly
                      ) {
                        emit({
                          type: "status",
                          text: `${name} (${Math.round(delta.argumentsBytes / 1024)}KB args)`,
                        });
                      }
                      return;
                    }
                    // Ensure slots are dense so index maps to deferredToolCalls[i].
                    while (deferredToolCalls.length < delta.index) {
                      deferredToolCalls.push({
                        eventId: `tool-${++nextToolEventId}`,
                        call: { name: "…", args: {} },
                        rendered: "",
                      });
                    }
                    const call = normalizeToolCall({
                      name,
                      args: {},
                    });
                    const eventId = `tool-${++nextToolEventId}`;
                    callIds.push(eventId);
                    alreadyPrintedIds.add(eventId);
                    const toolCallLine =
                      chalk.cyan(`  ▶ ${call.name}`) +
                      chalk.gray(` ${formatToolArgs(call)}`);
                    const entry = {
                      eventId,
                      call,
                      rendered:
                        styleToolChatter(call, toolCallLine) + "\n",
                    };
                    if (deferredToolCalls.length === delta.index) {
                      deferredToolCalls.push(entry);
                    } else {
                      deferredToolCalls[delta.index] = entry;
                    }
                    streamedCallsCount = Math.max(
                      streamedCallsCount,
                      deferredToolCalls.length,
                    );
                    if (!writesDirectly) {
                      emit({ type: "status", text: call.name });
                    } else {
                      spinner.stop();
                      spinner = startThinkingSpinner(
                        `tool ${call.name}…`,
                        options.signal,
                      );
                    }
                  },
                }
                : {}),
            },
            (token) => {
              deltaParser?.push(token);
              generatedTokens += 1;
              accumulatedText += token;

              // Early UI cards from text fences only when native tools are off
              // (native args stream as structured deltas, not prose).
              if (!toolsAttached) {
                const parsedCalls = parseAllToolCalls(accumulatedText);
                if (parsedCalls.length > streamedCallsCount) {
                  if (writesDirectly) {
                    spinner.stop();
                  }
                  while (streamedCallsCount < parsedCalls.length) {
                    const call = parsedCalls[streamedCallsCount]!;
                    const eventId = `tool-${++nextToolEventId}`;
                    callIds.push(eventId);
                    alreadyPrintedIds.add(eventId);

                    const toolCallLine =
                      chalk.cyan(`  ▶ ${call.name}`) +
                      chalk.gray(` ${formatToolArgs(call)}`);
                    deferredToolCalls.push({
                      eventId,
                      call,
                      rendered: styleToolChatter(call, toolCallLine) + "\n",
                    });
                    if (!writesDirectly) {
                      emit({ type: "status", text: call.name });
                    }
                    streamedCallsCount += 1;
                  }
                  if (writesDirectly) {
                    spinner = startThinkingSpinner(
                      `generating response (${generatedTokens} tokens)`,
                      options.signal,
                    );
                  }
                }
              }

              if (!sawReasoning && /<think/i.test(token)) {
                sawReasoning = true;
                inThinking = true;
                spinner.setLabel("thinking");
                if (!writesDirectly) emit({ type: "status", text: "thinking" });
              }
              if (/<\/think>/i.test(token)) {
                inThinking = false;
                spinner.setLabel("generating response (0 tokens)");
                generatedTokens = 0;
              }

              if (inThinking) {
                const cleaned = token.replace(/<\/?think[^>]*>/gi, "");
                if (cleaned) {
                  spinner.pushPreview(cleaned);
                  const approx = cleaned.split(/\s+/).filter(Boolean).length;
                  if (approx > 0) spinner.bumpReasoning(approx);
                }
              } else {
                if (generatedTokens % 10 === 0) {
                  spinner.setLabel(`generating response (${generatedTokens} tokens)`);
                }
              }
            },
            (status) => {
              spinner.stop();
              writeStatus(status, chalk.dim(status));
            },
          );
        } finally {
          // Always clear the spinner — abort, network error, or success.
          spinner.stop();
        }
        provider = completion.provider;
        model = completion.model;
        if (completion.usage) {
          emit({
            type: "token-usage",
            usage: completion.usage,
            model: completion.model,
          });
        }
        deltaParser?.finish();
        // Sticky text-only may have flipped dialect during stream retry.
        ({ dialect: toolDialect, native: nativeToolsActive } =
          resolveNativeTools(provider, model));
        // toolsAttached may have been true for the request; if sticky
        // fallback dropped tools, treat as text mode for this turn's parse.
        const usedNativeProtocol = Boolean(completion.toolCalls?.length) ||
          (toolsAttached && !isTextOnlyModel(provider, model));

        const assistantTextResult = rememberThinkingFromText(completion.text);
        assistantText = assistantTextResult;


        if (assistantText.hasThinking) {
          writeThinkingBlock(assistantText.thinkContent);
        }

        // Native-first: prefer structured toolCalls from the provider.
        let nativeToolCalls: NativeToolCall[] = completion.toolCalls ?? [];
        // Early UI cards: refresh args if stream deltas already opened cards;
        // otherwise create cards now (non-streaming / name-after-done providers).
        if (nativeToolCalls.length) {
          if (deferredToolCalls.length === 0) {
            for (const tc of nativeToolCalls) {
              const normalized = normalizeToolCall({
                name: tc.name,
                args: tc.args,
              });
              const eventId = `tool-${++nextToolEventId}`;
              callIds.push(eventId);
              alreadyPrintedIds.add(eventId);
              const toolCallLine =
                chalk.cyan(`  ▶ ${normalized.name}`) +
                chalk.gray(` ${formatToolArgs(normalized)}`);
              deferredToolCalls.push({
                eventId,
                call: normalized,
                rendered: styleToolChatter(normalized, toolCallLine) + "\n",
              });
            }
          } else {
            for (let i = 0; i < nativeToolCalls.length; i++) {
              const tc = nativeToolCalls[i]!;
              const normalized = normalizeToolCall({
                name: tc.name,
                args: tc.args,
              });
              const existing = deferredToolCalls[i];
              if (existing && existing.call.name !== "…") {
                existing.call = normalized;
                const toolCallLine =
                  chalk.cyan(`  ▶ ${normalized.name}`) +
                  chalk.gray(` ${formatToolArgs(normalized)}`);
                existing.rendered =
                  styleToolChatter(normalized, toolCallLine) + "\n";
              } else if (!existing || existing.call.name === "…") {
                const eventId =
                  existing?.eventId ?? `tool-${++nextToolEventId}`;
                if (!existing) {
                  callIds.push(eventId);
                  alreadyPrintedIds.add(eventId);
                }
                const toolCallLine =
                  chalk.cyan(`  ▶ ${normalized.name}`) +
                  chalk.gray(` ${formatToolArgs(normalized)}`);
                const entry = {
                  eventId,
                  call: normalized,
                  rendered: styleToolChatter(normalized, toolCallLine) + "\n",
                };
                if (existing) deferredToolCalls[i] = entry;
                else deferredToolCalls.push(entry);
              }
            }
          }
        }


        if (nativeToolCalls.length) {
          const first = nativeToolCalls[0]!;
          if (first.args?._parseError) {
            call = undefined;
          } else {
            call = normalizeToolCall({ name: first.name, args: first.args });
          }
        } else {
          call = parseToolCall(assistantText.visible, {
            strict: getConfig().parserStrict,
          });
          if (!call && assistantText.hasThinking) {
            call = parseToolCall(assistantText.thinkContent, {
              strict: getConfig().parserStrict,
            });
            if (call) {
              writeNotice(
                "info",
                "recovered tool call from thinking content",
                chalk.dim("  ℹ recovered tool call from thinking content\n"),
              );
            }
          }
        }


        if (looksLikePromptLeak(assistantText.visible)) {
          if (call || nativeToolCalls.length) {
            writeNotice(
              "warn",
              "suppressed tool call from apparent prompt leak",
              chalk.yellow("  ⚠ suppressed tool call — model appears to be repeating its system prompt\n"),
            );
          }
          call = undefined;
          nativeToolCalls = [];
          deferredToolCalls.length = 0;
        }


        if (nativeToolCalls.length) {
          // Only salvage when args failed to parse (truncated JSON). A clean
          // parse with finish_reason=length is a complete tool call — execute it.
          const writeTc = nativeToolCalls.find((tc) => {
            const isWrite =
              tc.name === "fs.write" ||
              tc.name === "fs.append" ||
              tc.name === "fs.writeMany";
            return isWrite && Boolean(tc.args?._parseError);
          });
          if (writeTc) {
            const raw =
              writeTc.rawArguments ??
              (typeof writeTc.args?._raw === "string"
                ? String(writeTc.args._raw)
                : undefined);
            const salvaged = salvageTruncatedWriteFromNative(
              writeTc.name,
              raw,
            );
            if (salvaged) {
              truncatedToolRetries += 1;
              if (truncatedToolRetries <= 5) {
                try {
                  const writeResult = await fsWrite(
                    salvaged.path,
                    salvaged.content,
                    { confirmed: true },
                  );
                  if (writeResult.ok) {
                    const lineCount = salvaged.content.split("\n").length;
                    writeNotice(
                      "info",
                      `native tool call was truncated — salvaged ${lineCount} lines and wrote to ${salvaged.path}`,
                      chalk.cyan(
                        `  ℹ native tool call was truncated — salvaged ${lineCount} lines to ${salvaged.path}\n`,
                      ),
                    );
                    // Pair assistant tool_calls with synthetic results so the
                    // next turn is not orphaned, then nudge for append.
                    appendAssistantWithTools(
                      messages,
                      assistantText.visible,
                      nativeToolCalls,
                    );
                    for (const tc of nativeToolCalls) {
                      appendToolResult(
                        messages,
                        tc.id,
                        tc.id === writeTc.id
                          ? `Tool ${tc.name} result (exit=0, ok=true):\nSalvaged partial write: ${lineCount} lines to ${salvaged.path}`
                          : `Tool ${tc.name} result (exit=1, ok=false):\nCancelled — sibling write was truncated and salvaged.`,
                        tc.name,
                        tc.id === writeTc.id,
                      );
                    }
                    const priorBytes = Buffer.byteLength(
                      salvaged.content,
                      "utf8",
                    );
                    const appendNudge = toolsAttached
                      ? `Your ${writeTc.name} tool call was cut off at the token limit, but the system salvaged the partial content and wrote ${lineCount} lines (${priorBytes} bytes) to ${salvaged.path}. ` +
                      `The file ends with: ${JSON.stringify(salvaged.lastLine)}\n\n` +
                      `CONTINUE by calling fs.append now with path=${JSON.stringify(salvaged.path)}, expectedPriorBytes=${priorBytes}, and content set to ONLY the remaining content not already on disk (prefer hundreds of lines per call). ` +
                      `Do not re-read the full file; do not re-send content already saved. Use the platform tool interface — no markdown fences.`
                      : `Your fs.write tool call was cut off at the token limit, but the system salvaged the partial content and wrote ${lineCount} lines (${priorBytes} bytes) to ${salvaged.path}. ` +
                      `The file ends with: ${JSON.stringify(salvaged.lastLine)}\n\n` +
                      `CONTINUE with ONE large fs.append of the remaining content:\n` +
                      '```tool\n{"name":"fs.append","args":{"path":' +
                      JSON.stringify(salvaged.path) +
                      ',"expectedPriorBytes":' +
                      priorBytes +
                      ',"content":"...ONLY the remaining content not already on disk..."}}\n```';
                    messages.push({
                      role: "user",
                      content: appendNudge,
                    });
                    nativeToolCalls = [];
                    call = undefined;
                    deferredToolCalls.length = 0;
                    continue;
                  }
                } catch {
                  // fall through to normal parse-error handling
                }
              }
            }
          }
        }


        if (!assistantText.visible.trim() && !call) {
          emptyVisibleRetries += 1;
          if (emptyVisibleRetries <= 3) {
            if (assistantText.hasThinking) {
              writeNotice(
                "warn",
                "model produced only thinking — nudging it to take action",
                chalk.yellow(
                  "  ⚠ model produced only thinking — nudging it to take action\n",
                ),
              );
            } else {
              writeNotice(
                "warn",
                "model returned an empty response — nudging it to answer",
                chalk.yellow(
                  "  ⚠ model returned an empty response — nudging it to answer\n",
                ),
              );
            }
            if (assistantText.hasThinking) retryWithoutThinking = true;
            pushAssistantHistory(
              stripThinking(collapseRepeatedText(completion.text)).visible,
            );
            // Keep nudges SHORT — cheap models lose the key instruction in long text.
            const buildNudge =
              freshWebSearchRequired && !sawFreshWebSearch
                ? toolsAttached
                  ? "No visible output. This is current or scheduled information: call web.search now. Do NOT answer from memory."
                  : "No visible output. This is current or scheduled information: emit exactly one valid ```tool block for web.search now. Do NOT answer from memory or hide the tool call in <think> tags."
                : isPlanMode && !activePlan
                  ? toolsAttached
                    ? "No visible output. In plan mode: gather context or call plan.create when ready (do not only describe the plan)."
                    : "No visible output. In plan mode: emit a ```tool block for research/recon or plan.create. " +
                    "Do NOT hide tool calls in <think> tags — put them in the visible response."
                  : toolsAttached
                    ? "No visible output. " + toolNudge(true)
                    : "No visible output. Emit a ```tool block or give your final answer. " +
                    "Do NOT hide tool calls in <think> tags — put them in the visible response.";
            messages.push(recoveryUserMessage(buildNudge));
            continue;
          }

          writeNotice(
            "warn",
            "model returned an empty response after retries — no answer produced",
            chalk.yellow(
              "  ⚠ model returned an empty response after retries — no answer produced\n",
            ),
          );
          return finishTurn("Model returned an empty response after retries.", step + 1);
        } else {
          // Reset the counter on any successful visible output or recovered call.
          emptyVisibleRetries = 0;
          retryWithoutThinking = false;
        }


        let bareArgsOnly = false;
        recoveredFromBareJson = false;
        if (!call) {
          const bare = recognizeBareToolJson(assistantText.visible);
          if (bare?.call) {
            call = bare.call;
            recoveredFromBareJson = true;
            writeNotice(
              "info",
              "recovered an unfenced tool call from bare JSON",
              chalk.dim("  ℹ recovered an unfenced tool call from bare JSON\n"),
            );
          } else if (bare?.argsOnly) {
            bareArgsOnly = true;
          }
        }
        // Also check thinking content for bare JSON calls.
        if (!call && assistantText.hasThinking) {
          const bareThink = recognizeBareToolJson(assistantText.thinkContent);
          if (bareThink?.call) {
            call = bareThink.call;
            recoveredFromBareJson = true;
            writeNotice(
              "info",
              "recovered an unfenced tool call from thinking content",
              chalk.dim(
                "  ℹ recovered an unfenced tool call from thinking content\n",
              ),
            );
          } else if (bareThink?.argsOnly) {
            bareArgsOnly = true;
          }
        }
        if (!call) {
          if (bareArgsOnly) {
            bareToolJsonRetries += 1;
            if (bareToolJsonRetries <= 3) {
              writeNotice(
                "warn",
                toolsAttached
                  ? "tool call missing its name — asking the model to call a tool properly"
                  : "tool call missing its name/fence — asking the model to re-emit a proper ```tool block",
                chalk.yellow(
                  toolsAttached
                    ? "  ⚠ tool call missing its name — asking the model to call a tool properly\n"
                    : "  ⚠ tool call missing its name/fence — asking the model to re-emit a proper ```tool block\n",
                ),
              );
              pushAssistantHistory(assistantText.visible);
              messages.push(
                recoveryUserMessage(
                  isPlanMode && !activePlan
                    ? toolsAttached
                      ? "Your previous message was a bare JSON args object with no tool name, so NOTHING ran. " +
                      "In plan mode: call plan.create (or research tools) via the platform tool interface."
                      : "Your previous message was a bare JSON args object with no tool name and no ```tool fence, so NOTHING ran. " +
                      "In plan mode, call plan.create with a proper ```tool block when ready, e.g.:\n" +
                      '```tool\n{"name":"plan.create","args":{"goal":"…","detail":"…","tasks":["…"],"kind":"coding"}}\n```'
                    : toolsAttached
                      ? "Your previous message was a bare JSON args object with no tool name, so NOTHING ran. " +
                      toolNudge(true) +
                      " Include the tool name and full args via the platform tool interface — do not use markdown fences."
                      : "Your previous message was a bare JSON args object with no tool name and no ```tool fence, so NOTHING ran. " +
                      "Reply with ONLY a fenced ```tool block of the form " +
                      '`{"name": "<tool>", "args": { ... }}`. For example, to read a PDF:\n' +
                      '```tool\n{"name":"pdf.read","args":{"path":"/abs/file.pdf"}}\n```\n' +
                      "Choose the correct tool name for the task and include those args.",
                ),
              );
              continue;
            }
            // Exhausted retries — fall through to the normal answer path.
          }

          if (
            /<\|tool_call(?:s_section)?_begin\|>|<\|tool_call_argument_begin\|>/i.test(
              assistantText.visible,
            )
          ) {
            writeNotice(
              "warn",
              "tool call was malformed or cut off — asking the model to retry in JSON form",
              chalk.yellow(
                "  ⚠ tool call was malformed or cut off — asking the model to retry in JSON form\n",
              ),
            );
            pushAssistantHistory(assistantText.visible);
            messages.push(
              recoveryUserMessage(
                toolsAttached
                  ? "Your previous tool call was malformed or truncated. " +
                  toolNudge(true) +
                  " Pass valid JSON arguments via the platform tool interface — do not use fence or sentinel markers."
                  : "Your previous tool call was malformed or truncated. " +
                  "Reply with ONLY a fenced ```tool block containing valid JSON " +
                  'of the form `{"name": "<tool>", "args": { ... }}`. ' +
                  "Do not use <|tool_call_begin|> markers.",
              ),
            );
            continue;
          }

          if (looksLikeTruncatedToolCall(assistantText.visible)) {
            truncatedToolRetries += 1;


            const salvaged = salvageTruncatedWrite(assistantText.visible);

            if (salvaged && truncatedToolRetries <= 5) {
              // Write the salvaged partial content
              try {
                const writeResult = await fsWrite(salvaged.path, salvaged.content, {
                  confirmed: true,
                });
                if (writeResult.ok) {
                  const lineCount = salvaged.content.split("\n").length;
                  writeNotice(
                    "info",
                    `tool call was truncated — salvaged ${lineCount} lines and wrote to ${salvaged.path}`,
                    chalk.cyan(
                      `  ℹ tool call was truncated — salvaged ${lineCount} lines to ${salvaged.path}\n`,
                    ),
                  );
                  pushAssistantHistory(
                    stripThinking(assistantText.visible).visible,
                  );
                  const priorBytes = Buffer.byteLength(salvaged.content, "utf8");
                  messages.push({
                    role: "user",
                    content: toolsAttached
                      ? `Your fs.write tool call was cut off at the token limit, but the system salvaged the partial content and wrote ${lineCount} lines (${priorBytes} bytes) to ${salvaged.path}. ` +
                      `The file ends with: ${JSON.stringify(salvaged.lastLine)}\n\n` +
                      `CONTINUE by calling fs.append now with path=${JSON.stringify(salvaged.path)}, expectedPriorBytes=${priorBytes}, and content set to ONLY the remaining content (prefer large chunks). Use the platform tool interface — no markdown fences.`
                      : `Your fs.write tool call was cut off at the token limit, but the system salvaged the partial content and wrote ${lineCount} lines (${priorBytes} bytes) to ${salvaged.path}. ` +
                      `The file ends with: ${JSON.stringify(salvaged.lastLine)}\n\n` +
                      `CONTINUE with ONE large fs.append of the remaining content (prefer hundreds of lines per call — do NOT use tiny ~100-line chunks):\n` +
                      '```tool\n{"name":"fs.append","args":{"path":' +
                      JSON.stringify(salvaged.path) +
                      ',"expectedPriorBytes":' +
                      priorBytes +
                      ',"content":"...ONLY the remaining content not already on disk..."}}\n```\n' +
                      `expectedPriorBytes must match the receipt so append cannot double-write. ` +
                      `Do NOT re-read the full file; do NOT re-send content already saved.`,
                  });
                  continue;
                }
              } catch {
                // Salvage failed — fall through to standard retry
              }
            }

            if (truncatedToolRetries <= 3) {
              writeNotice(
                "warn",
                "tool call was cut off (output too long) — asking the model to retry safely",
                chalk.yellow(
                  "  ⚠ tool call was cut off (output too long) — asking the model to retry safely\n",
                ),
              );
              pushAssistantHistory(
                stripThinking(assistantText.visible).visible,
              );
              messages.push({
                role: "user",
                content: toolsAttached
                  ? "Your previous tool call was cut off before it finished — the JSON was incomplete, so NOTHING ran. " +
                  "Prefer ONE complete fs.write when it fits. If the file is too large: (1) fs.write the first large section, " +
                  "(2) fs.append the rest with expectedPriorBytes from the write receipt, (3) repeat with large chunks. " +
                  "Keep reasoning SHORT and call the tool via the platform interface. Do NOT claim a file was written until a tool call succeeds."
                  : "Your previous tool call was cut off before it finished — the JSON was incomplete, so NOTHING ran. " +
                  "Prefer ONE complete fs.write when it fits (~32k output tokens is a lot of file content if reasoning stays short). " +
                  "If the file is too large for one call:\n" +
                  "1. fs.write the first large section (as much as fits — hundreds+ of lines)\n" +
                  "2. fs.append the rest with expectedPriorBytes from the write receipt\n" +
                  "3. Repeat append only if still incomplete — large chunks, not ~100-line drips\n" +
                  "Keep reasoning SHORT — emit the ```tool block early. Do NOT claim a file was written until a tool call succeeds.",
              });
              continue;
            }
            // Exhausted retries — fall through so we don't loop forever, but the
            // user at least sees the (broken) output and the stop notice.
          }

          const hasFencedCallShape =
            countToolFences(assistantText.visible) > 0 &&
            /```tool\s*\n[\s\S]*?"(?:name|args)"\s*:/i.test(
              assistantText.visible,
            );
          if (hasFencedCallShape) {
            // Before treating as a generic malformed fence, check if this is
            // actually a truncated write call that should be salvaged.
            const salvaged = salvageTruncatedWrite(assistantText.visible);
            if (salvaged) {
              try {
                const writeResult = await fsWrite(salvaged.path, salvaged.content, {
                  confirmed: true,
                });
                if (writeResult.ok) {
                  const lineCount = salvaged.content.split("\n").length;
                  writeNotice(
                    "info",
                    `malformed tool call salvaged — wrote ${lineCount} lines to ${salvaged.path}`,
                    chalk.cyan(
                      `  ℹ malformed tool call salvaged — wrote ${lineCount} lines to ${salvaged.path}\n`,
                    ),
                  );
                  pushAssistantHistory(
                    stripThinking(assistantText.visible).visible,
                  );
                  messages.push({
                    role: "user",
                    content:
                      `The system extracted and wrote ${lineCount} lines to ${salvaged.path} from your malformed tool call. ` +
                      `The file content ends at: "${salvaged.lastLine}"\n\n` +
                      `If the file is complete, proceed with the next step. ` +
                      `If more content is needed, use one large fs.append with expectedPriorBytes from the write receipt (not tiny chunks).`,
                  });
                  continue;
                }
              } catch {
                // Salvage failed — fall through to standard malformed retry
              }
            }

            malformedFenceRetries += 1;
            if (malformedFenceRetries <= 3) {
              writeNotice(
                "warn",
                "tool block present but its JSON didn't parse — asking the model to re-emit valid JSON",
                chalk.yellow(
                  "  ⚠ tool block present but its JSON didn't parse — asking the model to re-emit valid JSON\n",
                ),
              );
              pushAssistantHistory(
                stripThinking(assistantText.visible).visible,
              );
              messages.push({
                role: "user",
                content: toolsAttached
                  ? "Your previous tool call JSON was INVALID, so NOTHING ran. " +
                  "Common causes: unescaped newlines/quotes, unbalanced braces, or content too large. " +
                  toolNudge(true) +
                  " Prefer ONE complete fs.write when it fits; if cut off, continue with large fs.append + expectedPriorBytes. " +
                  "Do NOT claim any file was written until a tool call actually succeeds."
                  : "Your previous message contained a ```tool block, but its JSON was INVALID, so NOTHING ran. " +
                  "Common causes: unescaped newlines or quotes inside a string value, an extra or missing `}` / `]`, or content too large for the output window. " +
                  'Re-emit ONE valid ```tool block of the exact form {"name":"<tool>","args":{...}} with balanced braces. ' +
                  "IMPORTANT: Prefer ONE complete fs.write when it fits. Keep reasoning SHORT. " +
                  "Only if the output window cuts you off, continue with large fs.append chunks + expectedPriorBytes. " +
                  "Do NOT claim any file was written until a tool call actually succeeds.",
              });
              continue;
            }
            // Exhausted retries — fall through to the normal path.
          }

          const cleaned = stripSentinelTokens(assistantText.visible);


          const narratedAction = looksLikeActionNarration(cleaned);
          const narratedWebAction = looksLikeWebActionNarration(cleaned);

          const reconciledPlanAtCompletion =
            await reconcileOpenTaskBeforeFinalizing();
          const livePlanAtCompletion =
            reconciledPlanAtCompletion ??
            (await loadPlan(session.sessionId).catch(() => undefined));
          const planStatusAtCompletion =
            livePlanAtCompletion?.status ?? activePlan?.status;
          const completedPlanDuringThisTurn =
            activePlan?.status !== "completed" &&
            planStatusAtCompletion === "completed";
          const planHasOpenWorkNow = planHasOpenWork(planStatusAtCompletion);

          const userExpectsWork =
            freshWebSearchRequired ||
            (planHasOpenWorkNow && session.planApproved.value) ||
            (!informationalQuery &&
              !idleOrSocialPrompt &&
              (buildLikeTurn || pentestLikeTurn));

          const wantsAction =
            !completedPlanDuringThisTurn &&
            !idleOrSocialPrompt &&
            (userExpectsWork ||
              (narratedAction && !informationalQuery) ||
              (narratedWebAction && !informationalQuery));
          const planNarrated =
            (buildLikeTurn || pentestLikeTurn) &&
            !activePlan &&
            looksLikePlanNarration(cleaned);
          // Only force "diagnosed but not fixed" when the model is still
          // narrating a fix without having applied one this turn. Post-fix
          // summaries ("I've fixed…", build passed) must never re-enter.
          const errorFixNarration =
            !sawSuccessfulMutation &&
            looksLikeErrorDiagnosisWithFixIntent(cleaned);

          const shouldRetryBeforeFinalizing =
            productiveSteps === 0 ||
            planNarrated ||
            (session.planApproved.value &&
              planHasOpenWorkNow &&
              (narratedAction || errorFixNarration)) ||
            // errorFix only when no mutation yet (gate is in errorFixNarration)
            (session.planApproved.value && errorFixNarration) ||
            (buildLikeTurn && errorFixNarration);
          if (
            wantsAction &&
            cleaned.trim().length > 0 &&
            shouldRetryBeforeFinalizing
          ) {
            let action:
              | ReturnType<typeof recoveryForErrorDiagnosis>
              | ReturnType<typeof recoveryForNarration>
              | undefined;
            if (errorFixNarration && budgetRemaining(recovery, "errorFix")) {
              action = recoveryForErrorDiagnosis(toolsAttached);
            } else if (
              budgetRemaining(recovery, "actionIntent") &&
              planHasOpenWorkNow &&
              session.planApproved.value
            ) {
              action = recoveryForNarration(toolsAttached, "plan_open");
            } else if (
              budgetRemaining(recovery, "actionIntent") &&
              pentestLikeTurn
            ) {
              action = recoveryForNarration(toolsAttached, "pentest");
            } else if (
              budgetRemaining(recovery, "actionIntent") &&
              (freshWebSearchRequired || narratedWebAction)
            ) {
              action = recoveryForNarration(toolsAttached, "web");
            } else if (
              budgetRemaining(recovery, "actionIntent") &&
              buildLikeTurn &&
              (planNarrated || productiveSteps > 0)
            ) {
              action = recoveryForNarration(toolsAttached, "build_plan_prose");
            } else if (
              budgetRemaining(recovery, "actionIntent") &&
              buildLikeTurn
            ) {
              action = recoveryForNarration(toolsAttached, "build");
            } else if (budgetRemaining(recovery, "actionIntent")) {
              action = recoveryForNarration(toolsAttached, "generic");
            }
            if (action) {
              consumeBudget(recovery, action.budgetKey);
              pushAssistantHistory(assistantText.visible);
              messages.push(recoveryUserMessage(action.message));
              continue;
            }
          }

          if (
            freshWebSearchRequired &&
            !sawFreshWebSearch &&
            budgetRemaining(recovery, "freshnessUsed")
          ) {
            const action = recoveryForFreshness(
              freshnessGuardMessage() +
              (toolsAttached
                ? " Call the web_search tool now."
                : " Reply with ONLY a fenced ```tool block for web.search now."),
            );
            consumeBudget(recovery, action.budgetKey);
            pushAssistantHistory(assistantText.visible);
            messages.push(recoveryUserMessage(action.message));
            continue;
          }

          if (
            isPlanMode &&
            !informationalQuery &&
            !idleOrSocialPrompt &&
            budgetRemaining(recovery, "forcePlan")
          ) {
            const planAtEnd = await loadPlan(session.sessionId).catch(
              () => undefined,
            );
            if (!planAtEnd && !sawPlanCreateOk) {
              const action = recoveryForMissingPlan(toolsAttached);
              consumeBudget(recovery, action.budgetKey);
              pushAssistantHistory(assistantText.visible);
              messages.push(recoveryUserMessage(action.message));
              continue;
            }
          }

          if (
            buildLike &&
            !pentestLike &&
            !pentestSession &&
            session.planApproved.value &&
            featureAppAsk &&
            !sawFeatureImplWrite &&
            (sawScaffoldOk || sawLocalAppMaterialWork) &&
            productiveSteps > 0 &&
            budgetRemaining(recovery, "featureImpl")
          ) {
            const action = recoveryForMissingFeature(getActiveProjectRoot());
            consumeBudget(recovery, action.budgetKey);
            pushAssistantHistory(assistantText.visible);
            messages.push(recoveryUserMessage(action.message));
            continue;
          }

          if (
            buildLike &&
            !pentestLike &&
            !pentestSession &&
            budgetRemaining(recovery, "runtimeVerify") &&
            (!featureAppAsk || sawFeatureImplWrite)
          ) {
            const runtimePlan = await loadPlan(session.sessionId).catch(
              () => undefined,
            );
            // Durable plan evidence or multi-signal proof this turn is enough
            const planRuntimeOk = Boolean(
              runtimePlan && planHasVerifiedRuntime(runtimePlan),
            );
            const sessionRuntimeOk =
              sawServerStart &&
              (sawServerTail || sawLocalHttpProbe || planRuntimeOk);
            if (!planRuntimeOk && !sessionRuntimeOk) {
              const codingPlanFinished = Boolean(
                runtimePlan &&
                session.planApproved.value &&
                runtimePlan.kind !== "pentest" &&
                runtimePlan.tasks.length > 0 &&
                runtimePlan.tasks.every(
                  (task) => task.state === "done" || task.state === "skipped",
                ),
              );
              const freestyleLocalAppDone =
                !session.planApproved.value &&
                sawLocalAppMaterialWork &&
                productiveSteps > 0 &&
                freestyleClaimsAppReady(cleaned) &&
                (getActiveProjectRoot() !== undefined ||
                  /\b(?:npm|pnpm|yarn|bun)\s+run\s+dev\b/i.test(cleaned) ||
                  /\bopen\s+http:\/\/localhost\b/i.test(cleaned));
              if (codingPlanFinished || freestyleLocalAppDone) {
                const action = recoveryForRuntimeVerify(getActiveProjectRoot());
                consumeBudget(recovery, action.budgetKey);
                pushAssistantHistory(assistantText.visible);
                messages.push(recoveryUserMessage(action.message));
                continue;
              }
            }
          }

          if (
            buildLike &&
            !pentestLike &&
            !pentestSession &&
            sawFailedLocalHttpProbe &&
            !sawLocalHttpProbe &&
            budgetRemaining(recovery, "failedProbe") &&
            cleaned.trim().length > 0
          ) {
            const action = recoveryForFailedProbe();
            consumeBudget(recovery, action.budgetKey);
            pushAssistantHistory(assistantText.visible);
            messages.push(recoveryUserMessage(action.message));
            continue;
          }

          if (
            (pentestLike || pentestSession) &&
            budgetRemaining(recovery, "shallowPentest") &&
            looksLikeShallowPentestReport(cleaned, {
              productiveSteps,
              sawActiveTest: sawActivePentestTest,
            })
          ) {
            const action = recoveryForShallowPentest();
            consumeBudget(recovery, action.budgetKey);
            pushAssistantHistory(assistantText.visible);
            messages.push(recoveryUserMessage(action.message));
            continue;
          }

          if (
            session.planApproved.value &&
            budgetRemaining(recovery, "prematureComplete")
          ) {
            const livePlan = await loadPlan(session.sessionId).catch(
              () => undefined,
            );
            const unfinished = livePlan?.tasks.filter(
              (t) => t.state === "pending" || t.state === "in_progress",
            );
            if (livePlan && unfinished && unfinished.length > 0) {
              const next = unfinished[0]!;
              const action = recoveryForPrematureComplete({
                unfinished,
                next,
                pentest: livePlan.kind === "pentest" || pentestSession,
                errorFix: errorFixNarration,
              });
              consumeBudget(recovery, action.budgetKey);
              pushAssistantHistory(assistantText.visible);
              messages.push(recoveryUserMessage(action.message));
              continue;
            }
          }
          let outcomeStatus: TurnOutcomeStatus = "succeeded";
          const remainingCriteria: string[] = [];
          if (session.planApproved.value) {
            const livePlan = await loadPlan(session.sessionId).catch(
              () => undefined,
            );
            const unfinished = livePlan?.tasks.filter(
              (t) => t.state === "pending" || t.state === "in_progress",
            ) ?? [];
            const failedTasks = livePlan?.tasks.filter(
              (t) => t.state === "failed",
            ) ?? [];
            remainingCriteria.push(
              ...unfinished.map((task) => `[${task.id}] ${task.title}`),
              ...failedTasks.map((task) => `[${task.id}] retry failed task: ${task.title}`),
            );
            if (failedTasks.length > 0) outcomeStatus = "failed";
            else if (unfinished.length > 0) outcomeStatus = "partial";
          }
          recordAnswerEvidence(outcomeState, cleaned);
          outcomeState.outcome.status = deriveOutcomeStatus(
            outcomeState.outcome,
            outcomeState.evidence,
          );
          await saveOutcomeState(outcomeState);
          const unsupportedCriteria = outcomeState.outcome.criteria.filter(
            (criterion) =>
              criterion.required &&
              !validateCriterionEvidence(criterion, outcomeState.evidence).ok,
          );
          if (unsupportedCriteria.length > 0 && outcomeStatus === "succeeded") {
            outcomeStatus = "partial";
          }
          remainingCriteria.push(
            ...unsupportedCriteria
              .map((criterion) => criterion.statement)
              .filter((statement) => !remainingCriteria.includes(statement)),
          );
          moveTurn("verifying", "evaluating current criterion-linked evidence");
          moveTurn(outcomeStatus, `turn completed with ${outcomeStatus} evidence status`);
          await auditLog("agent.final", {
            provider,
            model,
            steps: step + 1,
            outcomeStatus,
            remainingCriteria,
          });
          lastAnswer = cleaned;
          return finishTurn(
            lastAnswer,
            step + 1,
            outcomeStatus,
            remainingCriteria,
            outcomeStatus === "failed"
              ? "One or more required plan tasks failed."
              : outcomeStatus === "partial"
                ? "Required outcome criteria remain unsupported by current evidence."
                : undefined,
          );
        }

        // A valid primary tool call exists for this fresh model turn. Show any
        // prose / thinking that preceded it, record the assistant message ONCE.
        const beforeTool = recoveredFromBareJson
          ? ""
          : nativeToolCalls.length
            ? assistantText.visible.trim()
            : textBeforeToolCall(assistantText.visible);
        if (beforeTool) {
          writeAssistantMessage(beforeTool);
        }

        type BoundCall = {
          index: number;
          id: string;
          call: ToolCall;
          native: NativeToolCall;
        };
        let bound: BoundCall[] = [];
        if (nativeToolCalls.length) {
          bound = nativeToolCalls.map((tc, index) => {
            const call = tc.args?._parseError
              ? {
                name: tc.name || "unknown",
                args: {
                  __nativeParseError: true,
                  _raw: tc.args._raw,
                },
              }
              : normalizeToolCall({ name: tc.name, args: tc.args });
            return { index, id: tc.id, call, native: tc };
          });
        } else {
          let parsed = parseAllToolCalls(
            assistantText.visible || assistantText.thinkContent,
          );
          if (parsed.length === 0 && call) parsed = [call];
          bound = parsed.map((c, index) => {
            const id = syntheticToolCallId(index);
            return {
              index,
              id,
              call: c,
              native: { id, name: c.name, args: c.args },
            };
          });
        }

        /** Subset that will actually run this turn (defer/omit rest). */
        let toRun = bound;
        let activeDeferredToolCalls = deferredToolCalls;
        let deferReason =
          "Cancelled — not executed this turn (deferred or omitted).";


        const planCallIndex = bound.findIndex(
          (b) => b.call.name === "plan.create",
        );
        if (planCallIndex > 0) {
          const deferredCount = bound.length - planCallIndex;
          toRun = bound.slice(0, planCallIndex);
          activeDeferredToolCalls = deferredToolCalls.slice(0, planCallIndex);
          deferReason =
            "Deferred — plan.create must wait until reconnaissance results exist.";
          writeNotice(
            "info",
            "deferring plan.create until reconnaissance results are available",
            chalk.dim(
              `  ℹ running ${toRun.length} gathering call(s); ${deferredCount} plan/follow-on call(s) deferred for evidence-based planning\n`,
            ),
          );
          messages.push({
            role: "system",
            content:
              `The prior response included plan.create before its reconnaissance results existed. ` +
              `Only the ${toRun.length} gathering call(s) before it were run; ${deferredCount} plan/follow-on call(s) were not run. ` +
              "Now analyse the tool results. If a plan is appropriate, emit exactly one standalone plan.create tool call based only on those results. Do not include any other tool calls in that response.",
          });
        } else if (planCallIndex === 0 && bound.length > 1) {
          const deferredCount = bound.length - 1;
          toRun = bound.slice(0, 1);
          activeDeferredToolCalls = deferredToolCalls.slice(0, 1);
          deferReason =
            "Deferred — waiting for plan approval before follow-on tools.";
          writeNotice(
            "info",
            "creating the plan now; deferring follow-on calls until it is approved",
            chalk.dim(
              `  ℹ running plan.create from prior reconnaissance; ${deferredCount} follow-on call(s) deferred until after approval\n`,
            ),
          );
          messages.push({
            role: "system",
            content:
              `You emitted plan.create alongside ${deferredCount} follow-on call(s). Only plan.create was run; ` +
              `the follow-on call(s) were not. Wait for the plan to be reviewed, then proceed task by task.`,
          });
        }

        // Preserve model/document order. In particular, never move a later
        // in_progress transition ahead of the preceding work or done receipt;
        // doing so inverts dependency order and desynchronizes the task pane.

        // Re-index toRun positions for UI callIds[] (0..n-1 this turn).
        toRun = toRun.map((b, index) => ({ ...b, index }));
        const allCalls = toRun.map((b) => b.call);
        /** Stable call→Bound map (object identity; no indexOf for result ids). */
        const callToBound = new Map<ToolCall, BoundCall>(
          toRun.map((b) => [b.call, b]),
        );
        const historyNativeCalls = bound.map((b) => b.native);
        const runIds = new Set(toRun.map((b) => b.id));

        // Notice BEFORE tool cards so the transcript reads:
        // thinking → response → "N tool calls…" → tool cards (not tools then info).
        if (allCalls.length > 1) {
          writeNotice(
            "info",
            `${allCalls.length} tool calls in this message — read-only in parallel, writes in order (failures do not cancel siblings)`,
            chalk.dim(
              `  ℹ ${allCalls.length} tool calls — parallel reads, ordered writes; failures continue\n`,
            ),
          );
        }


        for (const deferred of activeDeferredToolCalls.slice(0, allCalls.length)) {
          if (!deferred.call.name || deferred.call.name === "…") continue;
          writeToolCall(deferred.eventId, deferred.call, deferred.rendered);
        }

        if (historyNativeCalls.length) {
          appendAssistantWithTools(
            messages,
            beforeTool ?? "",
            historyNativeCalls,
          );
        } else {
          const standardizedContent =
            (beforeTool ? beforeTool.trim() + "\n\n" : "") +
            allCalls
              .map((c) => `\`\`\`tool\n${JSON.stringify(c)}\n\`\`\``)
              .join("\n\n");
          pushAssistantHistory(standardizedContent);
        }


        const scopeForBatch = await loadScope().catch(() => undefined);

        const isParallelSafe = (c: ToolCall): boolean => {
          if (
            c.name === "pentest.recon" ||
            c.name === "net.context" ||
            c.name === "tool.batch" ||
            c.name === "tool.check" ||
            c.name === "shell.jobs" ||
            c.name === "shell.tail"
          ) {
            return true;
          }
          if (!BATCH_SAFE_TOOLS.has(c.name)) return false;
          try {
            return (
              classifyToolCall(c, { scope: scopeForBatch }).level === "safe"
            );
          } catch {
            return false;
          }
        };
        // Recon waves often emit 6–10 lookups; 4 forced a second sequential wave.
        const PARALLEL_LIMIT = 8;

        let aborted = false;
        let awaitingPlanApproval = false;
        /** Native tool_call ids that already have a role:tool history entry. */
        const recordedNativeIds = new Set<string>();
        /** Plan-mode soft reminders already attached this turn (by step). */
        const planRemindedAt = new Set<number>();
        /** True after a successful plan.create this turn (activePlan is turn-start snapshot). */
        let planCreatedThisTurn = Boolean(
          activePlan && activePlan.tasks.length > 0,
        );

        /**
         * Record a tool result into history. Failures / user declines are
         * always returned to the model — we never cancel later siblings or
         * force-end the turn as "blocked" because one tool failed. Only an
         * explicit user abort stops remaining calls.
         */
        const recordResult = (
          boundCall: BoundCall,
          res: {
            call: ToolCall;
            result: ToolResult;
            contextOutput: string;
            ok: boolean;
            lastAnswer?: string | undefined;
            blockOrCancel?: boolean | undefined;
          },
        ): void => {
          recordedNativeIds.add(boundCall.id);
          if (res.ok && res.call.name === "plan.create") {
            planCreatedThisTurn = true;
          }
          productiveSteps += 1;
          // Soft plan-mode note on tool payloads only (never a user message).
          // Stop once a plan with tasks exists so we don't nag after plan.create.
          let toolContent = `Tool ${res.call.name} result (exit=${res.result.exitCode ?? 0}, ok=${res.result.ok}):\n${res.contextOutput}`;
          const reminded = maybeAppendPlanModeReminder(toolContent, {
            isPlanMode,
            planApproved: session.planApproved.value,
            hasDraftPlan: planCreatedThisTurn,
            productiveStep: productiveSteps,
            alreadyRemindedAt: planRemindedAt,
            step: productiveSteps,
            kindHint:
              activePlan?.kind === "pentest" || pentestLikeTurn
                ? "pentest"
                : activePlan?.kind === "coding"
                  ? "coding"
                  : "general",
          });
          toolContent = reminded.content;
          if (reminded.reminded) planRemindedAt.add(productiveSteps);
          if (historyNativeCalls.length) {
            appendToolResult(
              messages,
              boundCall.id,
              toolContent,
              res.call.name,
              res.result.ok,
            );
          } else {
            messages.push({
              role: "tool",
              content: toolContent,
            });
          }
          // Reset retry counters — they track consecutive failures, not cumulative.
          truncatedToolRetries = 0;
          malformedFenceRetries = 0;
          bareToolJsonRetries = 0;

          if (
            res.ok &&
            (res.call.name === "fs.edit" ||
              res.call.name === "fs.write" ||
              res.call.name === "fs.writeMany" ||
              res.call.name === "fs.replaceLines" ||
              res.call.name === "fs.append")
          ) {
            // Mutation landed — post-fix summaries must not re-force tools.
            sawSuccessfulMutation = true;
          }
          // A fresh failed localhost probe re-opens the diagnosis→fix gate.
          if (
            (res.call.name === "http.fetch" ||
              res.call.name === "web.fetch" ||
              res.call.name === "shell.exec") &&
            localHttpProbeIsFailure(
              res.result.output ?? res.contextOutput ?? "",
            )
          ) {
            sawSuccessfulMutation = false;
          }
          if (res.ok && isEvidenceWorkTool(res.call.name)) {
            recovery.prematureComplete = 0;
            recovery.actionIntent = 0;
            recovery.errorFix = 0;
          }
          if (res.ok && res.call.name === "shell.start") sawServerStart = true;
          if (res.ok && res.call.name === "shell.tail") {
            sawServerTail = true;
            const tailOut = res.result.output ?? res.contextOutput ?? "";
            if (isServerReadyOutput(tailOut)) {
              sawServerStart = true;
              sawServerTail = true;
            }
          }
          if (
            res.ok &&
            res.call.name === "shell.exec" &&
            isPortListeningOutput(
              String(res.call.args.command ?? ""),
              res.result.output ?? res.contextOutput ?? "",
            )
          ) {
            sawServerStart = true;
          }
          if (
            res.ok &&
            (pentestLike || pentestSession) &&
            (res.call.name === "http.fetch" ||
              res.call.name === "shell.exec" ||
              res.call.name === "net.scan" ||
              res.call.name === "pentest.recon")
          ) {
            const blob = `${res.call.name} ${JSON.stringify(res.call.args)}`;
            if (
              /\b(sqlmap|hydra|nikto|nuclei|ffuf|gobuster|exploit|payload|idor|xss|union\s+select)\b/i.test(
                blob,
              ) ||
              (res.call.name === "http.fetch" &&
                typeof res.call.args.method === "string" &&
                !/^get$/i.test(res.call.args.method))
            ) {
              sawActivePentestTest = true;
            }
          }
          if (
            res.ok &&
            ((res.call.name === "http.fetch" &&
              /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(
                String(res.call.args.url ?? ""),
              )) ||
              (res.call.name === "shell.exec" &&
                /\bcurl\b[\s\S]*\b(?:localhost|127\.0\.0\.1|\[::1\])\b/i.test(
                  String(res.call.args.command ?? ""),
                )))
          ) {
            const out = res.result.output ?? res.contextOutput ?? "";
            if (localHttpProbeIsFailure(out)) {
              sawFailedLocalHttpProbe = true;
              sawLocalHttpProbe = false;
            } else if (localHttpProbeIsSuccess(out)) {
              sawLocalHttpProbe = true;
              sawFailedLocalHttpProbe = false;
              recovery.failedProbe = 0;
            } else if (
              res.call.name === "shell.exec" &&
              !localHttpProbeIsFailure(out)
            ) {
              // curl without status line — soft success
              sawLocalHttpProbe = true;
              sawFailedLocalHttpProbe = false;
            }
          }
          // Track freestyle local-app materialization (scaffold / install / feature write)
          if (res.ok) {
            const cmd =
              typeof res.call.args.command === "string"
                ? res.call.args.command
                : "";
            const pathArg =
              typeof res.call.args.path === "string" ? res.call.args.path : "";
            if (isScaffoldCreateCommand(cmd)) {
              sawScaffoldOk = true;
              sawLocalAppMaterialWork = true;
            }
            if (isFeatureImplementationCall(res.call)) {
              sawFeatureImplWrite = true;
              sawLocalAppMaterialWork = true;
            }
            if (
              /\b(?:npm|pnpm|yarn|bun)\s+i(?:nstall)?\b/i.test(cmd) ||
              res.call.name === "fs.write" ||
              res.call.name === "fs.writeMany" ||
              res.call.name === "fs.edit" ||
              (pathArg &&
                getActiveProjectRoot() &&
                (pathArg.includes(getActiveProjectRoot()!) ||
                  !pathArg.startsWith("/")))
            ) {
              sawLocalAppMaterialWork = true;
            }
          }
          if (res.call.name === "plan.create" && res.ok) {
            sawPlanCreateOk = true;
            if (isPlanMode) {
              awaitingPlanApproval = true;
            } else {
              session.planApproved.value = true;
            }
          }
          // User Esc/Ctrl+C only — never cancel siblings because a delete failed
          // or a confirm was declined; the model must see every tool result.
          if (res.lastAnswer === "Aborted.") aborted = true;
        };

        const groups = groupToolCallsForExecution(
          allCalls,
          isParallelSafe,
          PARALLEL_LIMIT,
        );
        for (const group of groups) {
          if (aborted || awaitingPlanApproval || governorPauseReason) break;
          if (group.length === 1) {
            const call = group[0]!;
            const bc = callToBound.get(call);
            if (!bc) continue;
            if (!callIds[bc.index]) {
              callIds[bc.index] = `tool-${++nextToolEventId}`;
            }
            const id = callIds[bc.index]!;
            const res = await executeSingleTool(
              call,
              id,
              options.signal || new AbortController().signal,
            );
            recordResult(bc, res);
          } else {
            // Concurrent group — BoundCall via Map; record in document order.
            const groupBound: BoundCall[] = [];
            const uiIds: string[] = [];
            for (const c of group) {
              const bc = callToBound.get(c);
              if (!bc) continue;
              if (!callIds[bc.index]) {
                callIds[bc.index] = `tool-${++nextToolEventId}`;
              }
              groupBound.push(bc);
              uiIds.push(callIds[bc.index]!);
            }
            const results = await Promise.all(
              groupBound.map((bc, k) =>
                executeSingleTool(
                  bc.call,
                  uiIds[k]!,
                  options.signal || new AbortController().signal,
                ),
              ),
            );
            for (let k = 0; k < results.length; k += 1) {
              recordResult(groupBound[k]!, results[k]!);
            }
          }
        }

        // Cards still "running" get a terminal UI result; history always pairs.
        // Only abort / plan-gate / governor leave calls un-run now.
        for (let i = 0; i < toRun.length; i += 1) {
          const bc = toRun[i]!;
          if (recordedNativeIds.has(bc.id)) continue;
          if (!callIds[i]) {
            callIds[i] = `tool-${++nextToolEventId}`;
          }
          const uiId = callIds[i]!;
          const reason = aborted
            ? "Cancelled — turn aborted before this call ran."
            : awaitingPlanApproval
              ? "Deferred — waiting for plan approval."
              : governorPauseReason
                ? `Deferred — progress governor paused execution: ${governorPauseReason}`
                : "Cancelled — not executed.";
          const result: ToolResult = {
            ok: false,
            output: reason,
            exitCode: 130,
          };
          if (alreadyPrintedIds.has(uiId)) {
            emitToolResult(uiId, result, reason);
          }
          if (historyNativeCalls.length) {
            appendToolResult(
              messages,
              bc.id,
              `Tool ${bc.call.name} result (exit=130, ok=false):\n${reason}`,
              bc.call.name,
              false,
            );
            recordedNativeIds.add(bc.id);
          } else {
            messages.push({
              role: "tool",
              content: `Tool ${bc.call.name} result (exit=130, ok=false):\n${reason}`,
            });
          }
        }

        // Synthetic results for deferred/omitted ids still listed on assistant.
        if (historyNativeCalls.length) {
          for (const b of bound) {
            if (runIds.has(b.id) || recordedNativeIds.has(b.id)) continue;
            appendToolResult(
              messages,
              b.id,
              `Tool ${b.call.name} result (exit=130, ok=false):\n${deferReason}`,
              b.call.name,
              false,
            );
            recordedNativeIds.add(b.id);
          }
          fillMissingToolResults(
            messages,
            historyNativeCalls,
            "Cancelled — not executed this turn.",
          );
        }

        if (deferredPostToolMessages.length > 0) {
          messages.push(...deferredPostToolMessages.splice(0));
        }

        if (awaitingPlanApproval) {
          pendingCalls = [];
          outcomeState.outcome.status = "partial";
          await saveOutcomeState(outcomeState);
          moveTurn("partial", "draft plan awaits approval");
          return finishTurn(
            "",
            productiveSteps,
            "partial",
            ["Approve or revise the draft plan before implementation."],
          );
        }

        if (aborted) {
          lastAnswer = "Aborted.";
          outcomeState.outcome.status = "aborted";
          await saveOutcomeState(outcomeState);
          moveTurn("aborted", "turn aborted");
          writeAbort();
          return finishTurn(lastAnswer, productiveSteps, "aborted");
        }
        // Confirm declines / tool failures already have role:tool results —
        // continue the agent loop so the model can adapt (do not force "blocked").

        await maybeAutoCompact("post-tool-token-budget");

        if (options.onMessages) {
          try {
            options.onMessages(buildTurnHistory(liveMessages, lastAnswer));
          } catch {
            // ignore
          }
        }
      }
    }


    const richSummary = await buildRichStopSummary(
      messages,
      session,
      productiveSteps,
    );
    lastAnswer = richSummary;
    outcomeState.outcome.status = "paused_budget";
    await saveOutcomeState(outcomeState);
    moveTurn("paused_budget", "emergency iteration ceiling reached");
    return finishTurn(
      lastAnswer,
      productiveSteps,
      "paused_budget",
      ["Continue unfinished work in a subsequent turn."],
      "The emergency iteration ceiling was reached.",
    );
  } catch (error) {
    const isAbort = isAbortError(error, options.signal);
    const msg = isAbort ? "Aborted." : `Error: ${error instanceof Error ? error.message : String(error)}`;
    if (isAbort) {
      writeAbort();
      return finishTurn(msg, 0, "aborted", [], "The turn was aborted.");
    }
    if (options.onMessages) {
      try {
        options.onMessages(buildTurnHistory(liveMessages, msg));
      } catch {
        // ignore
      }
    }
    emit({
      type: "turn-error",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/** Compatibility boundary for callers that still consume rendered text. */
export async function runAgentLoop(
  prompt: string,
  options: AgentRunOptions = {},
): Promise<string> {
  return renderTurnOutcome(await runAgentTurn(prompt, options));
}
