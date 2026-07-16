import type { ToolDefinition } from "../types.js";
import {
  registerWireNamesFor,
  toSnakeWireName,
  toWireName,
} from "../llm/tool-protocol.js";

function def(
  name: string,
  description: string,
  parameters: ToolDefinition["parameters"],
  flags: Partial<Pick<ToolDefinition, "readOnly" | "mutates" | "askMode">> = {},
): ToolDefinition {
  // Primary wire keeps camelCase (fs_writeMany); also register snake alias.
  const wireName = registerWireNamesFor(name);
  return {
    name,
    wireName,
    description,
    parameters,
    ...flags,
  };
}

const emptyObject = {
  type: "object" as const,
  properties: {} as Record<string, unknown>,
  additionalProperties: false,
};

/** Plan tools dispatched specially in the runner (not in toolRegistry). */
export const PLAN_TOOL_NAMES = new Set(["plan.create", "task.update"]);

/** Meta tools with no registry handler (plan + ask-mode handoff). */
export const NON_REGISTRY_TOOL_NAMES = new Set([
  ...PLAN_TOOL_NAMES,
  "agent.handoff",
]);

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  def(
    "fs.read",
    "Read a file. Use for inspecting source, configs, or outputs. Prefer offset/limit for large files.",
    {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path (absolute, relative, or ~)",
        },
        offset: {
          type: "integer",
          description: "1-indexed start line for paging",
        },
        limit: { type: "integer", description: "Max lines to return" },
        maxBytes: { type: "integer", description: "Max bytes to read" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "fs.write",
    "Create or fully overwrite a file with complete content in one call. Prefer this over append for new files.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        content: {
          type: "string",
          description: "Full file contents in one call",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "fs.writeMany",
    "Write multiple complete files in one call (scaffold). Max 50 files.",
    {
      type: "object",
      properties: {
        files: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
      },
      required: ["files"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "fs.list",
    "List directory entries.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        maxEntries: { type: "integer" },
      },
      required: [],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "fs.search",
    "Search file contents by pattern (ripgrep-style).",
    {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "fs.edit",
    "Surgical in-place edit: replace exact oldText with newText.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
        expectedReplacements: { type: "integer" },
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "fs.replaceLines",
    "Replace a 1-indexed inclusive line range after reading the file. Empty content (or delete:true) deletes that range.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "integer" },
        endLine: { type: "integer" },
        content: {
          type: "string",
          description:
            "Replacement text. Empty string deletes the line range (no space hack).",
        },
        delete: {
          type: "boolean",
          description: "If true, delete the range (same as content:\"\")",
        },
      },
      required: ["path", "startLine", "endLine"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "fs.append",
    "Append (or prepend) content. Use after truncation notices with expectedPriorBytes.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        position: { type: "string", enum: ["start", "end"] },
        expectedPriorBytes: {
          type: "integer",
          description:
            "From prior write receipt; required after truncation salvage",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "fs.delete",
    "Delete a file or directory.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "shell.exec",
    "Run a shell command and wait for completion. Use shell.start for long-running servers.",
    {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeoutMs: { type: "integer" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "shell.start",
    "Start a long-running command in the background; returns a job id.",
    {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        name: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def("shell.jobs", "List background jobs.", emptyObject, { readOnly: true }),
  def(
    "shell.tail",
    "Read recent output from a background job.",
    {
      type: "object",
      properties: {
        id: { type: "string" },
        bytes: { type: "integer" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
  def(
    "shell.stop",
    "Stop a background job.",
    {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "pkg.install",
    "Install a package via the OS package manager if the binary is missing.",
    {
      type: "object",
      properties: {
        tool: { type: "string" },
        checkBinary: { type: "string" },
      },
      required: ["tool"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "net.scan",
    "Port/service scan a target with nmap (confirm required for live scans).",
    {
      type: "object",
      properties: {
        target: { type: "string" },
        ports: { type: "string" },
        profile: {
          type: "object",
          description: "Structured nmap profile",
        },
        flags: {
          type: "string",
          description: "Legacy flags string",
        },
        background: {
          type: "boolean",
          description: "Force durable execution; deep/full profiles are durable automatically",
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "net.context",
    "Local network context (interfaces, routes summary).",
    emptyObject,
    { readOnly: true, askMode: true },
  ),
  def(
    "net.pingSweep",
    "Discover live hosts on a subnet/CIDR.",
    {
      type: "object",
      properties: {
        target: { type: "string" },
        method: {
          type: "string",
          enum: ["auto", "nmap", "arp", "native"],
        },
        timeoutMs: { type: "integer" },
      },
      required: ["target"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
  def(
    "http.fetch",
    "HTTP request (GET/HEAD preferred). Confirm for mutating methods.",
    {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string" },
        body: { type: "string" },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        maxBytes: { type: "integer" },
        iOwnThis: { type: "boolean" },
        own: { type: "boolean" },
        retries: { type: "integer" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "dns.lookup",
    "DNS query for a single record type.",
    {
      type: "object",
      properties: {
        target: { type: "string" },
        record: {
          type: "string",
          description: "A, AAAA, MX, TXT, ...",
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "whois.lookup",
    "WHOIS lookup for domain or IP ownership.",
    {
      type: "object",
      properties: { target: { type: "string" } },
      required: ["target"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "pentest.recon",
    "Bundled whois/dns/nmap recon. Prefer discrete tools when only one step is needed. Default nmap is top-100; escalate with topPorts, ports, or full for thorough engagements.",
    {
      type: "object",
      properties: {
        target: { type: "string" },
        whois: { type: "boolean" },
        dns: { type: "boolean" },
        nmap: { type: "boolean" },
        topPorts: {
          type: "integer",
          description: "nmap --top-ports N (default 100)",
        },
        ports: {
          type: "string",
          description: "nmap -p spec, e.g. 1-1000 or 80,443,8080",
        },
        full: {
          type: "boolean",
          description: "If true, scan all TCP ports (-p-)",
        },
        background: {
          type: "boolean",
          description: "Force durable nmap execution; deep/full scans are durable automatically",
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "pentest.webDiscover",
    "Discover a scoped web surface with bounded concurrent requests to common and supplied paths.",
    {
      type: "object",
      properties: {
        baseUrl: { type: "string" },
        paths: { type: "array", maxItems: 100, items: { type: "string" } },
      },
      required: ["baseUrl"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
  def(
    "pentest.apiEnumerate",
    "Fetch and enumerate paths from an authorized OpenAPI/Swagger specification.",
    {
      type: "object",
      properties: { specUrl: { type: "string" } },
      required: ["specUrl"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
  def(
    "pentest.authCompare",
    "Compare the same authorized endpoint across named authentication contexts. Credentials are never echoed.",
    {
      type: "object",
      properties: {
        url: { type: "string" },
        contexts: {
          type: "array",
          minItems: 2,
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              headers: { type: "object", additionalProperties: { type: "string" } },
            },
            required: ["label", "headers"],
            additionalProperties: false,
          },
        },
      },
      required: ["url", "contexts"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
  def(
    "pentest.scanStatus",
    "Incrementally ingest a durable scan checkpoint by job id and byte offset.",
    {
      type: "object",
      properties: {
        id: { type: "string" },
        offset: { type: "integer" },
        bytes: { type: "integer" },
        stream: { type: "string", enum: ["stdout", "stderr", "combined"] },
        target: { type: "string" },
      },
      required: ["id", "target"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
  def(
    "web.search",
    "Search the web for current information. Use for volatile facts and research.",
    {
      type: "object",
      properties: {
        query: { type: "string" },
        maxResults: { type: "integer" },
        fetchTop: {
          type: "integer",
          description: "Fetch top N pages (0-3)",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "web.fetch",
    "Fetch a URL as readable text or metadata for research.",
    {
      type: "object",
      properties: {
        url: { type: "string" },
        maxBytes: { type: "integer" },
        includeHeaders: { type: "boolean" },
        includeTls: { type: "boolean" },
        includeTiming: { type: "boolean" },
        includeRedirectChain: { type: "boolean" },
        responseMode: {
          type: "string",
          enum: ["readable", "raw"],
          description:
            "Body formatting: readable (default) or raw. Headers/TLS are separate booleans.",
        },
        redactSensitive: { type: "boolean" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def("sysinfo", "OS/environment facts for this machine.", emptyObject, {
    readOnly: true,
    askMode: true,
  }),
  def(
    "tool.check",
    'Check whether binaries/tools are available on PATH (and versions). Pass tools as an array, e.g. {"tools":["nmap","ffuf"]}.',
    {
      type: "object",
      properties: {
        tools: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 20,
          description: 'Tool names, e.g. ["nmap","ffuf"]',
        },
      },
      required: ["tools"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "tool.batch",
    "Run multiple read-only tool calls concurrently (max 20).",
    {
      type: "object",
      properties: {
        calls: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              args: { type: "object" },
            },
            required: ["name", "args"],
          },
        },
      },
      required: ["calls"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "wordlist.find",
    "Locate wordlists on disk for fuzzing/directory scans.",
    {
      type: "object",
      properties: {
        query: { type: "string" },
        expand: { type: "boolean" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
  def(
    "image.ocr",
    "OCR text from an image file (fallback when vision is unavailable).",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        lang: { type: "string" },
        maxBytes: { type: "integer" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "pdf.read",
    "Extract text from a PDF (OCR fallback for scanned pages).",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        maxPages: { type: "integer" },
        maxBytes: { type: "integer" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "plan.create",
    "Create or revise a durable multi-step session plan with task checklist.",
    {
      type: "object",
      properties: {
        goal: { type: "string" },
        detail: { type: "string" },
        tasks: {
          type: "array",
          items: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  title: { type: "string" },
                  task: { type: "string" },
                  name: { type: "string" },
                },
              },
            ],
          },
        },
        kind: { type: "string" },
      },
      required: ["goal", "tasks"],
      additionalProperties: true,
    },
    { mutates: true },
  ),
  def(
    "task.update",
    "Update a plan task state. taskId MUST be t1, t2, … from the ACTIVE PLAN context (not a free-form title slug).",
    {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description:
            "Canonical id from plan context: t1, t2, t3, … (aliases accepted if listed)",
        },
        state: {
          type: "string",
          enum: ["pending", "in_progress", "done", "failed", "skipped"],
        },
        note: { type: "string" },
      },
      required: ["taskId", "state"],
      additionalProperties: true,
    },
    { mutates: true },
  ),
  def(
    "agent.handoff",
    "Hand a task that needs agent mode (writes, shell, installs) back to the user. Ask mode cannot execute mutations — use this instead of inventing write tools.",
    {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Exact task restatement for agent mode",
        },
        reason: {
          type: "string",
          description: "Short reason agent mode is required",
        },
      },
      required: ["task", "reason"],
      additionalProperties: false,
    },
  ),
];

const byName = new Map(TOOL_DEFINITIONS.map((d) => [d.name, d]));
const byWire = new Map<string, ToolDefinition>();
for (const d of TOOL_DEFINITIONS) {
  byWire.set(d.wireName, d);
  const snake = toSnakeWireName(d.name);
  if (snake !== d.wireName) byWire.set(snake, d);
}

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return byName.get(name) ?? byWire.get(name);
}

export function getToolDefinitions(filter?: {
  askMode?: boolean;
  names?: string[];
  compact?: boolean;
}): ToolDefinition[] {
  let defs = TOOL_DEFINITIONS;
  if (filter?.askMode) {
    defs = defs.filter((d) => d.askMode);
  }
  if (filter?.names) {
    const allow = new Set(filter.names);
    defs = defs.filter((d) => allow.has(d.name));
  }
  if (filter?.compact) {
    // Core set for low-TPM models + recon/network essentials (no net.scan
    // mutator — that still needs the full set / confirm UX).
    const core = new Set([
      "fs.read",
      "fs.write",
      "fs.writeMany",
      "fs.list",
      "fs.search",
      "fs.edit",
      "fs.append",
      "fs.delete",
      "shell.exec",
      "shell.start",
      "shell.jobs",
      "shell.tail",
      "shell.stop",
      "web.search",
      "web.fetch",
      "http.fetch",
      "dns.lookup",
      "whois.lookup",
      "net.context",
      "pentest.recon",
      "wordlist.find",
      "sysinfo",
      "tool.check",
      "plan.create",
      "task.update",
    ]);
    defs = defs.filter((d) => core.has(d.name));
  }
  return defs.map((d) => ({ ...d }));
}

export function getCompactToolDefinitions(): ToolDefinition[] {
  return getToolDefinitions({ compact: true });
}

export function wireNameFor(canonical: string): string {
  return byName.get(canonical)?.wireName ?? toWireName(canonical);
}

export function canonicalNameFor(wire: string): string | undefined {
  return byWire.get(wire)?.name;
}

/**
 * Every registry key must have a definition; every definition must have a
 * handler unless it is a plan meta-tool.
 */
export function assertDefinitionRegistryConsistency(
  registryKeys: string[],
): void {
  const reg = new Set(registryKeys);
  const defNames = new Set(TOOL_DEFINITIONS.map((d) => d.name));
  const wires = new Set<string>();

  for (const d of TOOL_DEFINITIONS) {
    if (wires.has(d.wireName)) {
      throw new Error(`Duplicate wire name: ${d.wireName}`);
    }
    wires.add(d.wireName);
    if (!NON_REGISTRY_TOOL_NAMES.has(d.name) && !reg.has(d.name)) {
      throw new Error(
        `Definition "${d.name}" has no toolRegistry handler (and is not a meta tool)`,
      );
    }
  }
  for (const key of registryKeys) {
    if (!defNames.has(key)) {
      throw new Error(`toolRegistry key "${key}" has no ToolDefinition`);
    }
  }
}
