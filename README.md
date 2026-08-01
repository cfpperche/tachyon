<div align="center">

# ⚡ Tachyon

### Local multi-agent development, powered by a persistent engine.

[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/cfpperche.tachyon?label=marketplace&color=f5c518)](https://marketplace.visualstudio.com/items?itemName=cfpperche.tachyon)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/cfpperche.tachyon?color=f5c518)](https://marketplace.visualstudio.com/items?itemName=cfpperche.tachyon)
[![CI](https://github.com/cfpperche/tachyon/actions/workflows/ci.yml/badge.svg)](https://github.com/cfpperche/tachyon/actions/workflows/ci.yml)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)

**[Install from the Marketplace](https://marketplace.visualstudio.com/items?itemName=cfpperche.tachyon)** · **[Website](https://cfpperche.github.io/tachyon/)**

</div>

Tachyon runs a fleet of coding agents on your machine and keeps them alive. A persistent engine owns
the agents, their sessions, their git worktrees and the MCP control plane; the VS Code extension is
the window onto it, not the thing itself. Agents run as tmux sessions and appear as native editor
terminals, so they survive an editor restart — and after a reboot Tachyon can bring each one back
with its conversation, through the runtime's own resume.

Agents can also reach the fleet through an embedded **MCP Bridge**: spawn sub-agents, read each
other's output, run curated commands, and ask for you when they need a human.

**100% local.** No cloud, no telemetry, no token proxying — on the subscriptions you already pay for.

> This README is deliberately short while the project moves fast. The deeper material lives in
> [`docs/`](docs) — [architecture](docs/architecture), [system design](docs/system-design.md), and
> the [spec history](docs/specs), where each feature landed with its own spec, plan and validation
> record.

## Works with the CLIs you already use

`Claude Code` · `Codex` · `OpenCode` · `Grok` · `Hermes Agent` · `Pi` · `Gemini` · `Copilot CLI` ·
`Aider` · **any CLI** — plus any dev server, watcher or build command.

## Requirements

| Platform | Supported |
|---|---|
| Linux | ✅ tmux ≥ 3.2 (**3.6 recommended** — instant exit-code capture for one-shot commands) |
| Windows + WSL | ✅ VS Code Remote - WSL, with tmux inside the distro |
| macOS | ❌ temporarily unsupported by the persistent engine |
| Windows native | ❌ by design — use WSL |

## Getting started

1. **Open a project** and run **Tachyon: Init**. It detects Node, Laravel, Rust, Go, Python and
   Rails, and writes a commented starter `tachyon.yml`.
2. **Set up your agents** in Agent Studio, or by editing the yml — your comments survive UI edits.
3. **Start the fleet.** Auto-start agents boot with the workspace and notify you when they need you.

Tachyon stays inert until you opt in: nothing boots merely from installing the extension or opening a
folder. On a fresh install the **Get Started** walkthrough opens on its own.

To see a working fleet before configuring your own, clone
[**tachyon-examples**](https://github.com/cfpperche/tachyon-examples) and open it.

## The tachyon.yml

One file at the workspace root declares what runs:

```yaml
agents:
  claude:
    profile: .tachyon/agents/claude/agent.yml   # canonical profile, edited in Agent Studio

terminals:
  dev:
    cmd: npm run dev
    autostart: true

settings:
  maxAgents: 8
```

An agent is a **canonical profile**: a durable identity with its own runtime, model, capabilities and
optional git worktree, whose authority is custodied by the host rather than by the file. Terminals,
commands and runbooks stay plain declarations.

## What it gives you

- **A persistent engine** — agents outlive the editor; a reboot restores them with their conversation.
- **The MCP Bridge** — every Tachyon-spawned agent gets a scoped, authenticated control plane for the
  fleet, with no manual wiring.
- **Worktree isolation** — an agent can own its branch and checkout, verify it, and open the PR from
  the sidebar.
- **Deliberate capabilities** — a plugin or skill reaches an agent only after a human authorizes it,
  pinned to the exact content approved. When that content changes the agent says so and offers to
  reauthorize, instead of drifting quietly.
- **Sub-agents** — agents that spawn agents, with the lineage visible in the sidebar.
- **Tasks, pins and a human inbox** — shared memory between you and the fleet, and one place where
  everything waiting on a human shows up.
- **Pipelines, commands, runbooks and schedules** — curated one-shots and gated procedures, with the
  human gate where you put it.

## Settings

Tachyon contributes no VS Code settings. There are two homes, both plain text, both hand-editable,
and both validated fail-closed — an invalid value is refused by name and the last known-good is kept,
never silently defaulted.

| Home | Scope | Path |
|---|---|---|
| `tachyon.yml` → `settings:` | how **this project** runs; tracked with the repo | `<workspace>/tachyon.yml` |
| Tachyon settings file | how **this machine** behaves for **you**; never committed | `~/.tachyon/settings.json` |

Both are edited from **Control → Settings**. The global file is hand-editable on purpose: it is the
recovery path when Control itself will not open (`Tachyon: Open Global Settings File`).

## Security

Everything runs as you, on your machine, under your own agent CLIs.

- **Loopback only.** The Bridge binds `127.0.0.1` on a per-workspace port. No network, no account.
- **Per-agent identity.** Each agent is minted its own bearer token at spawn, so the Bridge resolves
  *who is calling* instead of trusting a self-declared name. Claiming someone else's identity is a
  structured refusal, not a silent lie. Only HMAC digests are persisted, never the plaintext.
- **Per-workspace isolation.** Sessions, port, token and pins are namespaced by a hash of the
  workspace path, and Tachyon runs its own tmux server — your personal tmux is never touched.
- **Capabilities are granted, not inherited.** An agent gets what a human authorized for it and no
  more, pinned to content, so an update cannot widen an approval without asking again.
- **An honest boundary.** This is provenance hardening, not a sandbox. Same-user malware reading
  process env or extension storage is the platform's trust boundary, not ours.

## How it works

```
VS Code editor area                     tmux server (socket "tachyon")
┌──────────────┬──────────────┐
│ ⚡ claude     │ ⚡ dev        │  attach   tachyon-<ws>-claude
│ (native      │ (native      │ ────────▶ tachyon-<ws>-dev
│  terminal)   │  terminal)   │           (processes live here — and
└──────────────┴──────────────┘            survive editor restarts)
        ▲                                        ▲
        │ display                                │ one persistent control-mode
        │                                        │ client (events + commands)
   Bridge (MCP over HTTP, 127.0.0.1:<port>) ─────┘
        ▲
        │ spawn_agent / read_output / write_input / run_command / notify …
   your agents (Claude Code, Codex, OpenCode, …)
```

## Language

Tachyon follows your editor. Every human-facing string is localized — currently **English** and
**Português (Brasil)**, switched with `Configure Display Language`.

## Development

```bash
npm ci
npm run build        # esbuild bundle -> dist/
npm test             # unit + integration + Product Invariants
npm run typecheck
npm run verify:full  # the gate a push to main has to pass
npm run test:browser # PRE-RELEASE gate — needs a system Chrome; see below
```

CI runs the portable core — typecheck, build, and unit including a real-tmux subset — and exposes
Product Invariants as its own gate. The editor-host integration suites are a local gate; run them on
tmux ≥ 3.6.

### `test:browser` is a pre-release gate, not a commit gate

The visual suite drives real Chrome through the dev preview harness and takes ~96s, so `verify:full`
does **not** run it. Run it before cutting a release, alongside the clean-tree check
`assertStableBuildSource` already enforces, and list it in the human dogfood pass. Leaving it out of
the commit gate is a decision, not an oversight (t-c55f8d): a suite nobody sustains does not stop
rotting by being put in a gate — the rot just moves inside the gate, where it becomes pressure to
skip on the first hurried landing.

What keeps it from rotting meanwhile is cheaper than running it. `verify:full` carries a portable,
browser-free guard (t-fdfbd4, in `test/unit/webviewPreviewRoutes.test.ts`): every `?view=` a browser
test or a `scripts/visual-qa` script opens must be a live key of `ROUTES`, and every
`dist/webview/*.js` a host page loads must be an output `esbuild.mjs` declares. Both lists are
derived from those two sources, never hand-kept. It exists because 16 of the 17 failures t-c55f8d
found were one defect repeated — tests still knocking on entry points the product had folded into
the Control bundle months earlier — and none of them needed a browser to be caught. It fails naming
the dead route and the exact `file:line`. A route deliberately kept dead is waived in place with a
`// preview-route-check: allow <token> (t-xxxxxx) — why` comment next to the reference; the guard
also fails on a waiver whose reference is gone, so the waivers cannot rot either. What the guard
cannot see is the pixel: the 17th failure was a 2px `.ds-btn` line-height mismatch (t-b8b85c), and
that is exactly what the pre-release run is for.

## Support

Tachyon is free and 100% local. If it saves you time,
**[sponsor the project](https://github.com/sponsors/cfpperche)** to keep it maintained. Bug reports,
ideas and PRs are just as welcome.

## License

**GPL-3.0-or-later.** Copyright © 2026 Carlos Perche. Free software: use it, study it, share it,
improve it — derivatives stay open under the same license.

_Need Tachyon without the GPL's copyleft obligations (e.g. inside a closed-source product)? A
commercial license is available — see [COMMERCIAL.md](COMMERCIAL.md) or email
[licensing@cognixse.com](mailto:licensing@cognixse.com)._
