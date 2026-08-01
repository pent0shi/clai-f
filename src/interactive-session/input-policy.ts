import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { maskSecret } from "../llm/provider.js";
import {
  classifyInteractiveInput as classifyInput,
  type InteractiveInputPolicyContext,
  type RiskDecision,
} from "../safety/classifier.js";
import type { EngagementScope } from "../store/scope.js";
import type { SessionInput, SessionTransportKind } from "./types.js";

export interface InputPolicyContext {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly transport: SessionTransportKind;
  readonly input: SessionInput;
  readonly scope?: EngagementScope | undefined;
}

export function classifyInteractiveInput(
  context: InputPolicyContext,
): RiskDecision {
  return classifyInput(context as InteractiveInputPolicyContext);
}

export function describeInput(input: SessionInput): string {
  if (input.kind === "eof") return "close session input (EOF)";
  if (input.kind === "control") return `control: ${input.control}`;
  if (input.kind === "secret") {
    return `${input.submit === "enter" ? "submit" : "type"}: [secret]`;
  }
  const trimmed = input.text.trim();
  const preview = trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
  const body = /^[\x20-\x7e]*$/.test(preview) ? preview : maskSecret(preview);
  return `${input.submit === "enter" ? "submit" : "type"}: ${body}`;
}

const TOKEN_TTL_MS = 60_000;
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
    input.kind === "text" ? input.text : input.kind === "secret" ? input.value : input.kind === "control" ? input.control : "",
    input.kind === "text" || input.kind === "secret" ? input.submit : "",
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

  private sweep(): void {
    const now = this.now();
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt <= now) this.tokens.delete(token);
    }
  }
}
