import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  clearActiveProjectRoot,
  extractProjectRootFromScaffold,
  extractProjectRootFromText,
  getActiveProjectRoot,
  remapAgentCwdWrite,
  resolveToolPath,
  setActiveProjectRoot,
} from "../src/agent/project-root.js";
import { safeCwd } from "../src/os/cwd.js";

describe("project root sticky paths", () => {
  afterEach(() => {
    clearActiveProjectRoot();
  });

  it("extracts Desktop/todo-app from plan-like text", () => {
    const root = extractProjectRootFromText(
      "Scaffold Vite React project in /Users/aniketpandey/Desktop/todo-app",
    );
    expect(root).toBe("/Users/aniketpandey/Desktop/todo-app");
  });

  it("extracts from create-vite command + Desktop cwd", () => {
    const root = extractProjectRootFromScaffold(
      "npm create vite@latest todo-app -- --template react",
      "/Users/aniketpandey/Desktop",
    );
    expect(root).toBe("/Users/aniketpandey/Desktop/todo-app");
  });

  it("resolves relative fs paths under project root not agent cwd", () => {
    const project = join(homedir(), "Desktop", "todo-app");
    setActiveProjectRoot(project);
    expect(resolveToolPath("src/App.jsx")).toBe(join(project, "src/App.jsx"));
    expect(resolveToolPath("src/App.jsx")).not.toContain("/clai/src/");
  });

  it("remaps agent-cwd absolute src writes onto project root", () => {
    const project = join(homedir(), "Desktop", "todo-app");
    const agent = safeCwd();
    setActiveProjectRoot(project);
    const wrong = join(agent, "src", "App.jsx");
    const fixed = remapAgentCwdWrite(wrong, "src/App.jsx");
    expect(fixed).toBe(join(project, "src", "App.jsx"));
  });

  it("set/get active root", () => {
    setActiveProjectRoot("/tmp/my-app");
    expect(getActiveProjectRoot()).toBe("/tmp/my-app");
  });

  it("does not pin bare Desktop as sticky root", () => {
    setActiveProjectRoot(join(homedir(), "Desktop"));
    expect(getActiveProjectRoot()).toBeUndefined();
  });

  it("extracts cargo/rails style paths via scaffold helper", () => {
    const root = extractProjectRootFromScaffold(
      "cargo new widget",
      "/Users/aniketpandey/Desktop",
    );
    expect(root).toBe("/Users/aniketpandey/Desktop/widget");
  });
});
