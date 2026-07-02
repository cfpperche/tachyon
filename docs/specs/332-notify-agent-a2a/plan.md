# 332 — notify-agent-a2a — plan

_Drafted from `spec.md` on 2026-07-02._

## Approach

1. **Envelope composer** (`src/bridge/notifyAgent.ts`, pure): `composeAgentNotice(from, to, summary)` → SANITIZE first (dueto F2: strip C0/C1 controls incl. ESC/CR/backspace, OSC/ANSI introducers, U+2028/U+2029/U+0085, bidi overrides — allowlist printable scalars + space), then collapse whitespace, trim, cap at 500, return `[tachyon] <from> → <to>: <summary>`. Single clean terminal line BY CONSTRUCTION — this is what makes delivery reliable on both runtimes (multi-line pastes trip codex's bracketed-paste submit dance, observed live 2026-07-01; single-line `send-keys -l` + `C-m` submits on claude and codex alike, proven daily by the retired persistence nudges which used exactly this path).
2. **Bridge tool** (`src/bridge/tools.ts`, after `write_input`): `notify_agent {to: AGENT_NAME, summary: bounded string, agent: AGENT_NAME (caller)}` — resolves the target session via `deps.manager.session(to)` + `hasSession` (fail-closed "not running"), rejects `to === caller` and non-agent kinds (`manager.kindOf`), delivers via `deps.tmux.sendKeys(session, envelope, true)`, returns ok. Description teaches the semantics ("wake another agent with a one-line message — the completion signal for delegation; NOT a chat channel").
3. **Delegation contract** (`src/bridge/spawnContract.ts` `composeBrief` + the `spawn_agent` tool description): the brief's closing guidance becomes "when the deliverable/done_when is met, call `notify_agent(to: \"<parent>\", summary: <one line>)`" (parent name interpolated; only when `parent` was given). The tool description's "call notify when done" line is updated to point at `notify_agent`.
4. **Death poke** (`src/workspace/Workspace.ts`, in the existing `LifecycleMonitor` event wiring): on `onCleanExit`/crash/`onGone` for an agent whose `manager` lineage has a live parent → `sendKeys(parentSession, envelope, true)`, riding the monitor's `prev`-map edge (once per monitor lifetime — documented, dueto F4). **Deliberate kills are suppressed (dueto F3)**: the `kill`/`dismiss` paths add the child to an `expectedDeath` set consumed by the poke check — cancellation never masquerades as completion.
5. **Brief budget (dueto F5)**: the `notify_agent(<parent>)` guidance is composed OUTSIDE the truncatable slot budget (appended after the capped body, its length reserved up front), so an over-cap brief never loses the completion contract; regression test included. The guidance ADDS to (not replaces) the human-facing completion reporting (dueto F6).
5. **Activity**: nothing to build — the `[tachyon]` prefix already maps to `system.nudge` in the claude normalizer (chip, not a chat bubble). Codex recipients see it as a user message in Activity (v1 asymmetry documented; the codex normalizer nudge-classification is a tiny follow-up if it grates).

## Key decisions

- **Pane input, not silent context** — a waiting agent is only woken by something that starts a turn; hooks' `additionalContext` only fires at session boundaries (and claude 2.1.198's resume regression makes that channel unreliable anyway — pin p-550ea5). Queued input is the one mechanism both runtimes handle mid-turn safely.
- **Host-composed envelope = unspoofable provenance** — `from` comes from the tool's `agent` param (same trust model as every Bridge tool's caller field), and the summary is payload after the colon; a malicious summary cannot fake a different sender line since newlines are collapsed.
- **Single-line by construction over runtime-specific submit dances** — rejected: implementing per-runtime paste choreography (codex double-C-m with delay) inside the tool; collapsing to one line removes the entire problem class and matches the proven nudge delivery path.
- **Fail-closed on offline recipients** — rejected queueing: the durable "what happened" belongs to the task queue/handoff; this primitive is an ephemeral wake-up. Queueing would also create replay-on-resume surprises.
- **Agents only as targets** — terminals don't parse prose; poking a bash pane types garbage into a shell (harmful). `kindOf` gate.
- **Death poke rides LifecycleMonitor's existing edge detection** — no new state store; the `prev` map's alive→dead edge is already exactly-once per observation epoch.

## Files touched

- `src/bridge/notifyAgent.ts` (new, pure) + `test/unit/notifyAgent.test.ts`.
- `src/bridge/tools.ts` — the tool + spawn_agent description tweak.
- `src/bridge/spawnContract.ts` — brief guidance line (parent-aware) + its tests.
- `src/workspace/Workspace.ts` — death-poke wiring in the LifecycleMonitor events.
- `test/unit/` — spawnContract tests extended; a Workspace-level death-poke test if the harness allows (else the pure composer + contract tests carry it, wiring verified in dogfood).

## Risks & unknowns

- **R1 — poke lands mid-turn**: runtimes queue input; the recipient sees it at the next turn boundary. Acceptable and desired (it's a message, not an interrupt).
- **R2 — reload re-observes an old dead pane** → one duplicate death poke after extension restart. Same acceptable-once semantics as existing crash handling.
- **R3 (dueto F1) — draft concatenation**: documented v1 limitation (see spec) — tool description warns; per-TUI composer detection is follow-up material.
- **R4 (dueto F8) — TUI delivery matrix**: human-dogfood checklist covers both runtimes × {idle composer, existing draft, 500-char envelope, unfocused pane}; unsupported modes get documented, not implied.
- **R5 — prompt-injection surface**: the envelope is agent-authored text typed into another agent's stdin. Mitigations: provenance prefix is host-composed, summary is bounded/single-line, and the recipient's own system prompt governs trust. Same exposure class as write_input, which already exists — this narrows it (bounded, enveloped) rather than widening.

## Sources consulted

- `src/bridge/tools.ts` (`write_input` :503, `notify`, `spawn_agent` description :178), `src/bridge/spawnContract.ts` (brief composition + caps), `src/tmux/TmuxService.ts:593` (sendKeys), `src/agents/LifecycleMonitor.ts` (death edge events), `src/activity/claudeNormalizer.ts` (`[tachyon]` → system.nudge).
- Pin `p-2e337e` (co-designed shape + idle≠done trap), pin `p-550ea5` (why hooks can't be the wake channel), spec 222 PARK notes (Q1 idle≠done), live evidence: the codex paste double-C-m dance (2026-07-01) and today's sidebarUx polling workaround.
