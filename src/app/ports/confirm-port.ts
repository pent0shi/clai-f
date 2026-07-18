import type { ToolCall } from "../../types.js";

export interface ConfirmationPort {
  confirmTool(call: ToolCall): Promise<boolean>;
  confirmPentest(): Promise<boolean>;
  confirmContinue?(steps: number, reason?: string): Promise<boolean>;
  confirmAgentSwitch?(info: {
    reason: string;
    tools: string[];
  }): Promise<boolean>;
}
