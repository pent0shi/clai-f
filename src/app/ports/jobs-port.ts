import type { BackgroundJob } from "../../tools/jobs.js";
import type { ToolResult } from "../../types.js";

export type { BackgroundJob };


export interface JobsPort {
  list(sessionId?: string): ToolResult;
  running(sessionId?: string): BackgroundJob[];
  recent?(limit?: number, sessionId?: string): BackgroundJob[];
  get(id: string): BackgroundJob | undefined;
  tail(id: string, bytes?: number): Promise<ToolResult>;
  stop(id: string): Promise<ToolResult>;
  start(
    command: string,
    options?: {
      cwd?: string | undefined;
      name?: string | undefined;
      ownerSessionId?: string | undefined;
    },
  ): Promise<ToolResult>;
}
