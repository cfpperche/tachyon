# Agent surface lifecycle — audited transitions

_Audited 2026-07-26 for `t-b88106` against `codex-cli`-era `main` (`f9cd9df7`)._

"Surface" here means the agent's **editor terminal** — the VS Code tab attached to its tmux session.
An agent is **headless** when no such tab exists; the agent is running either way. tmux is the source
of truth for whether the agent lives; the surface is presentation and must never be confused with it.

## The rule

**A relaunch never changes whether an agent is visible.** Starting an agent is a request to look at
it. Restarting, resuming, or recovering one is not — it continues an agent that was already headless
or already open, so it restores what was there and invents nothing.

That rule is stated once, in `SurfacePreservation` (`src/workspace/surfacePreservation.ts`), and every
launch path routes through it. `AgentManager` declares an intent — `reveal`, `preserve`, or `silent` —
and the presentation layer resolves it, because only the presentation knows what is actually open (and
a persistent engine can serve several windows that disagree).

## Matrix

| # | Transition | Trigger | Expected surface | Observed before `t-b88106` | Now |
|---|-----------|---------|------------------|---------------------------|-----|
| 1 | **spawn** (declared/human ▶) | sidebar ▶, `agent.start` | opens — the start IS the request to see it | opens | unchanged (`reveal`) |
| 2 | **spawn** (Bridge child, `reveal:false`) | `spawn_agent` from an agent | nothing opens, no focus stolen (F3) | correct | unchanged (`silent`) |
| 3 | **fork** | fork command | opens — a new agent someone asked for | opens | unchanged (`reveal`) |
| 4 | **restart, agent headless** | sidebar ↻, `agent.restart` | **stays headless** | ❌ **opened an editor tab — the reported defect** | ✅ stays headless |
| 5 | **restart, agent visible** | sidebar ↻ | existing tab restored, never duplicated | opened/kept one tab | ✅ exactly one tab |
| 6 | **restart, kill+new fallback** | restart when respawn-in-place fails | same as 4/5 across the forced close | ❌ always reopened | ✅ latch restores only what was open |
| 7 | **crash auto-restart** | `LifecycleMonitor` → force+new | **stays headless** — no human asked for anything | ❌ opened a tab unprompted | ✅ stays headless |
| 8 | **watch-restart** | watched file changed → force+new | **stays headless** | ❌ opened a tab unprompted | ✅ stays headless |
| 9 | **resume** (activation auto-resume) | window reload | nothing opens; `restoreOpenTerminals()` reopens what the manifest says was open | ❌ opened a tab per resumed agent, and wrote each into the manifest | ✅ manifest is the only memory |
| 10 | **resume** (human ↻ / resume-all) | sidebar ↻ on a stopped agent | preserves — resuming is not "show me" | opened a tab | ✅ preserves (see note) |
| 11 | **client rebind resume** | Bridge rebind | preserves | opened a tab | ✅ preserves |
| 12 | **attach / re-open** | click the agent, `terminal.open` | opens, or reveals the existing tab | correct — no duplicate | unchanged |
| 13 | **detach** (human closes the tab) | closing the editor tab | agent keeps running, headless | correct locally; **the engine is never told** | unchanged — filed separately (see Gaps) |
| 14 | **stop / kill** | sidebar ■, `agent.kill` | tab closes, session ends | correct | unchanged, plus the pending restore is dropped |
| 15 | **dismiss** (ad-hoc) | `dismiss_agent` | row and tab go, log dropped | correct | unchanged |
| 16 | **crash without restart policy** | crash, `restart: never` | dead pane kept for postmortem; tab stays for inspection | correct | unchanged |

Rows 4–11 are the behavior change. Everything else was already right and is pinned by tests so it
stays right.

**Note on rows 10/11 (resume).** Resume is uniformly `preserve`, including the human sidebar ↻. This
is a deliberate consistency call, not an oversight: the complaint behind `t-b88106` is lifecycle
actions changing UI state nobody asked to change, and "bring this agent back" is a different request
from "show me this agent" — which has its own affordance (row 12). Treating the human ↻ as `reveal`
would also mean "resume all offered" opening a tab per agent, which is the same interruption at scale.

## Where each decision lives

| Concern | Owner |
|---------|-------|
| What a launch INTENDS (`reveal` / `preserve` / `silent`) | `AgentManager` — `SpawnReveal` at each launch site |
| What is actually on screen | `TerminalPresentation` (`Terminals`, `DaemonTerminalPresentation`, headless) |
| Resolving intent against reality | `SurfacePreservation`, held by `Workspace` |
| What reopens after a window reload | the terminal manifest, via `restoreOpenTerminals()` |

## Gaps found, filed separately

The audit surfaced two problems that are **not** this fix and were not folded into it:

- **A human closing an agent's tab never reaches the engine.** `Terminals` accepts an `onClosed`
  callback for exactly this, but `VsCodeHost.createTerminalPresentation` passes only three of its four
  arguments and `TerminalPresentationOptions` has no `onClosed` field, so the hook is dead code. In
  the daemon presentation the durable intent therefore keeps an agent whose tab the human closed,
  which `replay()` re-presents after a reload. Tracked as an independent task.
- **The local editor-host integration gate cannot host a Tachyon workspace on this machine.** Measured
  on `main`: 6 passing / 17 failing, no agent ever spawned, no `.tachyon/` written, no Bridge port
  bound — while `tmux 3.6` IS visible to the extension host and the shared tmux server IS reachable
  from it. So it is neither the `doctor()` gate nor workspace trust (tested with
  `--disable-workspace-trust`: unchanged). Tracked as an independent task.

## Coverage

| Level | File | What it proves |
|-------|------|----------------|
| Rule | `test/unit/surfacePreservation.test.ts` | the predicate and its latch semantics, including staleness |
| Intent | `test/unit/agentManager.test.ts` | each launch site declares the right intent |
| Wiring | `test/unit/workspaceSurfaceLifecycle.test.ts` | real `Workspace` + `AgentManager` + `Terminals` — the defect fails 3 of these tests if the old `reveal` is restored |
| Editor | `test/integration/surfacePreservationDogfood.test.js` | the same scenarios in a real VS Code host; skips with diagnostics where the host cannot spawn agents |
