# clai

> A fast, terminal-native AI agent that runs real tools — built to run on **free API tiers**, stay alive across rate limits with **multi-key + multi-provider switching**, and do serious work: **building, debugging, and scope-based pentesting / bug bounty**.

`clai` is an agentic CLI. It doesn't just describe what to do — it edits files, runs shell commands, scans hosts, fetches HTTP evidence, keeps a durable task plan, and verifies its own work before claiming success. It runs entirely in your terminal with a full-screen console UI (and a classic line REPL fallback).

Two things make it practical for everyday use:

- **It's cheap-to-free to run.** Point it at Groq, Google Gemini, NVIDIA NIM, OpenRouter, Bynara, Kimchi, or a local Ollama — all have free access — and clai stacks them. Add several keys per provider; when one hits a rate limit, it rotates to the next automatically.
- **It's honest.** Findings need real tool output. Builds get typechecked/run before "done." Compaction and history keep long sessions coherent instead of hallucinating progress.

---

## Highlights

- **Free-tier first.** 12 providers wired in, 6 cloud free tiers + local Ollama. Default provider is NVIDIA NIM (`openai/gpt-oss-20b`) so a fresh install can run at no cost.
- **Multi-key smart switching.** Up to 10 keys per provider with a *sticky* active key and circular rotation on rate-limit / auth / quota / transient / 5xx / empty-response errors. Optional cross-provider fallback and a free-only filter.
- **Scope-based pentesting.** Opt-in engagement scope with authorized/excluded targets, allowed phases, rate and concurrency ceilings, redirect and DNS-rebinding escape detection, and out-of-scope flagging — designed for authorized pentests and bug-bounty programs.
- **Real building & debugging.** Scaffolds apps, edits code surgically, installs packages, runs builds/tests, starts dev servers as background jobs, and probes them before reporting success.
- **Durable plans.** `plan.create` / `task.update` drive a live checklist that survives context compaction and reloads with `/history` — the agent works task-by-task and won't fake completion.
- **Native + text tool calling.** Uses provider-native function calling where available, with a text-fence fallback (`toolCalling: auto|native|text`).
- **Safety gate you control.** Every action is classified safe / confirm / block; deletes always confirm with a preview; destructive patterns are blocked.

---

## Install

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
# or
scoop bucket add clai https://github.com/pentoshi007/clai && scoop install clai
```

### npm / from source
```sh
npm i -g @pentoshi/clai
# or
git clone https://github.com/pentoshi007/clai.git
cd clai && npm install && npm run build && npm start
```

Node.js ≥ 20. Type `clai` in any terminal to start.

---

## Quick start

Get a free key from any supported provider, add it, and go:

```sh
# Add a free key (Groq shown; NVIDIA/Gemini/OpenRouter/Bynara/Kimchi work the same)
clai set groq gsk_your_key_here

# Launch the full-screen agent console
clai

# Or one-shot from the shell
clai "explain what this repo does and find the entrypoint"
clai --mode agent "add a /health endpoint to the Express app and run the tests"
```

Prefer fully local and offline? Point at Ollama:

```sh
clai set ollama --url http://localhost:11434
clai use ollama
```

---

## Run it on free tiers (and keep it running)

This is the core of clai's design: assemble capacity from free tiers, then survive rate limits automatically.

### Supported providers

| Provider | Default model | Tier | Env var |
|----------|---------------|------|---------|
| NVIDIA NIM | `openai/gpt-oss-20b` | Free | `NVIDIA_API_KEY` |
| Groq | `llama-3.3-70b-versatile` | Free | `GROQ_API_KEY` |
| Google Gemini | `gemini-3.5-flash` | Free | `GEMINI_API_KEY` |
| OpenRouter | `meta-llama/llama-3.3-70b-instruct:free` | Free | `OPENROUTER_API_KEY` |
| Bynara | `mimo-v2.5-free` | Free | `BYNARA_API_KEY` |
| Kimchi | `kimi-k2.6` | Free | `CASTAI_API_KEY` |
| Ollama | `llama3.1:8b` | Local / free | `OLLAMA_HOST` |
| OpenAI | `gpt-5.4-mini` | Paid | `OPENAI_API_KEY` |
| Anthropic | `claude-3-5-haiku-latest` | Paid | `ANTHROPIC_API_KEY` |
| AgentRouter | `claude-opus-4-6` | Paid | `AGENTROUTER_API_KEY` |
| AWS Mantle | `anthropic.claude-haiku-4-5` | Paid | `ANTHROPIC_API_KEY` |
| Qwen Cloud | `qwen3.7-plus` | Paid (DashScope) | `DASHSCOPE_API_KEY` |

Several "paid" providers also expose limited free allowances — the tier label reflects what the default keys usually buy you. Flip `freeOnly` off to include paid providers in fallback.

### Manage keys

```sh
clai set groq gsk_first_key            # store a key (appends if one exists)
clai set groq gsk_second_key           # add another key for the same provider
clai set gemini --from-env GEMINI_API_KEY
echo "gsk_..." | clai set groq --stdin
clai set ollama --url http://localhost:11434
clai keys                              # list providers + masked keys, active key marked ★
clai use groq                          # set active provider
clai provider                          # interactive provider/model picker
clai unset groq                        # remove ALL keys for a provider
```

In the console, **`/set`** opens a multi-row key editor: add rows with `+`, remove rows, **Save**, or **Reset all**. **`/keys`** lists them masked; **`/unset`** clears a provider.

### Smart switching (how it stays up)

- **Multi-key rotation** — up to **10 keys per provider**. The last key that worked is *sticky*; on failure clai rotates circularly to the next key.
- **What triggers a switch** — HTTP 429 (rate limit), 401/403 (auth), 402 / quota / billing text, transient network errors, 500–504, and empty completions. Auth and quota errors switch **immediately** (no backoff wait); rate limits back off briefly first.
- **Cross-provider fallback** *(opt-in)* — `/fallback on` lets clai try other configured providers after the active one is exhausted (only when running a provider's default model).
- **Free-only mode** *(opt-in)* — `/freeonly on` excludes paid-cloud providers from the fallback chain, so you never accidentally spend.
- **Quiet status** — a single non-stacking status line shows what happened, e.g. `switching groq key [2/4] …ab12 (rate limited)`. Keys are always masked to the last 4 chars.

```sh
/freeonly on      # stay on free tiers only
/fallback on      # allow other providers when the current one is exhausted
```

---

## What clai is good at

### Building & debugging

The same agent that runs recon also ships code. It explores before it writes, matches your existing stack from lockfiles, edits surgically, and proves the result:

- Scaffolds and extends apps; replaces starter boilerplate with real features (a scaffold alone is treated as incomplete).
- Surgical file tools: `fs.edit`, `fs.replaceLines`, `fs.append`, plus multi-file writes.
- Runs the checks that apply — typecheck, build, unit/integration tests — and fixes failures before claiming success.
- Starts dev servers as background jobs, tails until ready, probes `localhost`, and reports the URL / port / job id with the server left running.
- Debugging loop: reproduce → read the actual error → fix root cause → re-verify (never "diagnosed but not fixed").

```sh
clai --mode agent "convert this Vite React app to Next.js App Router, keep all features, run the build"
clai --mode agent "this test is flaky — find the race and fix it"
```

### Scope-based pentesting & bug bounty

clai is built to run real, authorized security work — not to narrate it. It follows a recon-first methodology and keeps you inside the boundaries you set.

```
recon / discovery  →  fingerprint stack  →  plan.create (kind=pentest)
        ↑                      │
        │              /implement (approve)
        │                      ↓
        └──── enumerate → exploit → post-ex → report
              (revise the plan as surface grows; keep completed tasks)
```

1. **Authorize once**, then optionally **define scope** — authorized targets, exclusions, allowed phases, rate/concurrency ceilings, and an expiry.
2. **Recon first** (read-only discovery needs no plan): whois, DNS, `net.scan`, `net.context`, `http.fetch`, `pentest.recon`, and shell tools like `nmap`, `ffuf`, `nuclei`, `sqlmap`.
3. **Analyze real evidence**, then `plan.create` with `kind=pentest` from actual ports/services/endpoints — then stop for your approval.
4. `/implement` and execute task-by-task; expand the plan as new attack surface appears without wiping completed work.
5. **Report** with structure — title, severity, evidence, reproduction, impact, remediation — and honest residual/untested notes.

**Scope enforcement is real, not cosmetic.** When scope is active, clai checks each target against your authorized/excluded lists, enforces token-bucket rate limits and a concurrency ceiling, detects **redirects that leave scope** and **DNS-rebinding escapes**, and flags out-of-scope hosts instead of touching them. Loopback GET/HEAD stays allowed for local dev verification. Scope is opt-in: with no scope defined, scoping is simply off.

```sh
clai authorize-pentest AGREE
clai scope new --targets lab.example.com,10.10.0.0/24 --exclude prod.example.com \
  --phases recon,enumeration --max-rate 5 --max-concurrency 2
# in the console: /scope show · /scope add <targets> · /scope clear
```

Dedicated recon tools: `pentest.recon` (bundled whois/dns/nmap), `pentest.webDiscover` (scoped path discovery), `pentest.apiEnumerate` (OpenAPI/Swagger), `pentest.authCompare` (auth-context diffing), `pentest.scanStatus` (durable scan checkpoints).

### General security & sysadmin workflows

Log triage, config hardening, packaging, network questions, OCR of a screenshot or PDF report, quick OSINT — all handled by the same agent under the same safety gate.

---

## Modes & reasoning

Three modes, switchable anytime with a slash command, `Shift+Tab`, or `clai --mode`:

| Mode | Use |
|------|-----|
| **ask** | Answers, methodology, and read-only tools — no mutations, no attacks. |
| **agent** | Executes: edits, installs, scans, verifies, works the plan. |
| **plan** | Research and design a durable plan; approve with `/implement` before execution. |

**Reasoning / thinking** is controlled with `/variants` (alias `/reasoning`), accepting `on`, `off`, `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`. clai only sends reasoning options to models that support them — and if a model rejects them at runtime, it marks that model, retries once without them, and tells you (`… rejected reasoning options — retrying without them`) so a session never hangs on an unsupported knob.

---

## Safety gate

You own authorization; clai still gates risk on every action:

| Level | Behavior |
|-------|----------|
| **safe** | Auto-runs read-only work: `fs.read/list/search`, `sysinfo`, `dns.lookup`, `whois.lookup`, `http.fetch` GET, `web.search`/`web.fetch`, recon scanners. |
| **confirm** | Asks first for mutations: file writes/edits, installs, moves, aggressive/mutating shell. |
| **block** | Refuses destructive patterns (`rm -rf /`, fork bombs, classic exfil signatures) and SSRF-prone fetches. |

`fs.delete` always confirms (with an optional `v` preview) even under allow-all. `tool.batch` inherits the highest risk level of its children. Use `/permissions` to choose the default confirmation level and `/allow` / `/disallow` for a per-session tool allow-list.

---

## Terminal UI

A full-screen console by default: streaming chat, nested tool cards (including `tool.batch` sub-calls), file diffs, a live plan pane, pickers, history, and secure masked key prompts. It falls back to a classic REPL when the terminal can't host the UI.

| Action | Key |
|--------|-----|
| Send / newline | `Enter` / `Shift+Enter` |
| Abort turn (keeps results) | `Esc` |
| Interrupt / quit | `Ctrl+C` (twice to quit) |
| Cycle mode (ask→agent→plan) | `Shift+Tab` |
| Plan pane / plan detail | `Ctrl+H` / `Ctrl+P` |
| Background jobs | `Ctrl+J` |
| Expand thinking / tool output | `Ctrl+T` / `Ctrl+O` |
| Search transcript | `Ctrl+R` |
| Copy selection | `Ctrl+Shift+C` |
| Commands / file mentions | `/` · `@` |
| Help / shortcuts | `Ctrl+G` |

Tool cards show the command/input clearly and keep long scan tails in an expandable OUTPUT pager (search, copy, export). File writes show a diff preview. Compaction cards preserve session memory without dropping the plan, and `/history` restores full sessions — prompts, tool results, and the matching plan — even after an abort or autosave.

---

## Slash commands

| Command | Does |
|---------|------|
| `/ask` · `/agent` · `/plan` | Switch mode (plan = design-then-approve) |
| `/implement` · `/discard` | Approve+execute or drop the current plan |
| `/model [name\|#]` · `/provider [name]` · `/use <provider>` | Pick model / switch provider |
| `/set [provider]` · `/unset [provider]` · `/keys` · `/info [provider]` | Manage API keys and view provider info |
| `/variants [level]` · `/reasoning [level]` | Thinking / reasoning effort |
| `/freeonly [on\|off]` · `/fallback [on\|off]` | Free-only filter · cross-provider fallback |
| `/search [provider]` · `/search-provider` | Choose web-search backend |
| `/scope [show\|add\|new\|clear]` | Engagement scope |
| `/output [last\|id\|list]` | Open full tool output (also `Ctrl+O`) |
| `/jobs` | Background jobs (also `Ctrl+J`) |
| `/compact` · `/context` | Compact history now · show context size |
| `/history` · `/save <name>` · `/new` · `/clear` · `/reset` | Session lifecycle |
| `/allow <tool>` · `/disallow <tool>` · `/permissions` | Tool permissions |
| `/cwd <path>` | Change working directory |
| `/think` · `/thinking` | Show thinking from the last response |
| `/privacy [...]` | Private mode · clear history/logs/artifacts |
| `/update` · `/help` · `/shortcuts` · `/clean` · `/exit` | Housekeeping |

---

## CLI commands

```sh
clai [prompt...]                       # interactive console, or one-shot with a prompt
  --mode <ask|agent|plan>  --provider <p>  --model <m>
  -y/--yes  --no-history  --classic  --ui <legacy|tui|v2>

clai set <provider> [key]              # --from-env <VAR> | --stdin | --url <url> | --skip-ping
clai unset <provider>                  # remove all keys for a provider
clai keys                              # list providers with masked keys
clai use <provider>                    # set active provider
clai provider [provider]               # switch provider or open picker
clai model <model>                     # set model for the active provider
clai mode <ask|agent|plan>             # set default mode
clai search-provider <brave|tavily|duckduckgo>
clai config [key] [value]              # print / get / set config
clai doctor                            # check installed tools + provider config
clai history [--show <id>]             # list sessions / print one
clai update                            # check for updates
clai authorize-pentest AGREE           # enable scan/attack tools (one-time ack)
clai scope <show|new|add|clear>        # engagement scope (new: --targets --exclude --phases
                                       #   --name --note --expires --max-rate --max-concurrency)
clai privacy <status|on|off|retention|clear-history|clear-logs|clear-artifacts|clear-all>
```

---

## Built-in tools

| Group | Tools |
|-------|-------|
| **Files** | `fs.read` · `fs.list` · `fs.search` · `fs.write` · `fs.writeMany` · `fs.edit` · `fs.replaceLines` · `fs.append` · `fs.delete` |
| **Shell & jobs** | `shell.exec` · `shell.start` · `shell.jobs` · `shell.tail` · `shell.stop` · `pkg.install` |
| **Network** | `net.scan` (nmap) · `net.context` · `net.pingSweep` · `dns.lookup` · `whois.lookup` |
| **HTTP / web** | `http.fetch` (raw evidence) · `web.search` · `web.fetch` (readable) |
| **Pentest** | `pentest.recon` · `pentest.webDiscover` · `pentest.apiEnumerate` · `pentest.authCompare` · `pentest.scanStatus` |
| **Orchestration** | `tool.batch` (up to 20 calls, `on_fail` policies) · `tool.check` · `wordlist.find` |
| **Plan** | `plan.create` · `task.update` · `agent.handoff` |
| **Context** | `sysinfo` · `image.ocr` · `pdf.read` |

### tool.batch fail policy

Default is **continue** — one failed lookup never kills the rest (ideal for recon). Opt into fail-fast or selective cancellation when later work depends on earlier success:

```json
{"name":"tool.batch","args":{
  "on_fail":"cancel_pending",
  "calls":[
    {"name":"net.scan","args":{"target":"lab.example"}},
    {"name":"http.fetch","args":{"url":"https://lab.example/"}}
  ]
}}
```

Top-level messages with several separate tool blocks never cancel siblings — use `tool.batch` when you need a fail policy.

---

## Web search / OSINT

| Provider | Key | Env var |
|----------|-----|---------|
| DuckDuckGo | none (default) | — |
| Brave | required | `BRAVE_SEARCH_API_KEY` |
| Tavily | required | `TAVILY_API_KEY` |

```sh
clai set brave bsx-...
clai set tavily tvly-...
clai search-provider tavily
```

Search-provider keys are multi-key and rotate just like model providers.

---

## Per-project context

Drop a `.clai/context.md` in a repo and its contents are injected every turn — lab topology, in-scope hosts, stack assumptions, coding conventions, or anything the agent should always know for that project.

---

## Configuration & privacy

```sh
clai config                # view config
clai mode agent            # default mode
clai model <name>          # default model for the active provider
/privacy on                # private mode: don't persist this session
/privacy clear-all         # wipe history, logs, and artifacts
```

Config lives under your OS user config dir (e.g. `~/.config/clai/`). Keys are stored locally and shown only masked.

---

## Development

```sh
npm install
npm run dev          # run from source
npm run typecheck
npm run build
npm test             # full vitest suite
npm run compile      # native binaries (Bun)
```

---

## Releasing

Tag-driven CI (`.github/workflows/release.yml`): validate (typecheck + tests + prompt-budget + release checks) → multi-platform binaries → GitHub Release → npm `@pentoshi/clai` → Homebrew tap.

```sh
# package.json "version" is the single source of truth.
npm version 3.8.0 --no-git-tag-version
npm run sync-version    # refreshes version.generated.ts + install manifests + lockfile
git commit -am "v3.8.0" && git push origin main
git tag -a v3.8.0 -m "clai v3.8.0" && git push origin v3.8.0
```

Secrets: `NPM_TOKEN`, `TAP_GITHUB_TOKEN`. Optional: `NPM_PROVENANCE=true`.

---

## Architecture

```
clai/
├─ src/
│  ├─ index.ts          # CLI entry + subcommands
│  ├─ agent/            # loop, plans, compaction, resume orientation, tool parsing
│  ├─ llm/              # 12 providers, streaming, native tools, key rotation + fallback
│  ├─ tools/            # fs, shell, net, http, web, pentest, batch, plan
│  ├─ safety/           # risk classifier + engagement (scope) policy
│  ├─ store/            # config, history, keys, plans, scope
│  ├─ tui-v2/           # full-screen OpenTUI console (primary)
│  ├─ app/              # session controllers, commands, events
│  └─ prompts/          # agent methodology (embedded for the compiled binary)
├─ install/ · manifests/
└─ package.json
```

---

## License

MIT.

**Use only on systems you are authorized to test.** clai is an operator's tool: authorization, scope, and impact are yours. The agent executes with the gates and confirmations you configure — nothing more.
