import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCurrentJobsPort } from "../src/app/adapters/current-jobs-adapter.js";
import { SessionResponder } from "../src/app/controllers/session-responder.js";
import { createPlan, type SessionPlan } from "../src/store/plan.js";
import { JobManager } from "../src/tools/jobs.js";

const dirs: string[] = [];
const managers: JobManager[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const completedTurn = () => ({ status: "completed" as const });

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    for (const job of manager.getRunningJobs()) {
      await manager.stopJob(job.id, { graceMs: 200 });
    }
  }
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "clai-wake-"));
  dirs.push(dir);
  const manager = new JobManager(dir);
  managers.push(manager);
  return { dir, manager };
}

function makeResponder(
  manager: JobManager,
  sessionId: string,
  busy: { value: boolean },
  options: {
    runTurn?: ReturnType<typeof vi.fn>;
    persistence?: {
      loadPlan: (sessionId: string) => Promise<SessionPlan | undefined>;
      savePlan: (plan: SessionPlan) => Promise<void>;
    };
  } = {},
) {
  const port = createCurrentJobsPort(manager);
  const runTurn = options.runTurn ?? vi.fn().mockResolvedValue(completedTurn());
  const notifyDelivery = vi.fn();
  const persistence = options.persistence ?? {
    loadPlan: async () => undefined,
    savePlan: async () => undefined,
  };
  const responder = new SessionResponder({
    jobs: port,
    persistence: {
      ...persistence,
      saveSession: async () => undefined,
      deletePlan: async () => undefined,
    },
    sequencer: { build: () => ({}) } as never,
    emit: () => undefined,
    sessionId: () => sessionId,
    isBusy: () => busy.value,
    hasQueuedWork: () => false,
    continueQueue: async () => undefined,
    runTurn,
    notifyState: () => undefined,
    notifyDelivery,
  });
  const unsubscribe = port.subscribe((change) => responder.handleChange(change));
  return { responder, runTurn, notifyDelivery, unsubscribe, port };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error("condition not reached before timeout");
}

describe("responder wake", () => {
  it("delivers and acknowledges a responder completion while idle", async () => {
    const { manager } = await fixture();
    const busy = { value: false };
    const { runTurn, notifyDelivery, unsubscribe } = makeResponder(
      manager,
      "s1",
      busy,
    );
    const started = await manager.startJob(
      `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      { ownerSessionId: "s1", responder: true, wakeOnCompletion: true },
    );
    expect(started.backgroundJob?.id).toBeTruthy();
    await waitFor(() => runTurn.mock.calls.length === 1);
    await waitFor(() => manager.getPendingNotifications("s1").length === 0);
    unsubscribe();
    expect(notifyDelivery).toHaveBeenCalledTimes(1);
  });

  it("does not strand a completion that arrives while the session is busy", async () => {
    const { manager } = await fixture();
    const busy = { value: true };
    const { responder, runTurn, unsubscribe } = makeResponder(manager, "s2", busy);
    await manager.startJob(
      `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      { ownerSessionId: "s2", responder: true, wakeOnCompletion: true },
    );
    await waitFor(() => manager.getPendingNotifications("s2").length > 0);
    expect(manager.getPendingNotifications("s2")[0]?.deliveredAt).toBeUndefined();
    await sleep(50);
    expect(runTurn).not.toHaveBeenCalled();

    busy.value = false;
    responder.scheduleWake();
    await waitFor(() => runTurn.mock.calls.length === 1);
    await waitFor(() => manager.getPendingNotifications("s2").length === 0);
    unsubscribe();
  });

  it("self-heals after a missed idle-transition callback", async () => {
    const { manager } = await fixture();
    const busy = { value: true };
    const { runTurn, unsubscribe } = makeResponder(manager, "s3", busy);
    await manager.startJob(
      `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      { ownerSessionId: "s3", responder: true, wakeOnCompletion: true },
    );
    await waitFor(() => manager.getPendingNotifications("s3").length > 0);
    expect(runTurn).not.toHaveBeenCalled();

    busy.value = false;
    await waitFor(() => runTurn.mock.calls.length === 1, 3_000);
    await waitFor(() => manager.getPendingNotifications("s3").length === 0);
    unsubscribe();
  });

  it("replays a wake requested while a previous responder turn is in flight", async () => {
    const { manager } = await fixture();
    const busy = { value: false };
    let releaseFirst!: (value: ReturnType<typeof completedTurn>) => void;
    const firstTurn = new Promise<ReturnType<typeof completedTurn>>((resolve) => {
      releaseFirst = resolve;
    });
    const runTurn = vi
      .fn()
      .mockImplementationOnce(() => firstTurn)
      .mockResolvedValue(completedTurn());
    const { notifyDelivery, unsubscribe } = makeResponder(manager, "s4", busy, {
      runTurn,
    });

    await manager.startJob(
      `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      { ownerSessionId: "s4", responder: true, wakeOnCompletion: true },
    );
    await waitFor(() => runTurn.mock.calls.length === 1);

    await manager.startJob(
      `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      { ownerSessionId: "s4", responder: true, wakeOnCompletion: true },
    );
    await waitFor(() => manager.getPendingNotifications("s4").length === 2);
    releaseFirst(completedTurn());

    await waitFor(() => runTurn.mock.calls.length === 2);
    await waitFor(() => manager.getPendingNotifications("s4").length === 0);
    unsubscribe();
    expect(notifyDelivery).toHaveBeenCalledTimes(2);
  });

  it("reconciles a responder task after the analysis turn overwrites its state", async () => {
    const { manager } = await fixture();
    const busy = { value: false };
    let plan = createPlan({
      sessionId: "s5",
      goal: "scan",
      detail: "",
      taskTitles: ["Responder scan"],
      kind: "pentest",
    });
    plan.status = "in_progress";
    plan.tasks[0]!.state = "in_progress";
    plan.tasks[0]!.responderOwned = true;
    const persistence = {
      loadPlan: async () => structuredClone(plan),
      savePlan: async (next: SessionPlan) => {
        plan = structuredClone(next);
      },
    };
    const runTurn = vi.fn(async () => {
      plan.tasks[0]!.state = "in_progress";
      plan.tasks[0]!.note = "stale analysis snapshot";
      plan.status = "in_progress";
      return completedTurn();
    });
    const { unsubscribe } = makeResponder(manager, "s5", busy, {
      runTurn,
      persistence,
    });

    const started = await manager.startJob(
      `${JSON.stringify(process.execPath)} -e "setTimeout(() => process.exit(0), 150)"`,
      {
        ownerSessionId: "s5",
        responder: true,
        wakeOnCompletion: true,
        taskId: "parent-task",
      },
    );
    const jobId = started.backgroundJob?.id;
    expect(jobId).toBeTruthy();
    plan.tasks[0]!.jobId = jobId;

    await waitFor(() => runTurn.mock.calls.length === 1);
    await waitFor(() => manager.getPendingNotifications("s5").length === 0);
    unsubscribe();
    expect(plan.tasks[0]).toMatchObject({
      state: "done",
      responderOwned: true,
      jobId,
    });
    expect(plan.tasks[0]?.note).toContain(`job=${jobId} status=exited exit=0`);
    expect(manager.getJob(jobId!)?.taskId).toBe("t1");
  });
});


describe("responder delivery settlement", () => {
  it("retries task persistence without rerunning completed analysis", async () => {
    const { manager } = await fixture();
    const busy = { value: false };
    let plan = createPlan({
      sessionId: "settlement-save",
      goal: "scan",
      detail: "",
      taskTitles: ["Responder scan"],
    });
    plan.status = "in_progress";
    plan.tasks[0]!.state = "in_progress";
    plan.tasks[0]!.responderOwned = true;
    let saveAttempts = 0;
    const persistence = {
      loadPlan: async () => structuredClone(plan),
      savePlan: async (next: SessionPlan) => {
        saveAttempts += 1;
        if (saveAttempts <= 4) throw new Error("transient plan write failure");
        plan = structuredClone(next);
      },
    };
    const runTurn = vi.fn().mockResolvedValue(completedTurn());
    const { unsubscribe } = makeResponder(manager, "settlement-save", busy, {
      runTurn,
      persistence,
    });

    const started = await manager.startJob(
      `${JSON.stringify(process.execPath)} -e "setTimeout(() => process.exit(0), 150)"`,
      {
        ownerSessionId: "settlement-save",
        responder: true,
        wakeOnCompletion: true,
        taskId: "t1",
      },
    );
    const jobId = started.backgroundJob?.id;
    expect(jobId).toBeTruthy();
    plan.tasks[0]!.jobId = jobId;

    await waitFor(() => runTurn.mock.calls.length === 1);
    await waitFor(
      () => manager.getPendingNotifications("settlement-save").length === 0,
      5_000,
    );
    unsubscribe();
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(saveAttempts).toBeGreaterThanOrEqual(5);
    expect(plan.tasks[0]?.state).toBe("done");
  });

  it("retries acknowledgement without rerunning completed analysis", async () => {
    const { manager } = await fixture();
    const busy = { value: false };
    const runTurn = vi.fn().mockResolvedValue(completedTurn());
    const { unsubscribe } = makeResponder(manager, "settlement-ack", busy, {
      runTurn,
    });
    const mutable = manager as unknown as {
      acknowledge: (notificationId: string) => boolean;
    };
    const acknowledge = mutable.acknowledge.bind(manager);
    let attempts = 0;
    mutable.acknowledge = (notificationId) => {
      attempts += 1;
      return attempts === 1 ? false : acknowledge(notificationId);
    };

    await manager.startJob(
      `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      {
        ownerSessionId: "settlement-ack",
        responder: true,
        wakeOnCompletion: true,
      },
    );
    await waitFor(() => runTurn.mock.calls.length === 1);
    await waitFor(
      () => manager.getPendingNotifications("settlement-ack").length === 0,
      3_000,
    );
    mutable.acknowledge = acknowledge;
    unsubscribe();
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(attempts).toBe(2);
  });

  it("bounds automatic model retries after aborted responder turns", async () => {
    const { manager } = await fixture();
    const busy = { value: false };
    const runTurn = vi.fn().mockResolvedValue({ status: "aborted" as const });
    const { unsubscribe } = makeResponder(manager, "bounded-abort", busy, {
      runTurn,
    });

    await manager.startJob(
      `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      {
        ownerSessionId: "bounded-abort",
        responder: true,
        wakeOnCompletion: true,
      },
    );
    await waitFor(() => runTurn.mock.calls.length === 3, 4_000);
    await sleep(1_000);
    unsubscribe();
    expect(runTurn).toHaveBeenCalledTimes(3);
    expect(manager.getPendingNotifications("bounded-abort")).toHaveLength(1);
  });
});



describe("authoritative responder task settlement", () => {
  function responderPlan(sessionId: string): SessionPlan {
    const plan = createPlan({
      sessionId,
      goal: "build",
      detail: "",
      taskTitles: ["Responder build"],
      kind: "coding",
    });
    plan.status = "in_progress";
    plan.tasks[0]!.state = "in_progress";
    plan.tasks[0]!.responderOwned = true;
    return plan;
  }

  it("settles done from the current exit-0 job even when the receipt says lost", async () => {
    const { manager } = await fixture();
    const sessionId = "lost-then-exited";
    const started = await manager.startJob(
      `${JSON.stringify(process.execPath)} -e "console.log('build ok'); process.exit(0)"`,
      {
        ownerSessionId: sessionId,
        responder: true,
        wakeOnCompletion: true,
        taskId: "t1",
      },
    );
    const jobId = started.backgroundJob?.id;
    expect(jobId).toBeTruthy();
    await waitFor(() => manager.getJob(jobId!)?.status === "exited");
    const stale = manager.getPendingNotifications(sessionId)[0]!;
    stale.status = "lost";
    stale.exitCode = undefined;
    stale.stdoutArtifact.bytes = 0;

    let plan = responderPlan(sessionId);
    plan.tasks[0]!.jobId = jobId;
    const persistence = {
      loadPlan: async () => structuredClone(plan),
      savePlan: async (next: SessionPlan) => {
        plan = structuredClone(next);
      },
    };
    const runTurn = vi.fn().mockResolvedValue(completedTurn());
    const busy = { value: false };
    const { responder, unsubscribe } = makeResponder(manager, sessionId, busy, {
      runTurn,
      persistence,
    });

    responder.scheduleWake();
    await waitFor(() => runTurn.mock.calls.length === 1);
    await waitFor(() => manager.getPendingNotifications(sessionId).length === 0);
    unsubscribe();

    expect(runTurn.mock.calls[0]?.[0]).toContain(
      "task settlement is automatic from the authoritative job result",
    );
    expect(plan.tasks[0]).toMatchObject({ state: "done", jobId });
    expect(plan.tasks[0]?.note).toContain(`job=${jobId} status=exited exit=0`);
  });

  it("keeps a genuinely nonzero responder job failed", async () => {
    const { manager } = await fixture();
    const sessionId = "failed-build";
    const started = await manager.startJob(
      `${JSON.stringify(process.execPath)} -e "process.exit(7)"`,
      {
        ownerSessionId: sessionId,
        responder: true,
        wakeOnCompletion: true,
        taskId: "t1",
      },
    );
    const jobId = started.backgroundJob?.id;
    expect(jobId).toBeTruthy();
    await waitFor(() => manager.getJob(jobId!)?.status === "failed");

    let plan = responderPlan(sessionId);
    plan.tasks[0]!.jobId = jobId;
    const persistence = {
      loadPlan: async () => structuredClone(plan),
      savePlan: async (next: SessionPlan) => {
        plan = structuredClone(next);
      },
    };
    const busy = { value: false };
    const { responder, runTurn, unsubscribe } = makeResponder(
      manager,
      sessionId,
      busy,
      { persistence },
    );

    responder.scheduleWake();
    await waitFor(() => runTurn.mock.calls.length === 1);
    await waitFor(() => manager.getPendingNotifications(sessionId).length === 0);
    unsubscribe();

    expect(plan.tasks[0]).toMatchObject({ state: "failed", jobId });
    expect(plan.tasks[0]?.note).toContain(`job=${jobId} status=failed exit=7`);
  });
});
