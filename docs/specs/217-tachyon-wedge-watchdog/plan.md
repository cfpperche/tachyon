# 217 — tachyon-wedge-watchdog — plan

## Approach
Reuse the existing `probeServer` (classification, 3-failure guard) + `recoverWedgedServer` (SIGKILL
+ socket clear). Add only: a pure state reducer, a periodic driver, a diagnostics snapshot, and a
notification. No change to the probe's wedge logic.

## Pieces
- `src/tmux/wedgeWatchdog.ts` (NEW, pure): `type WatchdogState = "idle" | "armed" | "latched"`;
  `watchdogStep(state, probe: ServerProbe["state"]): { next: WatchdogState; action: "recover" | "none" }`.
  Sequence: idle + wedged → armed/none; armed + wedged → latched/recover; latched + wedged →
  latched/none; any healthy|no-server → idle/none. (Two-tick confirm; latch until reset.)
- `src/tmux/TmuxService.ts`: small `snapshotServerPids(pids): Promise<string>` — `ps -o pid,%cpu,rss,etime,stat,cmd -p <pids>` text for the wedge diagnostic (best-effort, returns "" on failure).
- `src/extension.ts`: a single global `setInterval` (~45s) inside `activate()`:
  `probeServer()` → `watchdogStep` → on `recover`: log `snapshotServerPids` to the output channel,
  `recoverWedgedServer({pids})`, `notify(...)`. Keep one `WatchdogState` in closure. Register the
  interval's `clearInterval` in `context.subscriptions` (no leaked timer on deactivate).
- i18n: one `vscode.l10n.t` string for the auto-recovered notification (+ pt-BR bundle).

## Tests (vitest)
- `wedgeWatchdog.test.ts` (pure): full sequence — arm→confirm→recover→latch; arm→healthy (no
  recover, reset); latched→healthy→re-wedge (recovers again); no-server/healthy stay idle.
- driver smoke: a tiny harness with a scripted probe sequence asserts recover fires exactly once
  per two-consecutive-wedged episode (reuse the reducer; stub probe + a recover spy).

## Risks
- **False-positive auto-kill** → mitigated by probe's 3-WEDGE_RE-failure guard + the two-tick
  confirm; a slow-but-healthy server returns a semantic reply = healthy.
- **Interval leak** → registered in subscriptions, cleared on deactivate (assert in review).
- **Multi-workspace double-fire** → ONE interval at extension scope, not per-workspace.

## codex dueto
Adversarial review after green — focus: the two-tick state machine correctness (no missed/double
recover), interval lifecycle, and that auto-recover can't fire on a healthy-but-slow server.
