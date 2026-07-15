import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  applyDestinationCwd,
  canMarkTaskDone,
  codingBuildRequiresPlan,
  isBuildPrePlanAllowedTool,
  isDevServerCall,
  isLongQuietInstallOrScaffoldCommand,
  isReadOnlyVersionProbeCommand,
  isScaffoldCreateCommand,
  openTaskLedger,
  pickPendingTaskForToolCall,
  recordTaskWorkSuccess,
  resolveUserDestinationHint,
  toolStallBudgetMs,
  userAskedForFeatureApp,
  workOutOfScopeForTask,
} from "../src/agent/task-evidence.js";
import { ensureCodingPlanInstallTask } from "../src/agent/plan-tool.js";
import { isProjectLocalNodeBin } from "../src/tools/capabilities.js";

describe("task evidence / verify-before-done", () => {
  it("blocks done without successful work", () => {
    expect(canMarkTaskDone(null, "t1").ok).toBe(false);
    expect(canMarkTaskDone(openTaskLedger("t1"), "t1").ok).toBe(false);
    const led = recordTaskWorkSuccess(openTaskLedger("t1"), "t1", "fs.write");
    expect(canMarkTaskDone(led, "t1").ok).toBe(true);
    expect(canMarkTaskDone(led, "t2").ok).toBe(false);
  });

  it("counts only non-meta tools as evidence", () => {
    let led = openTaskLedger("t1");
    led = recordTaskWorkSuccess(led, "t1", "task.update");
    expect(led?.successWorkCount).toBe(0);
    led = recordTaskWorkSuccess(led, "t1", "shell.exec");
    expect(led?.successWorkCount).toBe(1);
  });
});

describe("work out of scope for open task", () => {
  it("blocks dev server during install task", () => {
    const msg = workOutOfScopeForTask("Install project dependencies", {
      name: "shell.start",
      args: { command: "npm run dev" },
    });
    expect(msg).toMatch(/not start the dev server/i);
  });

  it("blocks localhost probe during implement task", () => {
    const msg = workOutOfScopeForTask("Add Todo component and integrate", {
      name: "shell.exec",
      args: { command: "curl -s http://localhost:5173" },
    });
    expect(msg).toMatch(/probe localhost/i);
  });

  it("allows shell.start on run/verify task", () => {
    expect(
      workOutOfScopeForTask(
        "Start dev server, probe localhost, leave running",
        { name: "shell.start", args: { command: "npm run dev" } },
      ),
    ).toBeUndefined();
  });

  it("allows npm create vite under scaffold task (not a false dev-server block)", () => {
    const cmd =
      "npm create vite@latest /Users/aniketpandey/Desktop/todo-app -- --template react";
    expect(isScaffoldCreateCommand(cmd)).toBe(true);
    expect(
      isDevServerCall({ name: "shell.exec", args: { command: cmd } }),
    ).toBe(false);
    expect(
      workOutOfScopeForTask(
        "Scaffold Vite React project in /Users/aniketpandey/Desktop/todo-app",
        { name: "shell.exec", args: { command: cmd } },
      ),
    ).toBeUndefined();
  });

  it("treats cargo new / rails new as scaffolders not dev servers", () => {
    for (const cmd of ["cargo new myapp", "rails new blog", "poetry new svc"]) {
      expect(isScaffoldCreateCommand(cmd)).toBe(true);
      expect(
        isDevServerCall({ name: "shell.exec", args: { command: cmd } }),
      ).toBe(false);
    }
  });

  it("still treats bare vite / npm run dev as dev server", () => {
    expect(
      isDevServerCall({
        name: "shell.exec",
        args: { command: "npm run dev" },
      }),
    ).toBe(true);
    expect(
      isDevServerCall({ name: "shell.exec", args: { command: "vite" } }),
    ).toBe(true);
  });
});

describe("desktop destination hint", () => {
  it("resolves desktop directory phrasing", () => {
    const desk = join(homedir(), "Desktop");
    expect(
      resolveUserDestinationHint("create a react todo app in desktop directory"),
    ).toBe(desk);
    expect(
      resolveUserDestinationHint("build a vite app on the desktop"),
    ).toBe(desk);
  });

  it("applies cwd to scaffold/install when omitted", () => {
    const desk = join(homedir(), "Desktop");
    const call = applyDestinationCwd(
      {
        name: "shell.exec",
        args: {
          command: "npx create-vite@latest react-todo-app --template react",
        },
      },
      desk,
    );
    expect(call.args.cwd).toBe(desk);
  });

  it("does not override explicit cwd", () => {
    const call = applyDestinationCwd(
      {
        name: "shell.exec",
        args: { command: "npm install", cwd: "/tmp/app" },
      },
      join(homedir(), "Desktop"),
    );
    expect(call.args.cwd).toBe("/tmp/app");
  });
});

describe("coding plan requirement helpers", () => {
  it("detects feature apps and pre-plan tools", () => {
    expect(userAskedForFeatureApp("create a nextjs todo app in desktop")).toBe(
      true,
    );
    expect(userAskedForFeatureApp("just scaffold a blank next app")).toBe(
      false,
    );
    expect(isBuildPrePlanAllowedTool("fs.list")).toBe(true);
    expect(isBuildPrePlanAllowedTool("plan.create")).toBe(true);
    expect(isBuildPrePlanAllowedTool("web.search")).toBe(true);
    expect(isBuildPrePlanAllowedTool("shell.exec")).toBe(false);
    expect(isReadOnlyVersionProbeCommand("node -v")).toBe(true);
    expect(isReadOnlyVersionProbeCommand("npm create vite@latest x")).toBe(
      false,
    );
    expect(
      codingBuildRequiresPlan("create a react todo app", {
        informational: false,
        idle: false,
        pentest: false,
      }),
    ).toBe(true);
  });

  it("gives long stall budgets to scaffold/install", () => {
    expect(
      isLongQuietInstallOrScaffoldCommand(
        "npx create-next-app@latest /tmp/x --yes",
      ),
    ).toBe(true);
    expect(isLongQuietInstallOrScaffoldCommand("npm install")).toBe(true);
    expect(isLongQuietInstallOrScaffoldCommand("ls -la")).toBe(false);
    expect(
      toolStallBudgetMs({
        name: "shell.exec",
        args: { command: "npx create-next-app@latest todo --yes" },
      }),
    ).toBeGreaterThanOrEqual(10 * 60_000);
    expect(
      toolStallBudgetMs({
        name: "shell.exec",
        args: { command: "echo hi" },
      }),
    ).toBe(60_000);
  });

  it("picks install task for npm install, not localStorage", () => {
    const pending = [
      { id: "t2", title: "Add Todo component and state logic" },
      { id: "t3", title: "Install project dependencies" },
      { id: "t4", title: "Persist tasks in localStorage" },
    ];
    const pick = pickPendingTaskForToolCall(pending, {
      name: "shell.exec",
      args: { command: "npm install" },
    });
    expect(pick?.id).toBe("t3");
  });

  it("allows install under implement only when plan has no install task", () => {
    const implement = "Add Todo component and state logic";
    const installCall = {
      name: "shell.exec",
      args: { command: "npm install" },
    };
    expect(
      workOutOfScopeForTask(implement, installCall, {
        planTaskTitles: [
          "Scaffold",
          implement,
          "Install project dependencies",
          "Run dev",
        ],
      }),
    ).toMatch(/install task/i);
    expect(
      workOutOfScopeForTask(implement, installCall, {
        planTaskTitles: ["Scaffold", implement, "Run dev"],
      }),
    ).toBeUndefined();
  });

  it("injects install task into coding app plans", () => {
    const titles = ensureCodingPlanInstallTask(
      "coding",
      "Create a React Todo app",
      "Vite react todo",
      [
        "Create Vite React project",
        "Add Todo component",
        "Run dev server and verify",
      ],
    );
    expect(titles.some((t) => /install/i.test(t))).toBe(true);
    expect(titles[0]).toMatch(/Create Vite|Scaffold|project/i);
    expect(titles[1]).toMatch(/install/i);
  });
});

describe("tool.check local bin filter", () => {
  it("detects project-local node_modules bins", () => {
    expect(
      isProjectLocalNodeBin(
        "/Users/aniketpandey/Desktop/clai/node_modules/.bin/vite",
      ),
    ).toBe(true);
    expect(isProjectLocalNodeBin("/opt/homebrew/bin/node")).toBe(false);
  });
});
