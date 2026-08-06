# 493 — doorbell-read-inbox — plan

_Drafted from `spec.md` on 2026-08-06. The approach, not the steps (those go in `tasks.md`)._

## Approach

Two additive changes, both inside the `notify_agent` witness path already in
`src/bridge/tools/communication-io.ts` — no change to `NoticeQueue`, `deliverNotice`, the
`working→idle` drain, or the TTL.

1. **Carry content in the existing durable record.** `DoorbellEvent` (`src/bridge/doorbell.ts`) gains
   two optional fields, `summary?: string` and `pointer?: string`. The three existing
   `appendDoorbellEvent` call sites in `notify_agent` (already-witnessed-before-validation paths
   included, matching current behavior) pass them through. No new file, no new directory, no schema
   migration — same JSONL, wider rows. Old rows without the fields still parse (both are optional).
2. **A read tool over that record.** `read_notices(agent, since?)`, registered next to `notify_agent` in
   the same file. Resolves `agent` the same way `notify_agent` does (`resolveDeclaredActor` — the
   Bridge-authenticated caller wins over a self-declared name). Filters `.tachyon/doorbells.jsonl` for
   `to === <resolved agent>` and `at > since` (default: a bounded recent window, not "everything ever" —
   see Key decisions), returns them oldest-first with each item's `at` so the caller can use the last
   `at` as next call's `since`. No new persisted cursor.

Alongside: two prose fixes (the `notify_agent` "queued … for idle delivery" receipt, and `spawn_agent`'s
"no need to tell it separately" promise), because both currently describe a stronger guarantee than the
channel gives, and the task that authorized this spec explicitly ties them to the same commit as the read
door — before the door exists, removing the promise leaves the coordinator with neither.

## Key decisions

- **Read-only over the existing witness log, not a new store** — chosen because the log already
  captures exactly the event this spec cares about (`notify_agent` was called, from X to Y, at T); adding
  a parallel "notice inbox" file would duplicate state and risk the two disagreeing. Rejected: a separate
  `notices/<agent>.jsonl` per-recipient file — more moving parts for no behavior the shared log doesn't
  already give, and it would need its own append-on-every-actor-that-can-notify wiring instead of reusing
  the one already in place.
- **Stateless cursor (`since` param), not a server-side read-receipt** — chosen because the measured need
  is "let me see what I missed," which a `since` timestamp answers exactly; a persisted "last read at"
  store per agent is new durable state this spec doesn't need, and edges toward the file-inbox/message-bus
  shape 341's other non-goals still forbid. Rejected: `mark_read`/ack tool — no measured requirement calls
  for it, and it multiplies the actor × trigger surface (what happens on restart, on multiple concurrent
  readers of the same name) for no benefit over "the caller remembers its own bookmark," which this
  project already does for continuity.
- **Scope: `agent-authored` origin only (i.e., exactly what `.tachyon/doorbells.jsonl` already
  witnesses today)** — chosen because it matches the measured incident precisely and because widening to
  `host-poke` origin would durably persist claims about live state that go stale the moment a child's
  state changes (see spec.md Non-goals — this is the `t-fb1453` distinction, not a new one invented here).
  Rejected: witness everything that reaches `deliverNotice` — bigger diff, and wrong for host-pokes
  specifically, not just larger for host-pokes.
- **No `to` parameter on `read_notices`** — chosen so the tool can only ever answer "what rang for me,"
  matching the self-notify boundary `notify_agent` already enforces in the other direction. Rejected:
  optional `to` for an operator/debugging view — nothing in the measured pain calls for cross-agent
  inspection, and it's a bigger trust boundary to open than this spec's evidence supports.
- **Amend 341 with a pointer, not a rewrite** — chosen because a shipped spec is the record of what was
  decided then (repository convention, and the explicit constraint on this task). Rejected: editing 341's
  non-goal bullet text directly, or flipping its `**Status:**` to `superseded` — 341's other three
  non-goals still hold, so the spec as a whole is not superseded, only amended in one place.

## Files touched

- `docs/specs/493-doorbell-read-inbox/spec.md`, `plan.md`, `tasks.md` — this spec.
- `docs/specs/341-notify-agent-idle-delivery/spec.md` — pointer + Amendments section, no text removed.
- `src/bridge/doorbell.ts` — `DoorbellEvent` gains `summary?`/`pointer?`; add a filtered reader
  (`to` + `since`) for the new tool to call.
- `src/bridge/tools/communication-io.ts` — pass `summary`/`pointer` into the three `appendDoorbellEvent`
  calls; register `read_notices`; reword the "queued … for idle delivery" receipt.
- `src/bridge/tools/fleet.ts` — reword `spawn_agent`'s delegation-contract promise.
- `test/unit/doorbell.test.ts` — cover the new fields and the filtered reader.
- `test/unit/bridge.test.ts` — cover `read_notices` end-to-end through the registered MCP tool (busy
  recipient, self-only, `since` filtering), alongside the existing doorbell/notify_agent tests it sits
  next to.

## Risks & unknowns

- **Unbounded log growth.** `.tachyon/doorbells.jsonl` already grows without rotation; this spec makes
  its rows wider (summary + pointer text) but does not change its lifecycle. Out of scope here — a
  pre-existing property of the file this spec reads from, not something this spec introduces. Worth a
  follow-up task if row count/size ever becomes a real problem, not a blocker for a read door.
  Verify early: confirm `at` sanitizing/truncation limits already applied to `summary` (500 chars per
  `notify_agent`'s own schema) bound the added size per row.
- **Default `since` window.** Omitting `since` needs a sane default (not "every doorbell ever rung in
  this workspace's history"). Plan: default to a bounded recent window (e.g., last 24h) with a hard cap on
  returned item count and a `truncated` flag, mirroring `get_task`'s `journalWindow` convention already in
  this codebase — verify against that precedent while implementing rather than inventing a new shape.

## Visual impact

None — this is a Bridge tool + JSONL record change, no rendered surface.

## Sources consulted

- `docs/specs/341-notify-agent-idle-delivery/spec.md` — the spec being partially superseded.
- `t-167b5c` task journal (`get_task`) — the ten-doorbell measurement and the owner's ratification.
- `src/bridge/doorbell.ts`, `src/bridge/tools/communication-io.ts` — current witness/append path.
- `src/bridge/NoticeQueue.ts` — origin distinction (`agent-authored` vs `host-poke`), TTL, per-target cap.
- `src/workspace/Workspace.ts` (`recoverOnIdle`, `flushQueuedNotice`, `deliverNotice`, `enqueueNotice`,
  `pokeParentOnDeath`, `pokeParentOnNeedsInput`, `pokeParentOnAuthRequired`) — the single drain window and
  every actor that currently reaches `deliverNotice`.
- `src/bridge/tools/fleet.ts` — the `spawn_agent` promise text.
- `test/unit/doorbell.test.ts`, `test/unit/notifyDoorbellDelivery.test.ts`, `test/unit/bridge.test.ts` —
  existing test shape/harness for this area.
- `docs/specs/320-persistence-handoff-candidates/spec.md` — precedent for how a superseded/amended spec
  records what changed in its `Closure`/status line, adapted here for a partial (non-goal-level) reversal.
