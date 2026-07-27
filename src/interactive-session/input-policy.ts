/**
 * Contextual policy for later interactive input.
 *
 * Generic tool classification cannot decide this: the risk of a keystroke depends
 * on the owning session, the exact bytes, and whether they are being submitted.
 * Risk is monotonic with the shell boundary — a command sent into a session is
 * never rated lower than the same command run through `shell.exec`.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { classifyShellCommand } from "../safety/classifier.js";
import type { RiskDecision } from "../safety/classifier.js";
import type { EngagementScope } from "../store/scope.js";
import { maskSecret } from "../llm/provider.js";
import type { SessionInput, SessionTransportKind } from "./types.js";

export interface InputPolicyContext {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly transport: SessionTransportKind;
  readonly input: SessionInput;
  readonly scope?: EngagementScope | undefined;
}

/** Controls that only move a cursor or redraw a prompt carry no risk. */
const SAFE_CONTROLS = new Set([
  "escape",
  "tab",
  "backspace",
  "up",
  "down",
  "left",
  "right",
  "interrupt",
  "suspend",
  "eof",
]);

/**
 * Short, unambiguous REPL answers. Everything outside this set is treated as
 * unknown submitted text and therefore requires confirmation.
 */
const RECOGNIZED_ANSWER_RE =
  /^(y|n|yes|no|q|quit|exit|:q|:q!|help|\?|\d+(\.\d+)?|true|false|none|null)$/i;

/** REPL constructs that destroy data or escape the interpreter irreversibly. */
const REPL_DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\bshutil\s*\.\s*rmtree\b/i,
  /\bos\s*\.\s*(remove|unlink|rmdir)\b/i,
  /\bfs\s*\.\s*(unlink|rm|rmdir)Sync?\b/i,
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bDELETE\s+FROM\b(?![\s\S]*\bWHERE\b)/i,
  /\bRemove-Item\b[\s\S]*-Recurse/i,
];

/** REPL constructs that mutate state or reach outside the interpreter. */
const REPL_MUTATOR_PATTERNS: readonly RegExp[] = [
  /\bos\s*\.\s*system\b/i,
  /\bsubprocess\s*\.\s*(run|call|Popen|check_output)\b/i,
  /\bchild_process\b/i,
  /\brequire\s*\(\s*['"]fs['"]\s*\)/i,
  /\b(eval|exec)\s*\(/i,
  /\bopen\s*\([^)]*['"][wa]\+?['"]/i,
  /\bInvoke-(Expression|WebRequest|RestMethod)\b/i,
  /\b(UPDATE|INSERT\s+INTO|ALTER\s+TABLE|GRANT|REVOKE)\b/i,
  /\bpip\s+install\b|\bnpm\s+(install|i)\b/i,
];

const EXFILTRATION_PATTERNS: readonly RegExp[] = [
  /\b(curl|wget)\b[\s\S]*\|\s*(sh|bash|zsh|python)/i,
  /\bbase64\b[\s\S]*\|\s*(curl|wget|nc)\b/i,
];

export function classifyInteractiveInput(
  context: InputPolicyContext,
): RiskDecision {
  const { input } = context;
  if (input.kind === "eof") {
    return { level: "safe", reason: "Closing session input has no command effect" };
  }
  if (input.kind === "control") {
    return SAFE_CONTROLS.has(input.control)
      ? { level: "safe", reason: "Terminal navigation control" }
      : { level: "confirm", reason: "Unrecognized terminal control" };
  }

  const text = input.text;
  if (text.trim().length === 0) {
    return { level: "safe", reason: "Whitespace-only input has no command effect" };
  }
  if (EXFILTRATION_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      level: "block",
      reason: "Input pipes remote content into an interpreter or exports local data",
    };
  }
  if (REPL_DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(text))) {
    return { level: "block", reason: "Input matches a destructive REPL pattern" };
  }

  // Never rate an interactive command below the shell boundary for the same text.
  const shellDecision = classifyShellCommand(
    text,
    context.scope ? { scope: context.scope } : {},
  );
  if (shellDecision.level !== "safe") return shellDecision;

  if (REPL_MUTATOR_PATTERNS.some((pattern) => pattern.test(text))) {
    return { level: "confirm", reason: "Input mutates state through an interpreter" };
  }
  if (RECOGNIZED_ANSWER_RE.test(text.trim())) {
    return { level: "safe", reason: "Recognized prompt answer" };
  }
  return {
    level: "confirm",
    reason: "Submitted interactive text is not recognized as read-only",
  };
}

/** Redacted, bounded description shown in a confirmation preview. */
export function describeInput(input: SessionInput): string {
  if (input.kind === "eof") return "close session input (EOF)";
  if (input.kind === "control") return `control: ${input.control}`;
  const trimmed = input.text.trim();
  const preview = trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
  const body = /^[\x20-\x7e]*$/.test(preview) ? preview : maskSecret(preview);
  return `${input.submit === "enter" ? "submit" : "type"}: ${body}`;
}

// --- Approval tokens ----------------------------------------------------

const TOKEN_TTL_MS = 60_000;
/** Per-process key: digests are never persisted, logged, or returned. */
const digestKey = randomBytes(32);

export interface ApprovalBinding {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly input: SessionInput;
  readonly decision: RiskDecision["level"];
}

function bindingDigest(binding: ApprovalBinding): string {
  const { input } = binding;
  const parts = [
    binding.ownerId,
    binding.sessionId,
    input.kind,
    input.kind === "text" ? input.text : input.kind === "control" ? input.control : "",
    input.kind === "text" ? input.submit : "",
    binding.decision,
  ];
  return createHmac("sha256", digestKey).update(parts.join("\u0000")).digest("hex");
}

export class ApprovalTokenVault {
  private readonly tokens = new Map<string, { digest: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  mint(binding: ApprovalBinding): string {
    this.sweep();
    const token = randomBytes(24).toString("base64url");
    this.tokens.set(token, {
      digest: bindingDigest(binding),
      expiresAt: this.now() + TOKEN_TTL_MS,
    });
    return token;
  }

  /**
   * Validate and invalidate atomically. Any change to owner, session, bytes,
   * kind, submit behavior, or decision fails, and a token is single-use so a
   * concurrent replay cannot deliver the same input twice.
   */
  consume(token: string | undefined, binding: ApprovalBinding): boolean {
    if (!token) return false;
    const entry = this.tokens.get(token);
    if (!entry) return false;
    this.tokens.delete(token);
    if (entry.expiresAt <= this.now()) return false;
    const expected = Buffer.from(bindingDigest(binding), "utf8");
    const actual = Buffer.from(entry.digest, "utf8");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /** Expiry sweep; single-use semantics make stale tokens unusable anyway. */
  private sweep(): void {
    const now = this.now();
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt <= now) this.tokens.delete(token);
    }
  }
}
