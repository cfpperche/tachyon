# 202 — tachyon-control-mode — notes

_Created 2026-06-10._

_In-flight design memory for this spec — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

**Entry shape:** `### YYYY-MM-DD — <author> — <one-line title>` followed by free-prose body.

## Design decisions

### 2026-06-10 — parent — measured results (task 8)

Real-socket suite records **945ms** pane-death → dead-map event (inside the
documented ≤1/s subscription throttle; spike saw 483ms). In-extension worst case
= subscription (~1s) + 250ms debounce ≈ **1.3s** crash detection vs 3s+ tick
floor before; kill/spawn (`%sessions-changed`) ≈ instant + debounce. Steady
state runs zero tmux subprocesses (all calls ride the channel; integration
suite wall-time dropped 36s → 32s with the engine in the host). The 3s ticker
stays as heartbeat — events only accelerate, never replace.

### 2026-06-10 — parent — bare `;` passes unquoted

TmuxService composes compound invocations (`start-server ; set-option ; new-session`)
with `;` as a standalone argv element. On the line protocol a QUOTED ';' becomes a
literal argument — tmuxQuote special-cases the bare separator to preserve compound
semantics. Pinned by unit test.

### 2026-06-10 — parent — semantic vs transport errors

`%error` replies reject as TmuxError exactly like the subprocess path ("can't
find session" must keep failing!); only TransportError (client died mid-flight,
channel down) retries on the subprocess fallback. Conflating the two would make
real errors silently succeed on retry.

### 2026-06-10 — parent — task 1 spike results (tmux 3.6, real socket) — GATE PASSED

A) Nested format-loop subscription `deadmap::#{S:#{session_name}=#{W:#{P:#{?pane_dead,D#{pane_dead_status},A}}}|}`
fires `%subscription-changed` **483ms** after a pane dies, and the value carries
the exit code: `ctl=A|agent-a=D7|agent-b=A|`. Server-wide death detection with
ONE client + ONE subscription confirmed — better than planned (~1s budget).
B) Reply framing under 5 concurrent execs: strictly FIFO (`reply-0..4` in order).
C) `%sessions-changed` fires on kill-session. ✓
D) Quoting spike: single-quote wrapping with `'\''` for embedded quotes
round-trips spaces/quotes/$/;/#/backslash EXACTLY. The only transform observed
is `display-message -p` expanding `#{…}` formats — a property of that command
identical on the execFile path (panePid relies on it), not of the channel.
E) Constraint inherited from line framing: an argument containing a newline
cannot ride the protocol — the engine executor must detect and fall back.

## Deviations

## Tradeoffs

## Open questions

## Verification log

### 2026-06-10T21:51:59Z — pass (1/1) — source: tasks.md
- `bash -c 'cd packages/tachyon && npx vitest run --reporter=dot 2>&1 | tail -3'` — pass
