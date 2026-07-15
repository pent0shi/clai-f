import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildWorkspaceOrientation,
  extractScaffoldTargetName,
  guessProjectFolderName,
  isBareParentDirectory,
  isExistingProjectDir,
  isScaffoldCancelledOutput,
  resolveScaffoldTargetPath,
  scaffoldLooksMaterialized,
  scaffoldTargetConflictMessage,
  snapshotDir,
} from "../src/agent/workspace-orient.js";
import {
  clearActiveProjectRoot,
  setActiveProjectRoot,
  setActiveProjectRootIfValid,
  getActiveProjectRoot,
  resolveToolPath,
} from "../src/agent/project-root.js";
import { homedir } from "node:os";

describe("workspace orientation (stack-agnostic)", () => {
  const temps: string[] = [];
  afterEach(() => {
    clearActiveProjectRoot();
    for (const t of temps) {
      try {
        rmSync(t, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    temps.length = 0;
  });

  function tmpProject(withPkg = true): string {
    const dir = mkdtempSync(join(tmpdir(), "clai-ws-"));
    temps.push(dir);
    if (withPkg) writeFileSync(join(dir, "package.json"), '{"name":"x"}');
    return dir;
  }

  it("detects existing projects via markers", () => {
    const dir = tmpProject(true);
    expect(isExistingProjectDir(dir)).toBe(true);
    const empty = tmpProject(false);
    expect(isExistingProjectDir(empty)).toBe(false);
  });

  it("snapshots dir entries and markers", () => {
    const dir = tmpProject(true);
    writeFileSync(join(dir, "README.md"), "hi");
    const snap = snapshotDir(dir);
    expect(snap.exists).toBe(true);
    expect(snap.isProject).toBe(true);
    expect(snap.markers).toContain("package.json");
    expect(snap.entries).toEqual(expect.arrayContaining(["package.json", "README.md"]));
  });

  it("buildWorkspaceOrientation includes cwd and existing subfolder", () => {
    const parent = mkdtempSync(join(tmpdir(), "clai-parent-"));
    temps.push(parent);
    const app = join(parent, "todo-app");
    mkdirSync(app);
    writeFileSync(join(app, "Cargo.toml"), "[package]\nname='x'");
    const text = buildWorkspaceOrientation({
      cwd: parent,
      destinationHint: parent,
      extraPaths: [app],
    });
    expect(text).toMatch(/WORKSPACE STATUS/);
    expect(text).toContain(app);
    expect(text).toMatch(/EXISTING PROJECT|Cargo\.toml/);
    expect(text).toMatch(/do NOT re-scaffold/i);
  });

  it("guesses todo-app from natural language", () => {
    expect(
      guessProjectFolderName("create a react todo app in desktop directory"),
    ).toBe("todo-app");
    expect(guessProjectFolderName("build app in Desktop/my-api")).toBe("my-api");
  });

  it("extracts scaffold target names across stacks", () => {
    expect(
      extractScaffoldTargetName(
        "npm create vite@latest todo-app -- --template react",
      ),
    ).toBe("todo-app");
    expect(extractScaffoldTargetName("cargo new mycrate")).toBe("mycrate");
    expect(extractScaffoldTargetName("rails new blog")).toBe("blog");
    expect(extractScaffoldTargetName("poetry new svc")).toBe("svc");
  });

  it("resolves scaffold target under shell cwd", () => {
    expect(
      resolveScaffoldTargetPath(
        "npm create vite@latest todo-app -- --template react",
        "/Users/alice/Desktop",
      ),
    ).toBe("/Users/alice/Desktop/todo-app");
    expect(
      resolveScaffoldTargetPath("cargo new widget", "/tmp/work"),
    ).toBe("/tmp/work/widget");
    expect(
      resolveScaffoldTargetPath("go mod init github.com/a/b", "/tmp/proj"),
    ).toBe("/tmp/proj");
  });

  it("resolves cd && create . chained shell commands", () => {
    expect(
      resolveScaffoldTargetPath(
        "mkdir -p /Users/alice/Desktop/todo-app && cd /Users/alice/Desktop/todo-app && npm init vite@latest . -- --template react",
        "/Users/alice/Desktop/clai",
      ),
    ).toBe("/Users/alice/Desktop/todo-app");
  });

  it("detects cancelled scaffold output", () => {
    expect(isScaffoldCancelledOutput("└  Operation cancelled")).toBe(true);
    expect(isScaffoldCancelledOutput("Scaffolding project in /tmp/x...")).toBe(
      false,
    );
  });

  it("blocks scaffold into existing non-empty project", () => {
    const dir = tmpProject(true);
    const parent = join(dir, "..");
    const name = dir.split(/[/\\]/).pop()!;
    // Command creates sibling-looking name under parent - use absolute path form
    const msg = scaffoldTargetConflictMessage(
      `npm create vite@latest ${dir} -- --template react`,
      parent,
    );
    expect(msg).toMatch(/already exists/i);
    expect(msg).toMatch(/CONTINUE/i);
  });

  it("allows scaffold into missing path", () => {
    const parent = mkdtempSync(join(tmpdir(), "clai-empty-"));
    temps.push(parent);
    const msg = scaffoldTargetConflictMessage(
      "npm create vite@latest brand-new-app -- --template react",
      parent,
    );
    expect(msg).toBeUndefined();
  });

  it("scaffoldLooksMaterialized requires real tree", () => {
    const dir = tmpProject(true);
    expect(scaffoldLooksMaterialized(dir)).toBe(true);
    expect(scaffoldLooksMaterialized(join(dir, "nope"))).toBe(false);
  });

  it("refuses to pin bare Desktop as active project root", () => {
    const desk = join(homedir(), "Desktop");
    expect(isBareParentDirectory(desk)).toBe(true);
    setActiveProjectRoot(desk);
    expect(getActiveProjectRoot()).toBeUndefined();
    expect(setActiveProjectRootIfValid(desk)).toBe(false);
  });

  it("pins existing project and resolves relative paths there", () => {
    const dir = tmpProject(true);
    expect(setActiveProjectRootIfValid(dir)).toBe(true);
    expect(resolveToolPath("src/main.rs")).toBe(join(dir, "src/main.rs"));
  });

  it("does not pin non-existent invented project path", () => {
    const fake = join(homedir(), "Desktop", "definitely-not-real-xyz-999");
    if (existsSync(fake)) {
      // skip weird environments
      return;
    }
    expect(setActiveProjectRootIfValid(fake)).toBe(false);
    expect(getActiveProjectRoot()).toBeUndefined();
  });
});
