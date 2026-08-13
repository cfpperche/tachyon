# 488 — ide-browser-design-mode

_Created 2026-08-04._  
_Product lean drafted from prototype dogfood on branch `tachyon/grok` (Integrated Browser + Design Mode chat)._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**Kind:** product SDD (IDE Integrated Browser + Design Mode v1)  
**Branch:** `tachyon/grok` — **ready for merge review** (do not merge until maintainer ratify). Architecture fit for two bridges: `architecture-fit.md`.  
**Relates to:** 414 (Companion shell), 420 (Companion tab tools), 267/268/271 (agent-browser plugin) — sibling browser products, not replacements  
**Positioning:** *Point at the UI. Talk to your agent. See the change.*  
**Review memo:** `docs/specs/488-ide-browser-design-mode/architecture-fit.md`

## Intent

Tachyon already orchestrates multi-runtime agents inside VS Code (Bridge, identity, attention, worktrees).
What it still lacks as a **product loop** is a first-class way for the human and an agent to share the
**same visual viewport** in the editor: point at real UI, request a change, and receive a human-visible
reply without reconstructing intent from a terminal pane.

Today three partial paths exist and must not be conflated:

| Product | Who owns the browser | Job |
|---|---|---|
| **agent-browser** (267+) | Agent / provisioned session | Headless or agent-driven automation |
| **Companion** (414/420) | Human’s everyday browser | Pair, tab tools, approvals on the user’s real session |
| **IDE Integrated Browser + Design Mode (this)** | VS Code editor-browser tab | Human + agent share the **in-IDE** viewport |

This spec defines **product v1** for Design Mode on top of the Integrated Browser prototype:

1. A stable **IDE Browser Bridge** (shell HTTP + CDP) discovered per workspace.
2. **Design Mode** on that tab: human picks elements; active agent receives a bounded prompt.
3. A **Design Mode chat panel** for human-visible group-thread UX with durable workspace history.
4. Bridge MCP tools so the agent answers via **`design_mode_chat_reply`** (not pane markers).
5. Fail-closed offline behavior; tools always listed when the engine wires the client.

**Done for product v1** means: with Integrated Browser open and Design Mode on, a human can pick (or
chat), the configured agent works, and a plain-language reply lands in the Design Mode chat panel
without requiring the human to open the agent terminal — across at least one primary runtime
(Grok or Claude), with Codex treated as a hard dogfood target, not a nice-to-have.

**Not done for v1:** multi-agent group chat as default collaboration mode, Figma-class design system
automation, or replacing Companion / agent-browser.

**Affected Product Invariants:** none expected. Re-assess if Design Mode begins minting approvals or
mutating host-authoritative task records without an existing seam.

## Concept brief

### Product form

| Field | Value |
|---|---|
| Product name | **Tachyon Design Mode** (surface) on **Integrated Browser** (shell) |
| Code / SDD slug | `ide-browser-design-mode` |
| Form | VS Code shell (editor-browser + CDP) + engine client + Bridge tools |
| Audience | Humans dogfooding / shipping UI work with Tachyon agents locally |
| Primary job | Point at in-IDE UI → agent acts → human sees reply + page change |
| Non-job | Everyday-browser companion; headless RPA; multi-agent debate room |

### Architecture (two bridges — binding)

```text
Agent runtime
    │  MCP (Bearer)
    ▼
Tachyon Bridge (engine)          ← design_mode_chat_reply, ide_browser_*
    │  HTTP + token (local)
    ▼
IDE Browser Bridge (extension host)
    │  CDP
    ▼
VS Code Integrated Browser tab (+ Design Mode overlay / chat)
```

- Agents **only** speak MCP to the **Tachyon Bridge**.
- The **IDE Browser Bridge** is a separate shell service (instance file under
  `~/.tachyon/ide-browser-instances/`). It is not a second orchestrator.
- Discovery is workspace-rooted; dead PIDs are swept; offline calls fail closed with a clear code
  (e.g. `bridge_offline`).

### Product north stars (v1)

1. **One loop, one active agent** — Design Mode targets a single configured agent per send; group
   history may *display* multiple speakers later, but v1 orchestration is single-agent.
2. **Reply tool is mandatory when listed** — `design_mode_chat_reply` is the human-visible path.
   Pane markers are emergency fallback only, then deprecated.
3. **Tools always discoverable** — catalog must not depend on “instance file was live at MCP connect”.
   Offline is a **call-time** failure, not a missing tool.
4. **History is workspace-durable, not pane-embedded** — JSONL (or successor) under the workspace;
   prompts carry a path + instruction, not the full transcript dump.
5. **Clear product separation** from Companion and agent-browser in docs, settings, and tool names.

### Settings / entry points (v1)

- `settings.ideBrowser.homeUrl` (already sketched) — default URL for open.
- Commands / status-bar cluster for open browser + toggle Design Mode (prototype: icon cluster).
- Opt-in posture for GA: feature remains Dev Host / experimental until dogfood gate; GA may keep
  settings gate if maintainer prefers.

## Acceptance criteria

### A. Integrated Browser shell

- [ ] **Scenario: bridge starts for a workspace**
  - **Given** a Tachyon workspace in VS Code with the shell loaded
  - **When** the human opens Integrated Browser (or Design Mode, which starts the shell)
  - **Then** a live instance file exists for that workspace root, HTTP+token are local-only, and
    `/status` reports running
- [ ] **Scenario: dead instances do not poison discovery**
  - **Given** stale instance files with dead PIDs
  - **When** the engine resolves the bridge for a workspace
  - **Then** dead files are swept and either a live match is used or the client reports offline —
    never a hung call to a dead port without a clear error
- [ ] **Scenario: navigate and observe**
  - **Given** the IDE Browser Bridge is running
  - **When** an agent (or human command) navigates to an http(s) URL
  - **Then** the Integrated Browser shows that page and `ide_browser_url` / snapshot / screenshot
    reflect it

### B. Design Mode pick → agent

- [ ] **Scenario: pick injects bounded work**
  - **Given** Design Mode is on and an active agent is configured and running
  - **When** the human clicks an element in the Integrated Browser
  - **Then** the agent receives a bounded pick payload (selector / role / text hints — not a full
    page dump) and attention shows working without requiring the human to paste context
- [ ] **Scenario: no agent / offline agent**
  - **Given** Design Mode is on but the active agent is missing or stopped
  - **When** the human picks or sends chat
  - **Then** the UI states the failure clearly; no silent drop

### C. Design Mode chat + reply tool

- [ ] **Scenario: human message reaches the active agent**
  - **Given** Design Mode chat is open and an agent is active and running
  - **When** the human sends a message in the chat panel
  - **Then** the agent is prompted with the workspace chat history path + explicit instruction to
    answer via `design_mode_chat_reply`, and the message is appended to durable history
- [ ] **Scenario: agent reply lands in the panel**
  - **Given** the agent has `design_mode_chat_reply` in its MCP tool list
  - **When** it completes a Design Mode turn successfully
  - **Then** a plain-language reply appears in the Design Mode chat attributed to that agent, and
    the human does not need the terminal to see the answer
- [ ] **Scenario: tool listed offline**
  - **Given** the IDE Browser Bridge is not running
  - **When** a new MCP session lists tools
  - **Then** `design_mode_chat_reply` and `ide_browser_*` are still listed (when the engine wires
    the client), and invoking them fails closed with an actionable offline error
- [ ] **Scenario: bridge start refreshes live sessions**
  - **Given** agents connected before the IDE Browser Bridge started
  - **When** the shell starts (or stops)
  - **Then** the engine forces MCP tool-list refresh so runtimes can re-discover the catalog
    (best-effort; runtimes that ignore `list_changed` still need restart — documented)

### D. Durability & UX hygiene

- [ ] Chat history for a workspace is one durable store (prototype: `.tachyon/design-mode-chat/chat.jsonl`)
- [ ] Prompts do not embed full chat history blobs; they point at the store + current user text
- [ ] Chat panel is draggable/resizable as a floating base; scroll behavior is usable (not broken
      by nested transforms)
- [ ] Status-bar entry points are a compact adjacent cluster (not two unrelated long labels)

### E. Product boundary documentation

- [ ] Spec and operator docs state the three-browser matrix (agent-browser / Companion / Design Mode)
- [ ] Tool namespace remains `ide_browser_*` + `design_mode_chat_reply` (not `user_browser_*`)

## Non-goals (v1)

- **Not** replacing Companion (414/420) or agent-browser (267+).
- **Not** default multi-agent group chat orchestration (who answers, debate, parallel replies).
- **Not** Figma / design-system product; no layout engine, no component library authoring.
- **Not** cookie/SSO sharing with the human’s everyday browser (that is Companion).
- **Not** requiring pane transcript markers as the primary reply path.
- **Not** LAN / remote IDE Browser Bridge (loopback only in v1).
- **Not** merge to `main` as part of drafting this SDD — productize on the feature branch until
  ratify + dogfood gate.
- **Not** mobile / external Companion redesign.

## Follow-ups (explicitly out of v1 ship, tracked here)

These are **documented successors**, not silent scope creep. Prefer new SDD numbers or board tasks
when work starts; keep status notes here until split.

| ID | Follow-up | Why deferred | Suggested next artifact |
|---|---|---|---|
| F1 | **Remove the pane-text reply protocol** | Completed by `t-45b266` after live Claude/Codex/Grok pending-turn proof; `design_mode_chat_reply` is the sole path | done |
| F2 | **Multi-agent group thread** (selector of saved agents, concurrent speakers, @-mention routing) | Needs product rules for who answers; prototype UI is exploratory only | SDD 488-group or board design task |
| F3 | **Runtime parity matrix** (Claude / Codex / Grok / Pi) for tool-call reliability of `design_mode_chat_reply` | Codex dogfood showed “tool listed but unused” behavior | dogfood matrix in notes + optional SDD |
| F4 | **GA settings gate + onboarding** (`settings.ideBrowser.enabled`, first-run tips) | Prototype is Dev Host–shaped | plan phase when v1 dogfood green |
| F5 | **Pick → patch quality** (structured edit proposals, screenshot-in-chat, undo) | v1 is loop reliability, not edit intelligence | later SDD |
| F6 | **Security review** (eval surface, click automation, Trusted Types, token storage) | Prototype trust model is local-dev | checklist before GA |
| F7 | **Cookbook** for operators/agents (when to use which browser product + tool table) | After tool names stabilize | `cookbook.md` via sdd-cookbook |
| F8 | **Evidence / Visual QA pack** for close | Needs stable UI | `evidence/` under this spec |
| F9 | **Instance multi-window / multi-root** edge cases | v1 is single workspace root match | notes → later task |
| F10 | **Merge path to main** | Explicit maintainer decision after dogfood; not automatic from this branch | release checklist |

## Open questions

| # | Question | Owner / path |
|---|---|---|
| Q1 | Is Design Mode **experimental forever under settings**, or on-by-default when Integrated Browser opens? | Maintainer ratify |
| Q2 | Primary dogfood runtime for v1 gate — Grok, Claude, or both required? Codex required or soft? | Maintainer ratify |
| Q3 | Chat store format stay JSONL or move to a small SQLite/structured store under `.tachyon/`? | Implementer; JSONL OK for v1 unless concurrency hurts |
| Q4 | Should pick auto-open chat, or keep pick→terminal-only as an option? | Prototype: pick injects agent; chat is parallel — ratify UX |
| Q5 | Official product name string in UI (“Design Mode” vs “IDE Browser Assist”)? | Maintainer; code may keep `designMode` identifiers |

## Dogfood contract (product gate sketch)

**Human dogfood (v1 green):**

1. Dev Host / Extension Development Host on a clean fixture workspace (no pre-seeded agents if testing create flow).
2. Start Integrated Browser → home URL loads.
3. Toggle Design Mode on; select a running agent.
4. Pick an element → agent works → reply appears in Design Mode chat via tool.
5. Send a free-text chat message → same reply path.
6. Restart agent MCP mid-session with browser already up → tool still listed and usable.
7. Stop browser → tool still listed; call fails offline clearly.

**Headless:** unit coverage for chat store, inject/sanitize, tool registration always-on, instance sweep;
optional fixture README path under `test/fixtures/ide-browser-dogfood/`.

## Status note (prototype vs this SDD)

A working **prototype** exists on `tachyon/grok` (shell manager, CDP inject, chat JSONL, tools,
status-bar cluster, dogfood fixture). This SDD **ratifies product v1 boundaries** and records
follow-ups. Prototype code may land into implementation tasks under this number after ratify; it is
**not** an automatic claim of `shipped`.
