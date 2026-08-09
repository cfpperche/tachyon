# 221 — tachyon-resume-readiness

_Created 2026-06-15._

**Status:** SHIPPED v0.19.0 (2026-06-15, commit `d85738b`). codex dueto 2 rounds (round-1: 1 MAJOR + 1
MINOR fixed; round-2 SHIP), 482 tests + typecheck green.
**Closure:** honest resume badge (`· resumable` vs `· fresh start`) via a read-only `resumeReadiness`
probe mirroring `resume()`'s pre-flight; no mechanism change.

**Verify:** `npm run typecheck && npx vitest run` (safe with `$TMUX` set — spec 218 guard)

**UI impact:** ui (sidebar badge text/tooltip for stopped/crashed agents).

## Intent

**Make the sidebar's `resumable` badge HONEST about whether ↻ will actually restore context.** Today a
stopped/crashed agent shows `· resumable` whenever its ledger row `isResumable` (has a runtime+adapter)
— but that does NOT check the transcript is on disk. After spec 220 we know the resume can still
degrade to a fresh start (transcript pruned, never captured, or a capture miss). So the badge promises
context it may not deliver — the exact silent surprise 220 fixed at the mechanism level; this surfaces
it at a glance, BEFORE the click.

## Design

A read-only readiness probe that mirrors `resume()`'s pre-flight (id resolution + transcript-exists),
WITHOUT spawning, then a tri-state badge.

- **`AgentManager.resumeReadiness(name, record): Promise<boolean>`** — true when a resume would land
  WITH context. Mirrors `resume()`: resolvesWithoutId (qwen) → true; claude name→uuid via
  `resolveCurrentSession(title)`; empty id → `resolveCaptureId`; then `fileExists(transcriptPath)`
  when derivable, else true (capture runtime with an id but no derivable path → resume attempts it).
  Read-only; no tmux, no spawn. Cheap in the common case (a stopped agent that went through Stop has a
  captured uuid → a single `stat`); only an uncaptured-NAME claude row does the title scan.
- **Sidebar** probes each resumable agent (Promise.all, like the verify badge — a small set) and
  passes a `resumeReady?: boolean` to `AgentTreeItem`.
- **`AgentTreeItem`** (stopped + crashed states): `resumable && resumeReady === false` →
  `· fresh start` (no saved context) with a tooltip that ↻ will start fresh; otherwise `· resumable`
  (context) as today. `undefined` (unprobed) keeps today's behavior — backward-compatible.

## Non-goals
- No change to resume/spawn mechanics (220 owns those) — this is pure visibility.
- No new disk format / no persisting readiness (it's a live probe; the ledger stays the source).

## Acceptance
- A stopped claude agent whose transcript is on disk → `· resumable`; one whose transcript is gone
  (or never captured) → `· fresh start`, with a tooltip explaining ↻ starts fresh.
- `resumeReadiness` mirrors `resume()`'s resolution exactly (qwen→true; claude name→title-resolve;
  capture→resolveCaptureId; transcriptPath+fileExists) and never spawns. Unit-tested.
- Sidebar passes the probed state; `undefined` (unprobed) renders as today (no regression).
- codex dueto → SHIP; ship 0.19.0.
