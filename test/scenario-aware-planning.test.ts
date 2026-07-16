import { describe, expect, it } from "vitest";
import {
  pentestWorkflowDirective,
  narrowNmapOperationDirective,
  buildWorkflowDirective,
  looksLikePentestTask,
} from "../src/agent/tool-call-parser.js";
import { renderAgentSystemPrompt } from "../src/prompts/index.js";

describe("pentestWorkflowDirective", () => {
  it("states this is a pentest / security engagement", () => {
    const directive = pentestWorkflowDirective();
    expect(directive.toLowerCase()).toContain("pentest");
    expect(directive.toLowerCase()).toContain("security");
    expect(directive).toContain("engagement");
  });

  it("calls out recon-first guidance", () => {
    const directive = pentestWorkflowDirective();
    expect(directive.toLowerCase()).toContain("recon");
  });

  it("instructs the agent to plan only after real findings", () => {
    const directive = pentestWorkflowDirective();
    expect(directive.toLowerCase()).toContain("finding");
  });

  it("requires a separate evidence-analysis response for plan.create", () => {
    const directive = pentestWorkflowDirective();
    expect(directive).toContain("RECON RESPONSE");
    expect(directive).toContain("ANALYSIS + PLAN RESPONSE");
    expect(directive).toContain("standalone plan.create");
    expect(directive).toContain("returned tool output");
  });

  it("allows incremental plan updates as attack surface grows", () => {
    const directive = pentestWorkflowDirective();
    expect(directive.toLowerCase()).toContain("incremental");
  });

  it("permits recon tools before a plan exists", () => {
    const directive = pentestWorkflowDirective();
    expect(directive).toContain("whois.lookup");
    expect(directive).toContain("dns.lookup");
    expect(directive).toContain("net.context");
    expect(directive).toContain("http.fetch");
    expect(directive).toContain("tool.batch");
    expect(directive).toContain("net.scan");
    expect(directive).toContain("pentest.recon");
  });

  it("reinforces the engagement scope boundary and out-of-scope flagging", () => {
    const directive = pentestWorkflowDirective();
    expect(directive.toLowerCase()).toContain("scope");
    expect(directive.toLowerCase()).toContain("out-of-scope");
    expect(directive.toLowerCase()).toMatch(/flag/);
  });
});

describe("narrowNmapOperationDirective", () => {
  it("requires one scan and forbids automatic pentest expansion", () => {
    const directive = narrowNmapOperationDirective();
    expect(directive).toMatch(/net\.scan exactly once/i);
    expect(directive).toMatch(/Do NOT call plan\.create/i);
    expect(directive).toMatch(/WHOIS, DNS, HTTP/i);
    expect(directive).toMatch(/backgroundJob\.id/i);
    expect(directive).toMatch(/Stop after reporting/i);
  });
});

describe("looksLikePentestTask", () => {
  it("detects an explicit pentest request against a domain", () => {
    expect(looksLikePentestTask("run a pentest against example.com")).toBe(
      true,
    );
  });

  it("still detects pentest keywords that don't end with the bare stem", () => {
    // Regression: the original regex required \bvulnerabilit\b followed by
    // a word boundary, which never matches "vulnerability" — only the
    // nonsense fragment "vulnerabilit" itself.
    expect(
      looksLikePentestTask("scan for vulnerabilities on the target"),
    ).toBe(true);
  });
});

describe("renderAgentSystemPrompt — pentest planning guidance", () => {
  it("renders the pentest-specific planning guidance for a pentest tool list", () => {
    // A tool list that includes the read-only recon tools the pentest
    // workflow permits before a plan exists.
    const toolList =
      "shell.exec, fs.read, whois.lookup, dns.lookup, net.context, http.fetch, net.scan, pentest.recon, plan.create, task.update";
    const prompt = renderAgentSystemPrompt(toolList);
    // PLANNING section now distinguishes coding builds from pentest:
    // recon-first, plan from findings, incremental task additions allowed.
    expect(prompt.toLowerCase()).toContain("recon");
    expect(prompt.toLowerCase()).toContain("finding");
    expect(prompt.toLowerCase()).toContain("incremental");
    // The PENTEST METHODOLOGY section leads with recon-before-plan.
    expect(prompt).toContain("RECON BEFORE PLAN");
    expect(prompt).toMatch(/RECON RESPONSE|ANALYSIS \+ PLAN RESPONSE|standalone plan\.create/i);
  });
});

describe("buildWorkflowDirective — stack-agnostic explore/continue guidance", () => {
  it("requires explore and handles existing vs new projects", () => {
    const directive = buildWorkflowDirective();
    expect(directive).toMatch(/EXPLORE/i);
    expect(directive).toMatch(/existing stack/i);
    expect(directive).toMatch(/CONTINUE an existing project|NEVER re-scaffold/i);
    expect(directive).toMatch(/Operation cancelled/i);
    expect(directive).toMatch(/stack-agnostic/i);
    expect(directive).toMatch(/durable plan/i);
    expect(directive).toMatch(/do NOT repeatedly relist the parent/i);
  });
});
