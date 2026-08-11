# 217 — tachyon-wedge-watchdog

_Created 2026-06-14._

**Status:** in-progress
**Status detail:** in-progress — design locked 2026-06-14 (D-A, D-B below); implementing.

**UI impact:** flow
<!-- A background-detected wedge surfaces a recovery toast (or auto-recovers). Verified by
wedging a real -L tachyon server and confirming the watchdog notices + recovers mid-session. -->

## Intent

**Detect a wedged tmux server DURING a live session, not only at activation.** Field incident
(2026-06-14): the dedicated `-L tachyon` server wedged after ~2 days (process alive, **58 min CPU**
spinning, every command answered "server exited unexpectedly", ignored SIGTERM). Every agent/
terminal died, the sidebar showed all `stopped`, the inspector showed 0 sessions, and the Bridge
dropped — silently. The user only discovered it by looking; manual `kill -9` + socket removal
recovered everything (the resume ledger survived, so no data was lost).

**Root cause is two separate things — only one is ours:**
1. **The wedge itself is upstream** — a tmux 3.6a/WSL2 server bug, already documented in
   `TmuxService.ts` (the wedged-server comment). Not Tachyon hammering it (the 58-min CPU is the
   wedged server spinning). **Out of scope** — we can't fix tmux.
2. **The non-recovery is ours, and is the actionable gap.** Tachyon already HAS wedge detection
   (`probeServer`) + recovery (`recoverWedgedServer`, both v0.11.1), but `probeServer` only runs at
   **activation** (`extension.ts`) and inside two **manual** commands (`checkRequirements`,
   `restartTmuxServer`). **Nothing re-probes during a live session** → a mid-session wedge is
   invisible until the user reloads the window or runs a command by hand.

This spec adds a **background watchdog** that periodically (cheaply) checks server health and
surfaces recovery the moment a wedge appears — closing the activation-only gap. It reuses the
existing, already-guarded primitives; it does not touch the probe's wedge-classification logic.

## Confirmed design (proposed — locking at this checkpoint)

- **A background health check runs on a low-frequency interval** (e.g. every 45–60s), at the
  extension level (the dedicated socket is process-global — ONE watchdog regardless of workspace
  count, never per-workspace-tick). Reuses `probeServer()` verbatim — its 3-consecutive-failure +
  socket-exists guard already prevents a slow-but-healthy server from being misread as wedged.
- **Cost is negligible** — one `tmux -L tachyon list-sessions` per interval when healthy; the
  AttentionMonitor already issues far more tmux calls than that per second. `no-server` (nothing
  running) is a no-op; only `wedged` acts.
- **On a confirmed wedge, AUTO-recover** via `recoverWedgedServer` (SIGKILL the zombie + clear the
  socket) and **notify** — no prompt (D-B). **Two-tick confirmation:** the first `wedged` tick arms;
  only a second consecutive `wedged` tick fires recovery (guards a transient WSL hiccup). After
  recovery, latch so it doesn't re-fire until a healthy/no-server probe resets the state.
- **Capture diagnostics before killing** (so the upstream tmux wedge can eventually be root-caused):
  when a wedge is confirmed, snapshot the server PIDs' `ps` (CPU/RSS/elapsed) into the Tachyon log
  before `recoverWedgedServer` SIGKILLs them. Cheap, and the only evidence we'll get next time.
- **Pure, testable core:** a small reducer `watchdogStep(prev, probeState)` →
  `{ next, action: "recover" | "none" }` implementing arm → confirm → recover → latch → reset;
  unit-tested across the full sequence. The interval + IO (probe, ps, recover, notify) stay thin.

## Decisions (locked 2026-06-14 with the maintainer)
- **D-A — Detection = blind periodic `probeServer()`** on a low-frequency timer (~45–60s),
  extension-level, one global watchdog. (Passive-ride rejected as needlessly invasive for v1.)
- **D-B — Recovery = auto-recover + notify** (no toast prompt). A wedge already lost every session,
  so SIGKILLing the zombie + clearing the socket loses nothing; the user just gets a notification
  ("tmux server was wedged — recovered; restart your agents"). Relies on the probe guard against
  false positives.
- **D-B safety reinforcement (because auto kills without asking):** require the wedge to persist
  across **two consecutive watchdog ticks** before the auto-SIGKILL — a single tick's three
  `WEDGE_RE` failures triggers a *confirm* tick; only a second consecutive `wedged` result fires
  recovery. Guards against a transient WSL hiccup spuriously reading as a wedge. The manual
  `restartTmuxServer` command stays immediate (human already confirmed).

## Non-goals
- **Fixing the tmux wedge itself** (upstream tmux 3.6a/WSL2; not ours).
- **Changing `probeServer`'s wedge classification** (the 3-failure guard stays as-is).
- A general process supervisor — this watches exactly one thing: the dedicated socket's health.

## Behavior (proposed)
- A server wedges mid-session → tick N the watchdog's `probeServer()` returns `wedged` (arms) →
  tick N+1 still `wedged` → Tachyon logs the PIDs' `ps`, `recoverWedgedServer` SIGKILLs the zombie +
  clears the socket, and a notification fires ("tmux server was wedged — recovered; restart your
  agents"). The next agent start boots a fresh server. The user never has to notice-then-reload.
- Healthy or no-server probes are silent and reset the state machine. A single isolated `wedged`
  tick that clears on the next tick never triggers recovery.

## Acceptance
- The watchdog interval calls `probeServer` at the extension level, once globally; disposed on
  deactivate (no leaked timer).
- `watchdogStep` (pure) implements the full sequence: `wedged` from idle → arm (`none`); second
  consecutive `wedged` → `recover` + latch; `wedged` while latched → `none`; any
  `healthy`/`no-server` → reset to idle. Unit-tested across the sequence incl. the
  arm-then-clear (no false recover) and re-wedge-after-reset paths.
- A real-tmux integration smoke: with a probe stub, two consecutive `wedged` results fire recovery
  exactly once; an arm-then-healthy sequence fires nothing; a post-reset re-wedge fires again.
- Diagnostics: on a confirmed wedge, the server PIDs' `ps` snapshot is logged before recovery.
- README/CHANGELOG note the background watchdog + auto-recover behavior.
