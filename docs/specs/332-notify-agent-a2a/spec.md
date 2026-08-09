# 332 — notify-agent-a2a

_Created 2026-07-02._

**Status:** shipped

**Closure:** Implemented 2026-07-02 — `src/bridge/notifyAgent.ts` (pure sanitizer/composer), the `notify_agent` Bridge tool in `src/bridge/tools.ts`, parent-aware `composeSpawnContractBrief` guidance in `src/bridge/spawnContract.ts`, and death-poke wiring (`AgentManager.parentOf` + `Workspace`'s `expectedDeath`/`pokeParentOnDeath`) in `src/workspace/Workspace.ts`. Full unit suite (2030 tests) + both typechecks green. Human dogfood (real claude/codex TUI delivery matrix, per `tasks.md`) is a documented maintainer follow-up — the mechanics are proven headless (sanitizer, envelope, tool gating, death-poke suppression), but live-pane delivery across both runtimes wasn't exercised in this session.
**Verify:** `env -u TMUX npx vitest run test/unit/notifyAgent.test.ts test/unit/spawnContract.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`
**Dogfood:** `env -u TMUX npx vitest run test/unit/notifyAgent.test.ts -t "sanit"`

## Intent

_Origin: pin `p-2e337e`, co-designed with the maintainer 2026-07-02. Naming ratified by the maintainer: `notify_agent`, NOT `notify_parent` — the target is any agent by name (parent, sibling, anyone in the fleet); "tell my spawner" is only the delegation contract's default, never the primitive's shape._

The Bridge has an agent→human attention channel (`notify`: toast + badges) and a raw any-pane transport (`write_input`: literal keystrokes, caller must know each TUI's submit quirks), but NO semantic agent→agent channel. A parent that delegates work has no way to be woken when the child finishes: `wait_for_agent` holds the parent's whole turn, and scheduled-wakeup polling is a workaround (lived today: claude had to schedule polling to learn the ad-hoc `sidebarUx` was done). The known trap is idle≠done — `AttentionMonitor`'s idle is a heuristic (a child waiting for input is also idle; the Q1 that parked spec 222) — so completion must be an EXPLICIT signal, with agent death as the only lifecycle-derived fallback.

"Done" means: any agent can call `notify_agent(to, summary)` and the recipient receives it as a single-line, provenance-enveloped message typed into its pane (input triggers a turn — silent context injection cannot wake a waiting agent; runtimes queue mid-turn input safely); the delegation contract brief instructs children to notify their spawner on completion; and a child that DIES with a live parent pokes that parent automatically.

## Acceptance criteria

- [x] **Scenario: an agent notifies any other agent by name**
  - **Given** two running agents A and B (any relation — parent/child/siblings)
  - **When** A calls `notify_agent(to: "B", summary: "…")`
  - **Then** B's pane receives ONE submitted line `[tachyon] A → B: <summary>` (whitespace collapsed to a single line — single-line input submits reliably on both runtimes, avoiding the multi-line bracketed-paste submit dance) and the tool returns ok
- [x] **Scenario: provenance is trustworthy**
  - **Given** the caller's agent name (same `caller`/`AGENT_NAME` convention as probe_agent/spawn_agent)
  - **When** the envelope is composed
  - **Then** the `from` is the Bridge-resolved caller — the summary text cannot spoof a different sender prefix (envelope is host-composed, summary is payload only)
- [x] **Scenario: recipient not running fails closed**
  - **Given** a target agent with no live session
  - **When** `notify_agent` is called
  - **Then** a structured error names the agent and states it is not running (no queueing in v1)
- [x] **Scenario: the delegation contract teaches completion notification**
  - **Given** a parent spawning an ad-hoc AI child via `spawn_agent` with `parent` set
  - **When** the child's opening brief is composed (spec 246 `composeBrief`)
  - **Then** it includes an explicit instruction to call `notify_agent(to: "<parent>", …)` when the deliverable/done_when is met (replacing the current human-`notify` guidance for delegation)
- [x] **Scenario: child death pokes the parent automatically**
  - **Given** a child agent with `parent` set whose process exits (clean exit, crash, or session gone) while the parent is running
  - **When** the lifecycle monitor observes the death
  - **Then** the parent's pane receives one `[tachyon] child '<name>' exited(<code|killed>)` line, at most once per death (no repeat on re-scan)
- [x] **Scenario: the recipient's Activity captures the notification**
  - **Given** a claude recipient
  - **When** the envelope (which starts with `[tachyon]`) lands in its transcript
  - **Then** the existing normalizer maps it to a `system.nudge` chip (no new Activity plumbing in v1; codex recipients render it as a user message — accepted v1 asymmetry, noted)
- [x] **Scenario: hostile summaries cannot break the envelope (dueto F2)**
  - **Given** summaries containing U+2028/U+2029/U+0085, C0/C1 controls, ESC/OSC/ANSI introducers, CR, backspace, or bidi override characters
  - **When** the envelope is composed
  - **Then** the sanitizer strips/replaces them (allowlist: printable scalars + ordinary space, collapse THEN cap) — the delivered envelope is provably one clean terminal line, with unit tests for each character class
- [x] **Scenario: a deliberate kill does not masquerade as a completion (dueto F3)**
  - **Given** a parent (or the host UI) intentionally killing a child via kill_agent/dismiss
  - **When** the death edge is observed
  - **Then** NO death poke fires (the kill path marks expected termination, consumed by the poke check); only unexpected deaths (crash, clean self-exit, external vanish) poke
- [x] **Scenario: the delegation brief's notification guidance survives truncation (dueto F5)**
  - **Given** an over-cap brief (task/context/constraints at their limits)
  - **When** `composeBrief` truncates to TOTAL_BRIEF_CAP
  - **Then** the `notify_agent(<parent>)` guidance line is reserved OUTSIDE the truncatable budget and survives intact (regression test with an over-cap brief)
- [x] `summary` is bounded (trimmed, non-empty, ≤500 chars after sanitize+collapse); `to` must resolve through the SAME session/kind path `write_input` uses (canonical: `manager.session(name)` + `kindOf(name) === "agent"` — declared and ad-hoc alike, tests for adhoc child/terminal/stale row); self-notify is rejected
- [x] The brief keeps BOTH channels (dueto F6): `notify_agent(<parent>)` for the A2A wake-up AND the existing human-facing completion reporting (handoff note/deliverable) — A2A never becomes the only completion path

## Known v1 limitations (documented, not deferred silently)

- **Draft concatenation (dueto F1)**: pane input is not an out-of-band bus — if the recipient's composer holds a half-typed draft, the envelope concatenates into it on submit. v1 documents this in the tool description ("best-effort pane input; unsafe for agents actively being typed into") and accepts it: the same exposure has existed for months via write_input and the retired visible nudges without incident, and composer-state detection requires per-TUI heuristics that belong to a follow-up. NOT mitigated by newline-prefixing (in claude's composer a newline SUBMITS the draft — worse).
- **Death-poke once-ness is per monitor lifetime (dueto F4)**: an extension reload that re-observes an old dead pane may poke once more — the same acceptable-once semantics the existing crash toast already has; no persistent marker in v1.

## Non-goals

- Queueing/store-and-forward for offline recipients (v1 fails closed; the task queue (spec 325) is the durable state channel — this is the ephemeral event channel).
- An idle-based "maybe done" signal — idle≠done; the sidebar idle badge idea from the pin is a separate, view-only follow-up if ever.
- Structured artifacts payload beyond the summary text (paths can ride in the summary; a typed `artifacts` field can come with the task-queue integration).
- Rate limiting/anti-loop machinery beyond self-notify rejection (two cooperating agents ping-ponging is a prompt-behavior problem, not v1 mechanism scope).
- Changing `write_input` (stays the raw escape hatch) or `notify` (human channel).

## Open questions

- None hard — the dueto should pressure-test: envelope single-line constraint vs runtimes' paste behavior, the death-poke dedupe across extension reloads, and whether `to` should also accept terminals (lean: agents only).
