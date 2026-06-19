# 235 — headless Workspace (inject tmux/Bridge) — PLAN (for review)

_Created 2026-06-19. Plan only — no code yet. **codex reviewed → PLAN-NEEDS-CHANGES (3 MAJOR + 1 MINOR), all
folded below** (`/tmp/codex-235-plan-out.json`). Value-check (codex): the payoff is **real but narrow** —
manager tests already cover tmux behavior; a Workspace-level test adds *composition* coverage (config →
managers → monitors → factory lifecycle, with no vscode/real-tmux/bound-port). **Right size = ONE smoke
test, not a test framework.** The deferred testability payoff from spec 233 (docs/system-design.md §
Testing)._

## codex folds (the corrections)
- **MAJOR — a no-op engine is needed (not just "skip it").** `ControlModeClient` isn't a transport
  optimization: it subscribes to `%sessions-changed` + the dead-pane map and calls `triggerLifecycle()`
  (`ControlModeClient.ts:12`, `Workspace.ts:193`). Skipping it loses EVENT-driven lifecycle, but the
  POLLING path still works (`tick()` → `lifecycle.tick()`/`commandRunner.tick()`, `Workspace.ts:1086`).
  AND `dispose()` assumes an engine object exists (`Workspace.ts:1477`) → a bare skip breaks teardown. So
  inject a tiny **no-op engine adapter** (narrow `engine` to a `{ start; dispose; makeExecutor? }`
  lifecycle interface); the test drives lifecycle with an explicit `ws.tick()` after mutating fake dead
  panes (not events).
- **MAJOR — `startBridge:false` is exit-based only.** `Bridge.url` is undefined until `start()`
  (`Bridge.ts:47/81`), and `startPipeline` fails closed for a SIGNAL node that can't reach the Bridge
  (`Workspace.ts:768`). So the headless test must NOT exercise a signal pipeline — keep it to
  create/start/spawn/tick (no pipeline), or a later, separately-seamed test.
- **MAJOR — non-tmux side effects.** `create()` always installs watchers, activates the scheduler, and
  starts a 3s interval (`Workspace.ts:877/887`). The test MUST call `dispose()` or it leaks timers (hence
  the no-op-engine requirement above, so dispose is clean).
- **MINOR — not "entirely in memory" if a pipeline runs.** Pipeline allocation hits `WorktreeManager.ensure()`
  = real git (`Workspace.ts:536`). So the first test stays create/start/spawn/tick; pipeline composition
  is a later seam (or an honest temp-git repo).
- **Injection shape (codex Q3):** use **`Workspace.createForTest(root, deps, seams)`**, NOT a `seams` field
  on `WorkspaceDeps` (that's the host contract — don't leak test substrate into the prod API). Prod
  `create()` stays unchanged; both delegate to one private impl.

## Why this is small (verified)
- Every manager **already takes `tmux` via opts** and is **already unit-tested with a fake tmux**
  (`commands.test.ts`, `runbooks.test.ts`, `bridge.test.ts`, `agentManager.test.ts`).
- The fake is elegant: `TmuxService` takes an `exec` (command executor) in its constructor; the tests pass
  a FAKE exec (`new TmuxService(fakeExec)`). So **no interface extraction is needed** — a "headless tmux"
  is just a real `TmuxService` backed by a fake executor.
- The ONLY blocker is that `Workspace` self-constructs its substrate in `create`/the constructor:
  `new TmuxService()` (`Workspace.ts:190`), `new ControlModeClient(...)` + `this.tmux.useExecutor(...)`
  (`:193-205`), `new Bridge(...)` (`:478`) + `ws.bridge.start(port)` (in `create`). A test can't hand in
  fakes, and `bridge.start` binds a real port + the engine connects to real tmux.

## The change (folded)
1. **`Workspace.createForTest(root, deps, seams)`** — prod `create()` and this both delegate to one private
   impl; `WorkspaceDeps` is untouched (no test substrate leaks into the host contract). `seams = { tmux?,
   startBridge?, engine? }`.
2. **Narrow the `engine` field** to a small lifecycle interface (`{ start(): Promise<void>; dispose():
   void; makeExecutor?(): ... }`). Prod passes the real `ControlModeClient`; the test passes a **no-op
   engine** → `dispose()` stays clean and control-mode is skipped.
3. **Injected `tmux`** (a fake-exec `TmuxService`) is used instead of `new TmuxService()`; lifecycle is
   then POLLING-only (`ws.tick()`), which the test drives explicitly.
4. **`startBridge:false`** constructs the `Bridge` object but skips `bridge.start()` (no port). Headless
   scope is create/start/spawn/tick — NOT a signal pipeline (Bridge isn't listening).

## The payoff (right-sized: ONE smoke test)
- A `FakeHost` (`EngineHost` in-memory no-ops — the spec-233 deferred item) + a single headless
  `Workspace` smoke test: `createForTest` with a fake-exec tmux + no-op engine + `startBridge:false`, then
  **create → start → one fake-tmux spawn (AgentManager records the session) → mutate a fake dead pane →
  `ws.tick()` → assert lifecycle reacted → `dispose()`** — zero Electron, zero real tmux, zero bound port.
- That's the *composition* coverage manager tests can't give (config → managers → monitors → factory
  lifecycle wired correctly). NOT a broad new framework — pipeline/worktree-level headless runs stay out
  (real git + Bridge preflight make them a separate, later seam).

## Acceptance
- `npm run typecheck && env -u TMUX npx vitest run` green; existing 707 unchanged; `check:engine-boundary` green.
- Production `Workspace.create` is byte-identical (delegates to the shared impl with no seams) — no behavior
  change, EDH unaffected.
- The new smoke test runs create → start → a fake-tmux spawn → tick (lifecycle reacts to a fake dead pane)
  → dispose, with no real tmux/port and no leaked timer.

## Decisions (codex-resolved)
1. Injection shape → **`createForTest` factory** (not seams on WorkspaceDeps).
2. ControlModeClient → **no-op engine adapter** (needed for `dispose()`); lifecycle is polling via `ws.tick()`.
3. `bridge.start` skipped → fine for create/spawn; **no signal pipeline** headless (Bridge not listening).
4. Scope → **one smoke test** (create/start/spawn/tick); pipeline/worktree headless = later seam.
5. Value → real but narrow; **worth one smoke test, not a framework.**
