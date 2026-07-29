import { describe, expect, it } from "vitest";
import {
  responderPollingPolicy,
  type BackgroundJob,
  type JobStatus,
  type ResponderPollingPolicyInput,
} from "../src/tools/jobs.js";

function job(
  id: string,
  options: { responder?: boolean; status?: JobStatus } = {},
): BackgroundJob {
  const artifact = {
    path: `/tmp/${id}.log`,
    chunks: [] as string[],
    bytes: 0,
    droppedBytes: 0,
    redacted: false,
    sha256: "",
  };
  return {
    id,
    command: id,
    commandDisplay: id,
    cwd: "/tmp",
    status: options.status ?? "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    artifactPath: artifact.path,
    stdoutArtifact: artifact.path,
    stderrArtifact: `/tmp/${id}.stderr.log`,
    artifacts: { stdout: artifact, stderr: { ...artifact } },
    redactionProfile: "provider-secrets-v1",
    ownerSessionId: "poll-policy",
    ...(options.responder ? { responder: true } : {}),
  };
}

function decide(input: ResponderPollingPolicyInput) {
  return responderPollingPolicy(input);
}

describe("Responder polling policy", () => {
  it("blocks shell.tail for a Responder-owned job with actionable feedback", () => {
    const result = decide({
      call: { name: "shell.tail", args: { id: "responder-1" } },
      targetJob: job("responder-1", { responder: true }),
    });

    expect(result).toMatchObject({ blocked: true });
    expect(result.reason).toContain("shell.tail was not dispatched");
    expect(result.reason).toContain("delivered automatically");
    expect(result.reason).toContain("job.read");
  });

  it("allows shell.tail for a normal background job", () => {
    expect(
      decide({
        call: { name: "shell.tail", args: { id: "server-1" } },
        targetJob: job("server-1"),
      }),
    ).toEqual({ blocked: false });
  });

  it("blocks shell.jobs when every running job is Responder-owned", () => {
    const result = decide({
      call: { name: "shell.jobs", args: {} },
      recentJobs: [
        job("responder-1", { responder: true }),
        job("responder-2", { responder: true }),
      ],
    });

    expect(result).toMatchObject({ blocked: true });
    expect(result.reason).toContain("responder-1, responder-2");
    expect(result.reason).toContain("only running background job(s)");
  });

  it("allows shell.jobs for normal-only and mixed visible jobs", () => {
    const normal = job("server-1");
    const completedNormal = job("build-1", { status: "exited" });
    const responder = job("responder-1", { responder: true });

    expect(
      decide({
        call: { name: "shell.jobs", args: {} },
        recentJobs: [normal],
      }),
    ).toEqual({ blocked: false });
    expect(
      decide({
        call: { name: "shell.jobs", args: {} },
        recentJobs: [normal, responder],
      }),
    ).toEqual({ blocked: false });
    expect(
      decide({
        call: { name: "shell.jobs", args: {} },
        recentJobs: [completedNormal, responder],
      }),
    ).toEqual({ blocked: false });
  });

  it("allows shell.jobs when nothing is running", () => {
    expect(
      decide({
        call: { name: "shell.jobs", args: {} },
        recentJobs: [],
      }),
    ).toEqual({ blocked: false });
  });
});
