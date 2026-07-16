import type { BackgroundJob } from "../../tools/jobs.js";
import type { ToolResult } from "../../types.js";

export type { BackgroundJob };


export interface JobsPort {
  list(): ToolResult;
  running(): BackgroundJob[];
  recent?(limit?: number): BackgroundJob[];
  get(id: string): BackgroundJob | undefined;
  tail(id: string, bytes?: number): Promise<ToolResult>;
  stop(id: string): Promise<ToolResult>;
  start(
    command: string,
    options?: { cwd?: string | undefined; name?: string | undefined },
  ): Promise<ToolResult>;
}
