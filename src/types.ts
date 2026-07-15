export const providerIds = [
  "groq",
  "gemini",
  "openrouter",
  "openai",
  "anthropic",
  "nvidia",
  "agentrouter",
  "kimchi",
  "aws-mantle",
  "ollama",
  "bynara",
  "qwen-cloud",
] as const;

export type ProviderId = (typeof providerIds)[number];
export type Mode = "ask" | "agent";
export type RiskLevel = "safe" | "confirm" | "block";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ReasoningPreference {
  enabled: boolean;
  effort: ReasoningEffort;
}

export interface ChatImage {
  /** MIME type, e.g. "image/png", "image/jpeg". */
  mediaType: string;
  /** Base64-encoded image bytes (no data: prefix). */
  dataBase64: string;
  /** Original path, for display/debugging. */
  path?: string | undefined;
}

/** Structured tool call as returned by provider-native function calling. */
export interface NativeToolCall {
  id: string;
  /** Canonical dotted name (e.g. fs.write). */
  name: string;
  args: Record<string, unknown>;
  /** Original JSON arguments string when the provider sent one. */
  rawArguments?: string | undefined;
}

/** Partial native tool call while the provider stream is still open (P2-3). */
export interface ToolCallStreamDelta {
  index: number;
  id?: string | undefined;
  /** Canonical name when known (may arrive before args complete). */
  name?: string | undefined;
  /** Accumulated argument JSON byte length so far. */
  argumentsBytes?: number | undefined;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /**
   * Optional image attachments for this message. Only populated for user
   * turns when the active model supports vision; providers that understand
   * images serialize these into their multimodal message format, and
   * providers/models without vision ignore them (the text content still
   * carries a note so the agent can fall back to OCR tools).
   */
  images?: ChatImage[] | undefined;
  /** For role "tool": id of the assistant tool_call this result answers. */
  toolCallId?: string | undefined;
  /** For assistant turns that requested tools. */
  toolCalls?: NativeToolCall[] | undefined;
  /** Optional tool name (some providers require it on tool results). */
  name?: string | undefined;
  /** For role "tool": whether the tool succeeded (Anthropic is_error). */
  ok?: boolean | undefined;
}

/** Tool choice for native function calling (canonical names). */
export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; name: string };

/** JSON Schema object used for tool parameters. */
export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[] | undefined;
  additionalProperties?: boolean | undefined;
}

/** Canonical tool definition exposed to providers. */
export interface ToolDefinition {
  name: string;
  wireName: string;
  description: string;
  parameters: JsonSchemaObject;
  mutates?: boolean | undefined;
  readOnly?: boolean | undefined;
  askMode?: boolean | undefined;
}

export interface CompletionRequest {
  provider?: ProviderId | undefined;
  model?: string | undefined;
  /**
   * Permit the configured provider chain to use each fallback provider's
   * default model when the explicitly selected model cannot produce a usable
   * completion. Agent turns opt in so a reasoning-only stream never ends the
   * user's turn without an answer.
   */
  allowModelFallback?: boolean | undefined;
  messages: ChatMessage[];
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
  thinking?: ReasoningPreference | undefined;
  /** Native tool definitions (canonical). Adapters convert to wire format. */
  tools?: ToolDefinition[] | undefined;
  toolChoice?: ToolChoice | undefined;
  parallelToolCalls?: boolean | undefined;
  /** Fired as native tool_call name/args stream in (early UI cards). */
  onToolCallDelta?: ((delta: ToolCallStreamDelta) => void) | undefined;
}

export interface CompletionResult {
  text: string;
  provider: ProviderId;
  model: string;
  toolCalls?: NativeToolCall[] | undefined;
  finishReason?: "stop" | "tool_calls" | "length" | "error" | string | undefined;
  /** Optional raw assistant payload for perfect replay (e.g. Anthropic blocks). */
  rawAssistantMessage?: unknown | undefined;
}

export interface ProviderStatus {
  provider: ProviderId;
  label: string;
  active: boolean;
  configured: boolean;
  source: "env" | "keychain" | "fallback" | "local" | "missing";
  maskedKey?: string | undefined;
  model: string;
  note?: string | undefined;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolStats {
  bytesRead: number;
  bytesDropped: number;
  linesRead: number;
  elapsedMs: number;
  captureLimitHit?: boolean | undefined;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  exitCode?: number | undefined;
  outputPath?: string | undefined;
  truncated?: boolean | undefined;
  stats?: ToolStats | undefined;
}
