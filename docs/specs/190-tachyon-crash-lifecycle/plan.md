# 190 — tachyon-crash-lifecycle — plan

_Drafted from `spec.md` on 2026-06-09. Update this file if implementation reveals the plan is wrong; do NOT silently diverge._

## Approach

_One or two paragraphs. The strategy in plain language — what we'll build, in what order, and why this shape (not just any shape)._

remain-on-exit set in the same tmux invocation that creates each session (start-server ; set-option -g ; new-session — atomic enough to catch instantly-dying commands). TmuxService gains sessionStates() (list-panes -a parsing pane_dead/pane_dead_status) and a one-shot retry on the server-teardown race. AgentManager reworks liveness: agentStates/runningAgents (alive-only), list() with crashed+exitCode, spawn-over-dead replaces the pane, killAll dismisses dead panes, autostart skips postmortems. New vscode-free LifecycleMonitor (ticked by the existing 3s poller) detects alive→dead transitions: exit 0 → clean; non-zero → crash event + policy (on-crash: backoff 2/4/8s, give-up at 3 restarts/60s, manual restart resets). Sidebar gains the agent-crashed state/context; extension wires toasts and the `tachyon._agents` internal command for integration assertions.

## Files to touch

_Concrete list of files to be created, modified, or deleted. Group by category if it helps._

**Create:** `src/agents/LifecycleMonitor.ts`, `test/unit/lifecycle.test.ts`.

**Modify:** `src/tmux/TmuxService.ts` (remain-on-exit, sessionStates, spawn retry), `src/agents/AgentManager.ts` (liveness rework), `src/config/loadConfig.ts` + schema (`restart`), `src/presentation/Sidebar.ts` (crashed state), `package.json` (menus for agent-crashed), `src/extension.ts` (wiring + toasts + _agents), unit fakes (list-panes), `test/unit/tmux.real.test.ts` (dead-pane tests + keepalive), `test/integration/extension.test.js` + fixture (crash + auto-restart live tests), `README.md`, `examples/tachyon.yml`.

**Delete:** none.

## Alternatives considered

_At least one rejected approach with its reasoning. If there genuinely was no alternative, state that explicitly ("no real alternative — only viable approach is X because Y")._

### Intent-tracking (mark sessions Tachyon kills to distinguish crashes)

Rejected: with remain-on-exit the distinction is structural (kill removes the session; crash leaves a dead pane) — no bookkeeping, no race between the marker and the observation.

### tmux hooks (pane-died) pushing events

Rejected for the same reason as in F1: shell hooks + transport add moving parts; the existing 3s poller observes dead panes with at most one tick of latency.

## Risks and unknowns

_What could go wrong, what we're not sure about, what assumptions we're making. Spell them out — surprises during implementation are usually pre-implementation risks that weren't named._

- remain-on-exit changes liveness semantics everywhere "session exists" was used as "process alive" — concentrated the rework in AgentManager and covered with unit + live tests.
- Server-teardown race ("server exited unexpectedly" when the last session dies as a new one spawns) — observed in test, fixed with a one-shot retry in newSession + keepalive session in the real-tmux suite.
- Crash storms of many agents at once produce one toast each — acceptable at maxAgents scale.

## Research / citations

_Sources consulted (docs, blog posts, code references) that informed this plan. Satisfies `.agent0/context/rules/research-before-proposing.md`._

- tmux(1): remain-on-exit, pane_dead, pane_dead_status; session friction + umbrella F2 discussion 2026-06-09.
