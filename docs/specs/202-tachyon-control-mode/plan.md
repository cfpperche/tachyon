# 202 — tachyon-control-mode — plan

_Drafted from `spec.md` on 2026-06-10. Update this file if implementation reveals the plan is wrong; do NOT silently diverge._

## Approach

Two phases behind one new class, never touching the monitors' logic.

**Phase 1 — command channel.** `ControlModeClient` spawns ONE persistent
`tmux -L tachyon -C attach-session -t =tachyon-ctl-<hash>` (anchor created
detached running `tail -f /dev/null`; its own prefix keeps it invisible —
same trick as the cmd/rb namespaces). The class owns: line-protocol parser
(`%begin`/`%end`/`%error` reply framing, `%`-notifications, octal unescape),
a FIFO promise queue for exec, reconnect with backoff, dispose. `TmuxService`
already takes an injectable `TmuxExecutor` — the engine plugs in as an executor
that routes through the client and FALLS BACK to the current `execFile` path
when the client is down. Every existing call site, runner, and monitor is
untouched; churn drops to zero.

**Phase 2 — event triggers.** Same client, two signals:
- `%sessions-changed` → a session vanished/appeared → trigger `lifecycle.tick()`
  now (instant `gone`, instant spawn visibility).
- One subscription `refresh-client -B tachyon-dead::'#{S:#{session_name}=#{?pane_dead,D#{pane_dead_status},A} }'`
  (format loops encode the server-wide liveness map) → `%subscription-changed`
  whenever any pane dies → trigger `lifecycle.tick()` (~1s crash detection).
Ticks stay idempotent and the 3s ticker remains as heartbeat — events only make
things sooner, never different. Attention keeps its cadence (captures now ride
the pipe); CPU sampling unchanged.

Task 1 is a SPIKE on the real socket proving the two load-bearing unknowns
(nested format loops in subscriptions; reply framing under concurrent exec)
before any wiring lands. If nested loops fail on the user's tmux version, the
fallback is Phase 2 with `%sessions-changed` only + lifecycle ticker at 1s
through the (now free) pipe — degraded but still strictly better.

## Files to touch

**Create:**
- `src/tmux/ControlModeClient.ts` — client, parser, exec queue, subscriptions, reconnect
- `test/unit/controlMode.test.ts` — parser/queue/reconnect against scripted streams
- (extend) `test/unit/tmux.real.test.ts` — real-socket control client coverage

**Modify:**
- `src/tmux/TmuxService.ts` — engine-aware executor (control-mode first, execFile fallback); anchor helpers
- `src/extension.ts` — engine startup/dispose; event → debounced lifecycle.tick(); anchor cleanup in stopAll/deactivate
- `test/e2e/bridge-host.ts` — boot the engine so live E2E exercises it
- `package.json` — 0.4.2

## Alternatives considered

### One control client per agent session (sentinel-style streaming)

Gives `%output` streaming for attention, but costs N persistent processes plus
client lifecycle management coupled to agent spawn/kill. The attention pipeline's
latency is dominated by the 2.5s stability gate, so streaming buys almost nothing
the user can feel. Rejected for now; registered as the evidence-gated follow-up.

### Window-linking into a monitor session (one client sees all panes)

`link-window` mutates window structure shared with what users see and interacts
with kill-session semantics. Too invasive for a monitoring concern. Rejected.

### Keep polling, just lower the interval

No churn fix, no event latency, more tmux server load. Rejected.

## Risks and unknowns

- **Nested format loops in subscription formats** — documented pieces, undocumented
  combination; spike first (task 1), with a stated fallback path.
- **Reply/notification interleave** under concurrent exec — the protocol frames
  replies in order per client; the FIFO queue assumes that; spike verifies.
- **Anchor session lifecycle** — must survive nothing and leak nothing: created
  on engine start, killed on dispose; doctor() unaffected.
- **tmux < 3.2** has no `-B` subscriptions — engine detects and runs Phase 1 only.

## Research / citations

- github.com/tmux/tmux/wiki/Control-Mode — attachment scope (single session), notification list (NO pane-death event), `refresh-client -B name:what:format` + `%subscription-changed` (≤1/s), `%output` octal escaping, `%pause`/`pause-after` flow control (fetched 2026-06-10)
- tmux(1) FORMATS — `#{S:…}`/`#{W:…}`/`#{P:…}` loop constructs
- sentinel (github.com/opus-domini/sentinel) — control-mode-under-websocket architecture that motivated F20
