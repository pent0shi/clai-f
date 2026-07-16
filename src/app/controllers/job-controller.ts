import type { ToolResult } from "../../types.js";
import type { BackgroundJob, JobsPort } from "../ports/jobs-port.js";
import type { Disposable } from "./disposable.js";


export class JobController implements Disposable {
  constructor(private readonly jobs: JobsPort) {}

  list(): ToolResult {
    return this.jobs.list();
  }

  running(): BackgroundJob[] {
    return this.jobs.running();
  }

  get(id: string): BackgroundJob | undefined {
    return this.jobs.get(id);
  }

  tail(id: string, bytes?: number): Promise<ToolResult> {
    return this.jobs.tail(id, bytes);
  }

  stop(id: string): Promise<ToolResult> {
    return this.jobs.stop(id);
  }

  start(
    command: string,
    options?: { cwd?: string | undefined; name?: string | undefined },
  ): Promise<ToolResult> {
    return this.jobs.start(command, options);
  }

  hasRunning(): boolean {
    return this.running().length > 0;
  }

  dispose(): void {
    // Jobs intentionally outlive the UI; nothing to tear down here.
  }
}
