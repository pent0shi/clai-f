/** @jsxImportSource @opentui/react */
/**
 * Background jobs overlay (CORE-004, V2-075). Jobs live in the core job
 * manager and survive UI rerenders (`JobController` only observes/commands);
 * this component polls for live status since jobs are not event-driven, and
 * exceeds the classic TUI's list-only panel by routing "tail" through the
 * pager instead of leaving output to a separate agent tool call.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import type { BackgroundJob } from "../../../app/ports/jobs-port.js";
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { Theme } from "../../rendering/theme.js";
import { chordFromKeyEvent } from "../../actions/chord-from-key.js";

export interface JobsPanelProps {
  readonly services: AppServices;
  readonly theme: Theme;
}

const POLL_MS = 1000;

function statusView(job: BackgroundJob, theme: Theme): { text: string; fg: string } {
  if (job.status === "running") {
    const heartbeatAge = job.heartbeatAt ? Date.now() - new Date(job.heartbeatAt).getTime() : undefined;
    return heartbeatAge !== undefined && heartbeatAge > 120_000
      ? { text: "running (quiet)", fg: theme.foreground }
      : { text: "running", fg: theme.foreground };
  }
  if (job.status === "exited") {
    return { text: `exited (${job.exitCode ?? "?"})`, fg: job.exitCode ? theme.accent : theme.muted };
  }
  if (job.status === "failed") {
    return { text: `failed (${job.exitCode ?? "?"})`, fg: theme.accent };
  }
  if (job.status === "killed") {
    const detail = [job.signal, job.exitCode].filter((value) => value !== undefined).join("/") || "?";
    return { text: `killed (${detail})`, fg: theme.accent };
  }
  return { text: job.status, fg: theme.accent };
}

function elapsedLabel(job: BackgroundJob): string {
  const end = job.endedAt ? new Date(job.endedAt).getTime() : Date.now();
  return `${Math.round((end - new Date(job.startedAt).getTime()) / 1000)}s`;
}

export function JobsPanel(props: JobsPanelProps): ReactNode {
  const { services, theme } = props;
  // Session-scoped durable jobs only (same filter as shell.jobs).
  const readJobs = (): BackgroundJob[] => {
    const sessionId = services.session.sessionId;
    return (
      services.ports.jobs.recent?.(100, sessionId) ??
      services.ports.jobs.running(sessionId)
    );
  };
  const [jobs, setJobs] = useState<BackgroundJob[]>(readJobs);
  const [selected, setSelected] = useState(0);
  const [note, setNote] = useState("");

  useEffect(() => {
    const interval = setInterval(() => setJobs(readJobs()), POLL_MS);
    return () => clearInterval(interval);
  }, [services.ports.jobs, services.session.sessionId]);

  async function tail(job: BackgroundJob): Promise<void> {
    const result = await services.ports.jobs.tail(job.id);
    services.overlay.close();
    services.overlay.openPager(`${job.command} · tail`, result.output);
  }

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    const action = services.router.resolve(chordFromKeyEvent(key), "jobs");
    if (!action) return;
    key.preventDefault();
    const job = jobs[Math.min(selected, Math.max(0, jobs.length - 1))];
    switch (action) {
      case "jobs.up":
        setSelected((s) => Math.max(0, s - 1));
        break;
      case "jobs.down":
        setSelected((s) => Math.min(Math.max(0, jobs.length - 1), s + 1));
        break;
      case "jobs.stop":
        if (job?.status === "running") {
          void services.ports.jobs.stop(job.id).then((result) => {
            setNote(result.output);
            setJobs(readJobs());
          });
        }
        break;
      case "jobs.tail":
        if (job) void tail(job);
        break;
      case "jobs.close":
        services.overlay.close();
        break;
      default:
        break;
    }
  });

  // Full session id — these are short (`sess-<time36>-<rand6>`) and truncation
  // made history/jobs look like broken ids (`sess-mrq…`).
  const titleLine = `Background jobs · session ${services.session.sessionId}`;
  const helpLine =
    "up/down:select · enter/t:tail · k:kill · q/esc:close";

  return (
    <box
      title={` ${titleLine} `}
      titleColor={theme.accent}
      border
      borderStyle="rounded"
      style={{
        flexDirection: "column",
        width: "70%",
        height: "70%",
        borderColor: theme.border,
        backgroundColor: theme.background,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <text
        content={helpLine}
        wrapMode="none"
        style={{
          fg: theme.muted,
          height: 1,
          width: "100%",
        }}
      />
      <text
        content={"─".repeat(Math.min(48, helpLine.length + 4))}
        wrapMode="none"
        style={{ fg: theme.border, height: 1, width: "100%" }}
      />
      <text content=" " wrapMode="none" style={{ height: 1 }} />
      <scrollbox scrollY scrollX={false} viewportCulling style={{ flexGrow: 1, width: "100%" }}>
      {jobs.length === 0 ? (
        <text
          content="no background jobs for this session"
          wrapMode="none"
          style={{ fg: theme.muted, height: 1 }}
        />
      ) : (
        jobs.map((job, index) => {
          const status = statusView(job, theme);
          const focused = index === selected;
          const line = `${focused ? "❯ " : "  "}[${job.id}] ${status.text}  ${elapsedLabel(job)}  ${job.command.slice(0, 48)}`;
          return (
            <box key={job.id} onMouseDown={() => setSelected(index)} style={{ flexDirection: "row", height: 1 }}>
              <text
                content={line}
                wrapMode="none"
                style={{
                  fg: focused ? theme.accent : theme.foreground,
                  height: 1,
                  width: "100%",
                }}
              />
            </box>
          );
        })
      )}
      </scrollbox>
      {note ? (
        <text
          content={note}
          wrapMode="none"
          style={{ fg: theme.muted, height: 1 }}
        />
      ) : null}
    </box>
  );
}
