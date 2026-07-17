# clai

> **Offensive-security agent in your terminal** — recon, enumerate, exploit, and report with an approve-before-run plan workflow. Also a strong coding/sysadmin agent for shell and files. Free to build, free to run.

clai is an AI **agent CLI** built for people who break (and fix) systems: authorized pentests, red-team style workflows, CTFs, report verification, and day-to-day security engineering. It runs real tools (`nmap`, `ffuf`, `sqlmap`, `http` evidence capture, …), keeps a **durable engagement plan**, and never pretends a finding is real without tool output to back it up. Providers that support it use **native function/tool calling** (config `toolCalling: auto|native|text`); text-fence tools remain as fallback.

It also builds software and runs shell/file workflows when that is the job — same agent, same safety gate, same UI.

---

## Why clai for pentesting?

| Pain | What clai does |
|------|----------------|
| Chatbots that only *describe* scans | **Runs** recon, fuzzers, and PoCs via shell + dedicated tools |
| Long engagements lose the thread | **Session plan** + task checklist survives compaction and reloads from history |
| Spray-and-pray tooling | **Stack fingerprint first**, then stack-matched wordlists and vectors |
| Noisy full dumps fill context | **High-signal tool use**, artifacts for long output, expandable cards |
| Unscoped scanning | **Authorize once**, optional **engagement scope**, confirm on mutating work |
| “AI said vulnerable” without evidence | Findings require **command + real output**; report-style structure encouraged |

### Engagement shape (built into the agent)

```
recon / discovery  →  fingerprint stack  →  plan.create (kind=pentest)
        ↑                      │
        │              /implement  (approve)
        │                      ↓
        └──── enumerate → exploit → post-ex → report
              (revise plan as surface grows; keep completed tasks)
```

1. **Recon first** (whois, DNS, `net.context`, `net.scan`, `http.fetch`, `pentest.recon`, …) — read-only discovery does **not** need a plan yet.  
2. **Analyze evidence**, then **`plan.create`** with `kind=pentest` from real ports/services/endpoints/weaknesses — then **stop**.  
3. You **`/implement`**, refine in chat, or **`/discard`**.  
4. Execute task-by-task with **`task.update`**; expand the plan when new surface appears without wiping done work.

Non-destructive by default: prove issues with the least invasive evidence (reflected values, auth bypass PoCs, `whoami` after a shell). Destructive impact only when you explicitly ask.

---

## Installation

### macOS

```sh
brew tap pentoshi007/clai && brew install clai
# or
curl -fsSL https://raw.githubusercontent.com/pentoshi007/clai/main/install/install.sh | sh
```

### Linux

```sh
curl -fsSL https://raw.githubusercontent.com/pentoshi007/clai/main/install/install.sh | sh
```

### Windows

```powershell
irm https://raw.githubusercontent.com/pentoshi007/clai/main/install/install.ps1 | iex
# or: scoop bucket add clai https://github.com/pentoshi007/clai && scoop install clai
```

### npm / from source

```sh
npm i -g @pentoshi/clai

# or
git clone https://github.com/pentoshi007/clai.git
cd clai && npm install && npm run build && npm start
```

Type `clai` in any terminal to start.

---

## Quick start (security)

```sh
# Full-screen agent UI
clai

# Authorize offensive tools for this machine (once)
clai authorize-pentest AGREE

# Optional: remember engagement boundaries
clai scope add --targets lab.example.com,10.10.0.0/24

# One-shot agent against an in-scope target
clai --mode agent "recon lab.example.com — open ports, stack, and interesting endpoints"

# Ask mode: methodology / commands only, no execution
clai --mode ask "how would you enum an internal AD lab from a foothold?"
```

Inside a session:

```text
> recon app.lab.local and map the attack surface
  … agent runs whois/dns/nmap/http evidence …
  … plan.create (pentest checklist) …
> /implement
  … tasks execute with live plan pane (Ctrl+H) …
> verify the IDOR on /api/v1/orders/{id} with a low-impact PoC
```

---

## Security & pentest capabilities

### Tools that matter for engagements

| Area | What you get |
|------|----------------|
| **Network** | `net.scan` (nmap wrapper, SYN with privilege / TCP fallback), `net.context`, `net.pingSweep`, `pentest.recon` (whois + dig + top ports) |
| **HTTP evidence** | `http.fetch` — status, headers, cookies, TLS, body for **raw protocol / pentest** work (not casual page reading) |
| **Web reading / OSINT** | `web.search`, `web.fetch` (readable pages), plus shell for specialized CLIs |
| **Batch recon** | `tool.batch` — up to 20 lookups in one call; optional `on_fail` fail-fast or selective cancel when dependents need a prerequisite |
| **Discovery** | `tool.check`, `pkg.install`, `wordlist.find` — install only what is missing; locate wordlists per OS (no Kali-only path guesses) |
| **DNS / ownership** | `dns.lookup`, `whois.lookup` for narrow questions |
| **Shell** | Full toolbox: `nmap`, `ffuf`, `gobuster`, `feroxbuster`, `sqlmap`, `hydra`, `nikto`, `masscan`, `nuclei`, `tshark`, … via `shell.exec` |
| **Jobs** | Long scanners/listeners as background jobs (`shell.start` / `/jobs` / `Ctrl+J`) |
| **Reporting** | Markdown tables, artifact paths for long scans, structured finding style (title, severity, evidence, repro, impact, remediations) |

### Methodology the agent is steered toward

- **Recon → fingerprint → enumerate → exploit → post-ex → report**  
- **Tech stack from real headers/body** before directory fuzz or exploit choice (Next.js ≠ PHP wordlists)  
- **Fuzz, don’t guess** — one bounded content-discovery pass with filters, not dozens of blind `http.fetch` paths  
- **Enumerate before exploit**; match vectors to the stack  
- **Verify from tool output** — no fabricated banners or fake CVE hits  
- **Scope discipline** — flag out-of-scope hosts; keep authorized targets as the boundary  

### Authorization & safety gate

clai assumes **you** own authorization. The product still gates risk:

```sh
clai authorize-pentest AGREE          # session-level ack before scan/attack tools
clai scope add --targets a.com,10.0.0.0/24
# in UI: /scope add a.com · /scope show · /scope clear
```

| Risk | Behavior |
|------|----------|
| **safe** | Auto-run read-only recon patterns, `http.fetch` GET evidence, many enum CLIs |
| **confirm** | Mutating shell, writes, installs, aggressive scans |
| **block** | Destructive patterns (`rm -rf /`, fork bombs, classic exfil signatures, …) |

Default posture is **non-destructive proof**. Escalate impact only when you ask for it.

### Plan pane for engagements

- Live checklist while you work (`Ctrl+H`)  
- Full plan + notes pager (`Ctrl+P` / `/plan`)  
- Approve with `/implement`, revise in chat, cancel with `/discard`  
- Plans **survive context compaction** and **reload with `/history`**  
- Agent mode: working checklist + evidence-before-done; plan mode: roadmap you approve before execution  

---

## Terminal UI (operator console)

Full-screen OpenTUI console by default: streaming chat, nested tool cards (including `tool.batch` sub-sections), file diffs, plan pane, pickers, history, secure key prompts. Falls back to a classic line REPL if the terminal cannot host the UI.

| Action | How |
|--------|-----|
| Send | `Enter` |
| Newline | `Shift+Enter` |
| Abort turn | `Esc` / `Ctrl+C` (cancels in-flight tools cleanly) |
| Expand thinking | `Ctrl+T` (clickable on status strip) |
| Expand tool / compacted output | `Ctrl+O` |
| Plan pane | `Ctrl+H` |
| Full plan document | `Ctrl+P` |
| Background jobs | `Ctrl+J` |
| Commands / files | `/` · `@` |
| Exit | `Ctrl+C` twice |

Tool cards show **command/input** clearly and keep long scan tails in **OUTPUT** (expand or open pager). File writes show a **diff preview**. Deletes always ask for confirmation (`y`/`n`); press **`v`** to preview the path before confirming. Compaction cards preserve engagement memory without dropping the plan.

**`/history`** restores full sessions — prompts, tool results, findings context, and the matching plan when present (including after abort / autosave).

---

## Modes

| Mode | Security use |
|------|----------------|
| **`/agent`** | Run recon, build a pentest plan, execute after `/implement`, verify findings with tools |
| **`/ask`** | Methodology, commands, and writeups **without** executing tools |

Switch anytime: `/agent`, `/ask`, or `clai --mode agent|ask "…"`.

Coding and general sysadmin work use the same agent (scaffold, debug, packages) with the same plan gate for multi-step jobs.

---

## Features (summary)

- **Pentest-first agent loop** — recon-before-plan, stack-aware enum, evidence-backed findings  
- **Durable plans** — `plan.create` / `task.update`, side pane, approve/refine/discard; agent vs plan task workflows  
- **Parallel multi-tool turns** — independent reads run together; failures do **not** cancel siblings by default  
- **`tool.batch` fail policy** — opt-in `on_fail=cancel_pending` or selective `cancel_on_fail` / rules when later work depends on earlier success  
- **Native + text tool calling** — `toolCalling: auto|native|text`  
- **11+ LLM providers** with streaming (free tiers + local Ollama)  
- **Safety gate** + pentest authorization + optional engagement scope (deletes always confirm with preview)  
- **OS-aware** installs and wordlist discovery (macOS / Linux / Windows)  
- **Context compaction** (auto + `/compact`) that keeps the plan alive  
- **Session history** with full transcript + plan restore  
- **Background jobs** for long scanners and listeners  
- **Web OSINT** — `web.search` / `web.fetch` alongside raw `http.fetch`  
- **Stall / cancel robustness** — tool heartbeats, hard deadlines, clean Esc abort with results recorded  

---

## Provider setup

| Provider | Default model | Free tier | Key prefix |
|----------|---------------|-----------|------------|
| Groq | `llama-3.3-70b-versatile` | ✓ | `gsk_` |
| Gemini | `gemini-2.0-flash` | ✓ | `AIza` |
| OpenRouter | `meta-llama/llama-3.3-70b-instruct:free` | ✓ | `sk-or-` |
| OpenAI | `gpt-4o-mini` | — | `sk-` |
| Anthropic | `claude-3-5-haiku-latest` | — | `sk-ant-` |
| NVIDIA NIM | `openai/gpt-oss-20b` | ✓ | `nvapi-` |
| AgentRouter | `gpt-5` | — | `sk-` |
| Kimchi | `kimi-k2.6` | ✓ | (any) |
| AWS Mantle | `anthropic.claude-haiku-4-5` | — | `sk-ant-` |
| Ollama | `llama3.1:8b` | ✓ local | URL |
| Bynara | `mimo-v2.5-free` | ✓ | `sk_nry_` |

```sh
clai set groq gsk_...
clai set gemini --from-env GEMINI_API_KEY
echo "gsk_..." | clai set groq --stdin
clai set ollama --url http://localhost:11434
clai keys
clai use groq
clai provider          # picker shows selected model per provider
clai unset groq
```

Env overrides: `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `NVIDIA_API_KEY`, `OLLAMA_HOST`, …

---

## Commands operators use most

| Command | For security work |
|---------|-------------------|
| `/agent` | Offensive / execution mode |
| `/ask` | Research & methodology only |
| `/implement` · `/discard` · `/plan` | Plan lifecycle |
| `/scope` | Engagement targets |
| `/output` · `Ctrl+O` | Full tool / scan tails |
| `/jobs` · `Ctrl+J` | Long-running tools |
| `/compact` · `/context` | Keep long engagements inside the window |
| `/history` | Resume yesterday’s engagement |
| `/allow` | Session tool allow-list |
| `/cwd` | Switch lab / loot directory |
| `/model` · `/provider` | Capacity for the job |
| `/update` · `/help` · `/exit` | Housekeeping |

CLI mirrors: `clai authorize-pentest`, `clai scope add`, `clai doctor` (missing tools + install hints), `clai update`.

---

## Built-in tools (agent)

| Tool | Role in engagements |
|------|---------------------|
| `shell.exec` / `shell.start` · `shell.jobs` / `tail` / `stop` | nmap, ffuf, sqlmap, hydra, custom PoCs, listeners, background jobs |
| `net.scan` · `net.context` · `net.pingSweep` · `pentest.recon` | Host/port/service discovery |
| `http.fetch` | Raw HTTP/TLS evidence |
| `web.search` · `web.fetch` | OSINT / docs (readable), not raw exploit traffic |
| `dns.lookup` · `whois.lookup` | Narrow DNS / ownership |
| `tool.batch` | Fan-out up to 20 tools; `concurrency` 1–6; `on_fail` continue (default) / cancel_pending / rules; per-call `cancel_on_fail` |
| `tool.check` · `pkg.install` · `wordlist.find` | Tooling readiness |
| `fs.read` · `fs.list` · `fs.search` · `fs.write` · `fs.writeMany` · `fs.edit` · `fs.replaceLines` · `fs.append` · `fs.delete` | Files (sandboxed roots; delete always confirms + optional preview) |
| `plan.create` · `task.update` | Engagement checklist / working tasks |
| `sysinfo` · `image.ocr` · `pdf.read` | Host context, report/screenshot OCR |
| `agent.handoff` | Ask mode → offer agent mode when the user wants action, not explanation |

### `tool.batch` fail policy (opt-in)

Default is **continue** — one failed lookup never kills the rest (best for recon).

```json
// Fail-fast: stop remaining calls after the first failure
{"name":"tool.batch","args":{
  "on_fail":"cancel_pending",
  "calls":[
    {"name":"net.scan","args":{"target":"lab.example"}},
    {"name":"http.fetch","args":{"url":"https://lab.example/"}}
  ]
}}

// Selective: if scan fails, cancel only fuzz (dns still runs)
{"name":"tool.batch","args":{
  "calls":[
    {"id":"dns","name":"dns.lookup","args":{"target":"lab.example"}},
    {"id":"scan","name":"net.scan","args":{"target":"lab.example"},
     "cancel_on_fail":["fuzz"]},
    {"id":"fuzz","name":"shell.exec","args":{"command":"ffuf …"}}
  ]
}}
```

Top-level multi-tool messages (several separate tool blocks) never cancel siblings; use `tool.batch` when you need a fail policy.

### Search providers (OSINT)

```sh
clai set brave bsx-...
clai set tavily tvly-...
clai search-provider tavily
```

DuckDuckGo is default and keyless. Env: `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`.

---

## Updates & doctor

```sh
clai update
clai doctor    # OS, keys, and which security tools are installed
```

---

## Per-project context

`.clai/context.md` in a repo injects durable notes (e.g. lab topology, in-scope hosts, stack assumptions) every turn.

---

## Configuration

```sh
clai config
clai mode agent
clai model <name>
```

Config lives under the OS user config dir (e.g. `~/.config/clai/`).

---

## Development

```sh
npm install
npm run dev
npm run typecheck
npm run build
npm test
npm run compile    # native binaries (Bun)
```

Node.js ≥ 20.

---

## Releasing

Tag-driven CI (`.github/workflows/release.yml`): tests → multi-platform binaries → GitHub Release → npm `@pentoshi/clai` → Homebrew tap.

```sh
npm version 3.7.6 --no-git-tag-version
# bump FALLBACK_VERSION / manifests as needed
git commit -am "v3.7.6" && git push origin main
git tag -a v3.7.6 -m "clai v3.7.6" && git push origin v3.7.6
```

Secrets: `NPM_TOKEN`, `TAP_GITHUB_TOKEN`. Optional: `NPM_PROVENANCE=true`.

---

## Architecture (overview)

```
clai/
├─ src/
│  ├─ index.ts              # CLI entry
│  ├─ modes/                # ask · agent
│  ├─ agent/                # loop, plans, compaction, tool parsing
│  ├─ llm/                  # providers + streaming + native tools
│  ├─ tools/                # shell, net, http, web, fs, batch, pentest, …
│  ├─ safety/               # classifier + patterns
│  ├─ store/                # config, history, keys, plans, scope, logs
│  ├─ tui-v2/               # full-screen OpenTUI (primary)
│  ├─ app/                  # session, commands, events
│  └─ prompts/              # agent methodology (incl. pentest; embedded for bun)
├─ bin/clai.mjs
├─ install/ · manifests/
└─ package.json
```

---

## License

MIT

---

**Use only on systems you are authorized to test.** clai is an operator tool: authorization, scope, and impact are yours; the agent executes with the gates and confirmations you configure.
