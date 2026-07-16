import type { AgentEvent } from "../../agent/events.js";
import {
  asPlanId,
  asToolCallId,
  type AnyAppEvent,
  type AppEventPayloads,
  type AppEventType,
  type TurnId,
} from "../events/app-event.js";
import type { OutputSpool } from "../events/event-buffer.js";
import type { EventSequencer } from "../events/sequencer.js";

const STEP_STATUS = /^step (\d+)$/;
const QUIET_META_TOOLS = new Set(["plan.create", "task.update"]);

type BufferedMetaTool = {
  name: string;
  argsDisplay: string;
  outputRef?: ReturnType<OutputSpool["append"]> | undefined;
};

export class AgentEventAdapter {
  private turnId: TurnId | undefined;
  private readonly bufferedMetaTools = new Map<string, BufferedMetaTool>();

  constructor(
    private readonly sequencer: EventSequencer,
    private readonly spool: OutputSpool,
    private readonly emit: (event: AnyAppEvent) => void,
  ) {}

  /** Bind subsequent events to a turn; pass undefined for session-level events. */
  setTurn(turnId: TurnId | undefined): void {
    if (this.turnId !== turnId) this.bufferedMetaTools.clear();
    this.turnId = turnId;
  }

  ingest(event: AgentEvent): void {
    switch (event.type) {
      case "turn-start":
        this.push("turn-started", {
          prompt: event.prompt,
          ...(event.displayPrompt !== undefined
            ? { displayPrompt: event.displayPrompt }
            : {}),
        });
        return;
      case "status": {
        const match = STEP_STATUS.exec(event.text);
        this.push("status", {
          text: event.text,
          step: match ? Number(match[1]) : undefined,
        });
        return;
      }
      case "thinking-delta":
        this.push("thinking-delta", { text: event.text });
        return;
      case "thinking-block":
        this.push("thinking-block", {
          messageId: this.sequencer.ids.message(),
          content: event.content,
        });
        return;
      case "assistant-delta":
        this.push("assistant-delta", { text: event.text });
        return;
      case "assistant-message":
        this.push("assistant-message", {
          messageId: this.sequencer.ids.message(),
          text: event.text,
        });
        return;
      case "notice":
        this.push("notice", { level: event.level, text: event.text });
        return;
      case "tool-call": {
        const toolCallId = this.toolCallId(event.id);
        if (QUIET_META_TOOLS.has(event.name)) {
          this.bufferedMetaTools.set(toolCallId, {
            name: event.name,
            argsDisplay: event.argsDisplay,
          });
          return;
        }
        this.push("tool-call", {
          toolCallId,
          name: event.name,
          argsDisplay: event.argsDisplay,
        });
        return;
      }
      case "tool-start": {
        const toolCallId = this.toolCallId(event.id);
        if (this.bufferedMetaTools.has(toolCallId)) return;
        this.push("tool-started", {
          toolCallId,
        });
        return;
      }
      case "tool-output": {
        const id = this.toolCallId(event.id);
        const ref = event.replace
          ? this.spool.replace(id, event.chunk)
          : this.spool.append(id, event.chunk);
        const buffered = this.bufferedMetaTools.get(id);
        if (buffered) {
          buffered.outputRef = ref;
          return;
        }
        this.push("tool-output", { ref });
        return;
      }
      case "tool-result": {
        const toolCallId = this.toolCallId(event.id);
        const buffered = this.bufferedMetaTools.get(toolCallId);
        if (buffered) {
          if (event.ok) {
            this.bufferedMetaTools.delete(toolCallId);
            return;
          }
          this.flushBufferedMetaTool(toolCallId, buffered);
        }
        this.push("tool-result", {
          toolCallId,
          ok: event.ok,
          exitCode: event.exitCode,
          summary: event.summary,
          artifactPath: event.artifactPath,
          ...(event.fileChanges ? { fileChanges: event.fileChanges } : {}),
        });
        return;
      }
      case "tool-blocked": {
        const toolCallId = this.toolCallId(event.id);
        const buffered = this.bufferedMetaTools.get(toolCallId);
        if (buffered) this.flushBufferedMetaTool(toolCallId, buffered);
        this.push("tool-blocked", {
          toolCallId,
          name: event.name,
          reason: event.reason,
        });
        return;
      }
      case "plan-update":
        this.push("plan-updated", {
          planId: asPlanId(event.plan.sessionId),
          plan: event.plan,
        });
        return;
      case "confirm-request":
        this.push("confirm-requested", {
          requestId: event.id,
          kind: event.kind,
          prompt: event.prompt,
        });
        return;
      case "compacted":
        this.push("compacted", {
          summary: event.summary,
          beforeTokens: event.beforeTokens,
          afterTokens: event.afterTokens,
        });
        return;
      case "turn-end":
        this.push("turn-ended", {
          finalAnswer: event.finalAnswer,
          steps: event.steps,
        });
        return;
      case "turn-aborted":
        this.push("turn-aborted", {});
        return;
      case "turn-error":
        this.push("turn-error", { message: event.message });
        return;
      default: {
        const unreachable: never = event;
        throw new Error(
          `unhandled AgentEvent: ${JSON.stringify(unreachable)}`,
        );
      }
    }
  }

  private flushBufferedMetaTool(
    toolCallId: ReturnType<typeof asToolCallId>,
    buffered: BufferedMetaTool,
  ): void {
    this.push("tool-call", {
      toolCallId,
      name: buffered.name,
      argsDisplay: buffered.argsDisplay,
    });
    if (buffered.outputRef) {
      this.push("tool-output", { ref: buffered.outputRef });
    }
    this.bufferedMetaTools.delete(toolCallId);
  }

  private push<K extends AppEventType>(
    type: K,
    payload: AppEventPayloads[K],
  ): void {
    
    this.emit(this.sequencer.build(type, payload, this.turnId) as AnyAppEvent);
  }

  
  private toolCallId(sourceId: string) {
    return asToolCallId(this.turnId ? `${this.turnId}:${sourceId}` : sourceId);
  }
}
