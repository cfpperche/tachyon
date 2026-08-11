# 218 — tachyon-test-tmux-isolation

_Created 2026-06-15._

**Status:** in-progress

**UI impact:** none

## Intent

**Make it impossible for a real-tmux TEST to touch the production `-L tachyon` server.** A test in
spec 217 (`anchor.integration.test.ts`) ran an UNSCOPED `tmux kill-server` (no `-L`) in `afterAll`.
Because the suite is run from a shell INSIDE a Tachyon pane, `$TMUX` pointed at the production
`-L tachyon` socket, so the bare `kill-server` killed every live agent **and** the pane running the
test → `vitest` got SIGKILL'd (exit 137, misread as OOM for a while). The point fix (`-L`-scope that
one call) is shipped with 217. This spec adds the **systemic guard** so the class can't recur.

## Root of the class
Every real-tmux test executor runs `execFile("tmux", isolatedArgs(args), …)` with **no `env`
option → it inherits the parent's full env, including `$TMUX`/`$TMUX_PANE`**. So ANY tmux
invocation that omits `-L <socket>` silently targets the inherited (production) server. `isolatedArgs`
only adds `-f /dev/null` (config isolation), not socket isolation. Socket scoping is left to each call
site — one missed `-L` = production takedown.

## Confirmed design
- A tiny shared test helper **`tmuxChildEnv(base = process.env)`** that returns the env with
  **`TMUX` and `TMUX_PANE` deleted**. A tmux child with no `$TMUX` falls back to the `default`
  socket for any unscoped op — never the inherited production `-L tachyon`. Lives in
  `test/helpers/tmuxEnv.ts` (new), pure + unit-tested.
- **Apply it to every real-tmux `execFile`/`execFileSync` in tests** — `anchor.integration.test.ts`,
  `tmux.real.test.ts` (both executors incl. the HOME-override one), `verifyGate.integration.test.ts`.
  This is belt-and-suspenders: the call sites still `-L`-scope (that's the correct primitive), but now
  even a future missed `-L` cannot reach production.
- **Scope:** test-only. Production `TmuxService` always passes `-L tachyon` and is NOT vulnerable;
  not touched (no demonstrated risk; avoid a subtle prod change).

## Non-goals
- Changing production tmux env handling.
- Removing per-call `-L` scoping (it stays — this is a second layer, not a replacement).
- A lint rule forbidding bare `kill-server` in tests (possible later; the env guard is the v1 floor).

## Acceptance
- `tmuxChildEnv({ TMUX: "x", TMUX_PANE: "y", FOO: "1" })` → `{ FOO: "1" }` (both vars stripped,
  others preserved). Unit-tested.
- All real-tmux test executors pass `env: tmuxChildEnv()` (or `tmuxChildEnv({…HOME})` where a HOME
  override already exists). Grep shows no real-tmux `execFile(Sync)?("tmux"` without the guarded env.
- Full suite green; re-run with `$TMUX` set to production confirms agents survive (the 217 proof,
  now structural rather than per-call).
- A short README/test-doc note: real-tmux tests MUST use `tmuxChildEnv` (+ `-L <isolated socket>`).
