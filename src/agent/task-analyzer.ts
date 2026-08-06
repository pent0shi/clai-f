import type { TaskComplexity, TaskKind, PlanStep } from "./task-plan.js";
import { createPlanStep } from "./task-plan.js";

export interface TaskAnalysis {
  complexity: TaskComplexity;
  /** True when multi-step durable planning is warranted (soft signal). */
  shouldPlan: boolean;
  category: TaskKind;
  goal: string;
  needsNetworkContext: boolean;
  needsToolPreflight: boolean;
  likelyTools: string[];
  stopWhen: string;
  /** Soft high-level steps — never force-executed; empty for trivial asks. */
  suggestedSteps: PlanStep[];
}

const PENTEST_RE =
  /\b(?:pentest|pen[\s-]?test|penetration|security\s*(?:test|audit|scan|assess)|vapt|csrf|xss|sqli|sql[\s-]?inject|rce|lfi|rfi|ssrf|idor|xxe|deserialization|brute[\s-]?force|enumerat|exploit|vulnerabilit|recon|bug[\s-]?bounty|ctf|capture[\s-]?the[\s-]?flag|red[\s-]?team|offensive|nmap|nikto|nuclei|ffuf|gobuster|sqlmap|hydra|metasploit)\b/i;

const BUILD_RE =
  /\b(?:build|scaffold|create|implement|refactor|migrate|bootstrap|set\s*up|setup)\b/i;

const APP_RE =
  /\b(?:app|application|project|website|api|service|cli|dashboard|todo|blog|frontend|backend)\b/i;

const FIX_RE =
  /\b(?:fix|debug|broken|error|failing|crash|bug|regression|not\s+work|doesn'?t\s+work|typeerror|exception)\b/i;

const RESEARCH_RE =
  /\b(?:what\s+is|how\s+(?:do|does|to)|explain|compare|difference|latest|current|who\s+is|when\s+did|why\s+(?:is|does))\b/i;

const NETWORK_RE =
  /\b(?:scan|nmap|ping|subnet|cidr|local\s*network|hosts?|ports?|dns|whois|http|https|url|domain|ip\s*address)\b/i;

const SHELL_RE =
  /\b(?:run|execute|install|upgrade|brew|apt|npm\s+i|docker|kubectl|chmod|chown|kill|restart|service)\b/i;

const FS_RE =
  /\b(?:read|write|edit|file|directory|folder|path|rename|delete|list\s+files?|open\s+)\b/i;

/**
 * A bounded, explicit nmap operation is not a request for a full pentest.
 * Keep it to one net.scan call unless the user also asks for assessment,
 * reconnaissance, enumeration, exploitation, or multiple named operations.
 */
export function isNarrowExplicitNmapOperation(prompt: string): boolean {
  const text = prompt.replace(/\s+/g, " ").trim();
  const hasNmap = /\bnmap\b/i.test(text);
  const openPortIntent =
    /\b(?:find|check|scan|identify|show|list|discover)\b[\s\S]{0,32}\bopen\s+ports?\b/i.test(text) ||
    /\b(?:which|what)\s+ports?\s+(?:are\s+)?open\b/i.test(text);
  if (!hasNmap && !openPortIntent) return false;
  const explicitRun =
    openPortIntent ||
    /^(?:sudo\s+)?nmap(?:\s|$)/i.test(text) ||
    /\b(?:run|execute|start|perform)\b[\s\S]{0,40}\bnmap\b/i.test(text) ||
    /\bnmap\b[\s\S]{0,20}\bscan\b/i.test(text) ||
    /\bscan\b[\s\S]{0,40}\bwith\s+nmap\b/i.test(text);
  if (!explicitRun) return false;
  if (
    /\b(?:pentest|pen[\s-]?test|penetration|security\s+(?:audit|assessment|test)|vapt|recon(?:naissance)?|enumerat\w*|attack\s+surface|vulnerabilit\w*|exploit\w*|bug\s*bounty|red\s*team|threat\s+model|web\s+assessment)\b/i.test(text)
  ) {
    return false;
  }
  if (
    /\b(?:and|then|also)\b[\s\S]{0,40}\b(?:whois|dns|dig|http|crawl|fuzz|nikto|nuclei|sqlmap|gobuster|ffuf)\b/i.test(text)
  ) {
    return false;
  }
  return true;
}

function wordCount(prompt: string): number {
  return prompt.trim().split(/\s+/).filter(Boolean).length;
}

function classifyCategory(prompt: string): TaskKind {
  if (PENTEST_RE.test(prompt)) {
    if (/\b(?:dns|whois|subdomain)\b/i.test(prompt)) return "dns";
    if (/\b(?:whois|registrar|owner)\b/i.test(prompt)) return "whois";
    if (/\b(?:dir|fuzz|gobuster|ffuf|content\s*discover)\b/i.test(prompt)) {
      return "web-enum";
    }
    if (/\b(?:recon|enumerat|osint|fingerprint)\b/i.test(prompt)) {
      return "pentest-recon";
    }
    return "pentest-recon";
  }
  if (/\b(?:whois)\b/i.test(prompt)) return "whois";
  if (/\b(?:dns|dig|nslookup|resolve)\b/i.test(prompt)) return "dns";
  if (NETWORK_RE.test(prompt) && /\b(?:discover|sweep|live\s*hosts?)\b/i.test(prompt)) {
    return "network-discovery";
  }
  if (/\b(?:pkg|package|brew\s+install|apt\s+install|install\s+\w+)\b/i.test(prompt)) {
    return "package";
  }
  if (BUILD_RE.test(prompt) || FIX_RE.test(prompt) || FS_RE.test(prompt)) {
    return "filesystem";
  }
  if (SHELL_RE.test(prompt)) return "shell";
  if (RESEARCH_RE.test(prompt) || prompt.trim().endsWith("?")) return "answer";
  return "other";
}

function estimateComplexity(
  prompt: string,
  category: TaskKind,
  words: number,
): TaskComplexity {
  if (PENTEST_RE.test(prompt)) return "complex";
  if (BUILD_RE.test(prompt) && APP_RE.test(prompt)) return "complex";
  if (
    /\b(?:multi-?file|across\s+files|refactor|migrate|end-?to-?end|full\s+stack)\b/i.test(
      prompt,
    )
  ) {
    return "complex";
  }
  if (FIX_RE.test(prompt)) {
    return words > 40 ? "complex" : "standard";
  }
  if (category === "answer" && words <= 20) return "simple";
  if (words <= 6 && !BUILD_RE.test(prompt) && !PENTEST_RE.test(prompt)) {
    return "simple";
  }
  if (words <= 28 && !BUILD_RE.test(prompt)) return "standard";
  return words > 40 || BUILD_RE.test(prompt) ? "complex" : "standard";
}

function shouldPlanFor(
  prompt: string,
  complexity: TaskComplexity,
  category: TaskKind,
): boolean {
  if (complexity === "simple") return false;
  if (category === "answer") return false;
  if (PENTEST_RE.test(prompt)) return true;
  if (BUILD_RE.test(prompt) && APP_RE.test(prompt)) return true;
  if (
    /\b(?:implement|refactor|migrate|multi-?step|several\s+files|end-?to-?end)\b/i.test(
      prompt,
    )
  ) {
    return true;
  }
  return complexity === "complex" && wordCount(prompt) > 25;
}

function inferLikelyTools(prompt: string, category: TaskKind): string[] {
  const tools = new Set<string>();
  if (category === "answer" || RESEARCH_RE.test(prompt)) {
    tools.add("web.search");
    tools.add("web.fetch");
  }
  if (category === "filesystem" || BUILD_RE.test(prompt) || FIX_RE.test(prompt)) {
    tools.add("fs.list");
    tools.add("fs.read");
    tools.add("fs.write");
    tools.add("fs.edit");
    tools.add("shell.exec");
  }
  if (BUILD_RE.test(prompt) && APP_RE.test(prompt)) {
    tools.add("plan.create");
    tools.add("task.update");
    tools.add("shell.start");
  }
  if (PENTEST_RE.test(prompt) || category.startsWith("pentest") || category === "web-enum") {
    tools.add("dns.lookup");
    tools.add("whois.lookup");
    tools.add("http.fetch");
    tools.add("net.scan");
    tools.add("tool.check");
    tools.add("plan.create");
  }
  if (category === "network-discovery") {
    tools.add("net.context");
    tools.add("net.pingSweep");
    tools.add("net.scan");
  }
  if (category === "dns") tools.add("dns.lookup");
  if (category === "whois") tools.add("whois.lookup");
  if (category === "package") tools.add("pkg.install");
  if (SHELL_RE.test(prompt)) tools.add("shell.exec");
  if (/\b(?:pdf)\b/i.test(prompt)) tools.add("pdf.read");
  if (/\b(?:ocr|image|screenshot)\b/i.test(prompt)) tools.add("image.ocr");
  return [...tools];
}

function softSteps(prompt: string, category: TaskKind): PlanStep[] {
  if (PENTEST_RE.test(prompt)) {
    return [
      createPlanStep("Recon and fingerprint stack", "pentest-recon", {
        toolHint: "dns.lookup / http.fetch / net.scan",
        successCriteria: "real findings from tool output",
      }),
      createPlanStep("Plan from findings", "other", {
        toolHint: "plan.create",
        successCriteria: "durable plan with verifiable tasks",
      }),
      createPlanStep("Test high-value vectors", "web-enum", {
        successCriteria: "validated evidence or clean negatives",
      }),
      createPlanStep("Report with evidence", "other", {
        successCriteria: "findings with repro + severity",
      }),
    ];
  }
  if (BUILD_RE.test(prompt) && APP_RE.test(prompt)) {
    return [
      createPlanStep("Explore destination and stack", "filesystem", {
        toolHint: "fs.list / fs.read",
      }),
      createPlanStep("Plan multi-step build", "other", {
        toolHint: "plan.create",
      }),
      createPlanStep("Implement requested feature", "filesystem", {
        toolHint: "fs.write / fs.edit",
      }),
      createPlanStep("Verify (build and/or live server)", "shell", {
        toolHint: "shell.start / shell.exec",
      }),
    ];
  }
  if (FIX_RE.test(prompt)) {
    return [
      createPlanStep("Reproduce and capture error", "shell"),
      createPlanStep("Localize root cause", "filesystem", {
        toolHint: "fs.read / fs.search",
      }),
      createPlanStep("Apply minimal fix", "filesystem", {
        toolHint: "fs.edit",
      }),
      createPlanStep("Re-run failing check", "shell"),
    ];
  }
  if (category === "network-discovery") {
    return [
      createPlanStep("Local network context", "network-discovery", {
        toolHint: "net.context",
      }),
      createPlanStep("Discover live hosts", "network-discovery", {
        toolHint: "net.pingSweep",
      }),
      createPlanStep("Summarize findings", "other"),
    ];
  }
  return [];
}

function stopWhenFor(prompt: string, category: TaskKind): string {
  if (PENTEST_RE.test(prompt)) {
    return "Findings report with evidence; no local dev server; scope respected.";
  }
  if (BUILD_RE.test(prompt) && APP_RE.test(prompt)) {
    return "Requested feature works; verified via build and/or live localhost probe; server left running when applicable.";
  }
  if (FIX_RE.test(prompt)) {
    return "Original failing check now passes; root cause addressed.";
  }
  if (category === "answer") {
    return "Accurate answer grounded in tools when facts are volatile.";
  }
  return "User request completed with tool-backed evidence.";
}

/**
 * Lightweight task analysis for step budgets and soft guidance.
 * Does not execute or force a plan — the agent still owns decisions.
 */
export function analyzeTask(prompt: string): TaskAnalysis {
  const text = prompt.replace(/\s+/g, " ").trim();
  if (isNarrowExplicitNmapOperation(text)) {
    return {
      complexity: "standard",
      shouldPlan: false,
      category: "pentest-recon",
      goal: text.slice(0, 100),
      needsNetworkContext: false,
      needsToolPreflight: true,
      likelyTools: ["net.scan"],
      stopWhen:
        "The requested port scan has started or completed and its canonical job ID, status, and output are reported; do not broaden scope.",
      suggestedSteps: [],
    };
  }
  const words = wordCount(text);
  const category = classifyCategory(text);
  const complexity = estimateComplexity(text, category, words);
  const shouldPlan = shouldPlanFor(text, complexity, category);
  const likelyTools = inferLikelyTools(text, category);
  const suggestedSteps =
    complexity === "simple" || category === "answer" ? [] : softSteps(text, category);

  return {
    complexity,
    shouldPlan,
    category,
    goal: text.slice(0, 100),
    needsNetworkContext:
      category === "network-discovery" ||
      /\b(?:local\s*network|subnet|cidr|lan|my\s+network)\b/i.test(text),
    needsToolPreflight:
      PENTEST_RE.test(text) ||
      /\b(?:nmap|ffuf|gobuster|sqlmap|nuclei|hydra|nikto)\b/i.test(text),
    likelyTools,
    stopWhen: stopWhenFor(text, category),
    suggestedSteps,
  };
}

/** Compact one-liner for session/system context (optional inject). */
export function formatTaskAnalysisHint(analysis: TaskAnalysis): string {
  const tools =
    analysis.likelyTools.length > 0
      ? analysis.likelyTools.slice(0, 8).join(", ")
      : "—";
  const tracking = analysis.shouldPlan
    ? "durable task tracking may help; decide whether to use it or execute directly"
    : "direct execution ok";
  return (
    `TASK ANALYSIS: category=${analysis.category} complexity=${analysis.complexity} (${tracking}). ` +
    `Likely tools: ${tools}. Done when: ${analysis.stopWhen}`
  );
}
