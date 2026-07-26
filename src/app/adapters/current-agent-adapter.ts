import { runAgentTurn } from "../../agent/runner.js";
import type { AgentPort } from "../ports/agent-port.js";


export function createCurrentAgentPort(): AgentPort {
  return {
    runTurn(request, handlers) {
      return runAgentTurn(request.prompt, {
        provider: request.provider,
        model: request.model,
        history: request.history ? [...request.history] : undefined,
        images: request.images ? [...request.images] : undefined,
        autoConfirm: request.autoConfirm,
        maxSteps: request.maxSteps,
        onEvent: handlers.onEvent,
        onMessages: handlers.onMessages,
        signal: handlers.signal,
        confirm: handlers.confirm,
        requestSecret: handlers.requestSecret,
        session: handlers.session,
        mode: request.mode,
        displayPrompt: request.displayPrompt,
        previousTurn: request.previousTurn,
      });
    },
  };
}
