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

  it("bases plan.create on returned evidence without a fixed recon gate", () => {
    const directive = pentestWorkflowDirective();
    expect(directive).toContain("plan.create");
    expect(directive).toContain("returned tool evidence");
    expect(directive).toContain("fixed recon gate");
  });

  it("adds follow-up work only for evidence-driven discoveries", () => {
    const directive = pentestWorkflowDirective();
    expect(directive).toContain("Add follow-up tasks only for discoveries");
  });

  it("leaves reconnaissance and tool selection to model judgment", () => {
    const directive = pentestWorkflowDirective();
    expect(directive).toContain("options rather than a mandatory checklist");
    expect(directive).toContain("Use only what can resolve a meaningful hypothesis");
    expect(directive).toContain("expected impact");
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
  const toolList =
    "shell.exec, fs.read, whois.lookup, dns.lookup, net.context, http.fetch, net.scan, pentest.recon, plan.create, task.update";

  it("renders evidence-driven pentest guidance without a fixed tool sequence", () => {
    const prompt = renderAgentSystemPrompt(toolList, { pentest: true });
    expect(prompt).toContain("Choose each next action by expected information or access gain");
    expect(prompt).toContain("candidate dimensions—not a compulsory sequence");
    expect(prompt).toContain("optional techniques");
    expect(prompt).toContain("Use plan.create when a durable roadmap adds value");
    expect(prompt).toContain("Continue while a realistic in-scope action can materially improve the result");
  });

  it("keeps the methodology out of a non-pentest turn", () => {
    const coding = renderAgentSystemPrompt(toolList);
    expect(coding).not.toContain("# PENTEST METHODOLOGY");
    expect(coding).not.toContain("Choose each next action by expected information or access gain");
    // Everything else the constitution guarantees must survive the slice.
    expect(coding).toContain("# OPERATING RULES");
    expect(coding).toContain("# CROSS-OS AWARENESS");
    expect(coding.length).toBeLessThan(
      renderAgentSystemPrompt(toolList, { pentest: true }).length,
    );
  });

  it("attaches the methodology on the native-tool pentest path too", () => {
    const native = renderAgentSystemPrompt(toolList, {
      nativeTools: true,
      pentest: true,
    });
    expect(native).toContain("# PENTEST METHODOLOGY");
    expect(
      renderAgentSystemPrompt(toolList, { nativeTools: true }),
    ).not.toContain("# PENTEST METHODOLOGY");
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
    expect(directive).toMatch(/durable checklist/i);
    expect(directive).toMatch(/direct execution is valid/i);
    expect(directive).toMatch(/do NOT repeatedly relist the parent/i);
  });
});
