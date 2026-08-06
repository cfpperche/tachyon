# 493 — doorbell-read-inbox

_Created 2026-08-06._

**Status:** shipped
**Closure:** Implemented 2026-08-06 — `DoorbellEvent` (`src/bridge/doorbell.ts`) carries `summary`/
`pointer`; `readDoorbellEventsFor` reads them back self-only, oldest-first, capped at 200, filterable by
`since`. `read_notices` registered in `src/bridge/tools/communication-io.ts` next to `notify_agent`. The
`queued … for idle delivery` receipt and `spawn_agent`'s delegation-contract sentence were reworded in the
same commit, per the task's hard requirement that the promise not outlive the door. Verified with
`npx vitest run test/unit/doorbell.test.ts test/unit/bridge.test.ts test/unit/notifyDoorbellDelivery.test.ts
test/unit/auth.test.ts test/unit/bridgeToolCountLunaR1Behavior.gen.test.ts` and `npm run typecheck`.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Supersedes (named, partial)

This spec reverses the FIRST of four non-goals declared in
`docs/specs/341-notify-agent-idle-delivery/spec.md` (status `shipped`, unchanged). 341 itself is not
rewritten — its non-goal stays on the page as the record of what was decided then, with a pointer added
to this spec. Quoted verbatim:

> This is not a durable message bus. Queued notices are best-effort runtime state, not persisted project
> history.

**Why the reason expired.** 341 was written for a coordinator that goes idle between turns — the spec's
only drain window is the recipient's `working→idle` attention edge (`Workspace.ts`, the `AttentionMonitor`
state-change callback; currently `src/workspace/Workspace.ts:1457-1461`, `recoverOnIdle` →
`flushQueuedNotice`). That assumption held in July. It stopped holding in a continuous coordination
regime: `t-167b5c`'s journal records ten of ten `notify_agent` doorbells across four dispatch waves on the
night of 2026-08-05/06 arriving AFTER the coordinator had already merged the delivery and dismissed the
sending agent — delays of 1 to 8 minutes, every one of them self-reported in the notice text
("dismissed before you read this"). A coordinator that never goes idle never opens the one drain window,
so the notice becomes a receipt for a fact already learned some other way (a git-branch monitor, a pane
read) instead of the channel that delivers the fact. The owner ratified the reversal on 2026-08-06:
"podemos mudar sim o que foi recusado lá atrás, foi feito com o que tínhamos na época, agora a dor nos
mordeu e o software precisa evoluir."

**What the measurement does NOT show**, and why this stays narrow: no notice was lost, and the 10-minute
TTL never expired. The mechanism did exactly what 341 specified. What changed is the caller's regime, not
the mechanism's correctness — so the fix is a way to READ what the mechanism already recorded, not a
redesign of delivery.

## Intent

Today a coordinator has exactly one way to learn about a `notify_agent` doorbell rung while it was busy:
be idle at the instant delivery flushes. Miss that instant — because the coordinator stayed busy past the
10-minute TTL, or because Tachyon restarted and the in-memory delivery queue was lost — and the doorbell
is gone with no trail. `.tachyon/doorbells.jsonl` already durably witnesses every `notify_agent` call
(`from`, `to`, `at`), independent of whether the pane delivery ever lands — that's the half that already
exists. It just doesn't carry the message, and nothing reads it back.

Done means: the witness record carries the notice content (`summary`, `pointer`) alongside `from`/`to`/
`at`, and a new Bridge tool lets an agent cheaply ask "what rang for me, and since when?" — reading the
durable record instead of depending on having been idle at the right moment. This is a READ door onto
state that mostly already exists, not a new delivery path: pane delivery, the `working→idle` drain, the
per-target queue, and the 10-minute TTL are all unchanged.

## Actors × triggers

Who can cause a notice to reach `deliverNotice` (`src/workspace/Workspace.ts`), and which of those are
covered by this read door:

| Actor | Trigger | Origin (`NoticeQueue`) | Durably witnessed today | Covered by `read_notices` |
|---|---|---|---|---|
| Agent, via `notify_agent` | delegate/sibling/parent completion or nudge | `agent-authored` | yes (`from`/`to`/`at` only) | **yes — this spec adds content** |
| Tachyon, via backstop pokes (child-death, needs-input, rate-limited, auth-required) | child lifecycle/attention transition | `host-poke` | no | **no — deliberately excluded, see Non-goals** |
| Tachyon, via unbound relays (approval-decision relay, task-assignee wakeup, reload/session-summary) | human approval decision, task assignment, session reload | unbound (no `sourceChild`) | no | **no — out of scope, see Open questions** |
| Interface (human) | — | — | — | not a direct actor: humans reach agents through `write_input` (341 non-goal 4, unchanged) or through Tachyon-mediated relays (the row above), never by calling `deliverNotice` themselves |

Recipient lifecycle (create/restart/resume/dismiss/crash) does not gate what `read_notices` returns: the
witness log is keyed by the recipient's **name**, not a live session or incarnation — the same way
`hasDoorbellRung` already reads across restarts today. A coordinator that was dismissed and respawned
under the same name still sees notices rung for that name before the restart.

## Acceptance criteria

- [x] **Scenario: a busy coordinator reads a notice it never saw delivered**
  - **Given** agent `child` calls `notify_agent(to: "coordinator", summary: "t-abc done", pointer: "t-abc")` while `coordinator` is working, and `coordinator` never goes idle before the TTL would otherwise apply
  - **When** `coordinator` calls `read_notices(agent: "coordinator")`
  - **Then** the response includes an entry with `from: "child"`, the summary, the pointer, and an `at` timestamp — independent of whether the queued pane delivery ever flushed
- [x] **Scenario: durable across a Tachyon restart**
  - **Given** a notice was rung for `coordinator` and Tachyon's process then restarts (the in-memory `NoticeQueue` is empty again)
  - **When** `coordinator` calls `read_notices(agent: "coordinator")` with a `since` before the notice's `at`
  - **Then** the notice is still returned — the record lives in `.tachyon/doorbells.jsonl`, not in the process
- [x] **Scenario: cheap incremental polling**
  - **Given** `coordinator` previously called `read_notices` and received an item with `at: T1`
  - **When** `coordinator` calls `read_notices(agent: "coordinator", since: T1)`
  - **Then** only notices with `at` strictly after `T1` are returned — the caller owns the cursor (its own bookmark), no server-side read-receipt state is introduced
- [x] **Scenario: self only**
  - **Given** agent `A` calls `read_notices(agent: "A")`
  - **Then** only notices addressed `to: "A"` are returned; there is no parameter to read another agent's notices
- [x] A notify_agent sender's receipt, when the recipient is busy, states that the notice is durably recorded and readable via `read_notices` even if the pane delivery never lands or lands late — replacing the unqualified "queued '<x>' for idle delivery" phrasing.
- [x] `spawn_agent`'s description no longer promises a parent "no need to tell it separately" without qualification — it names the pane wake-up as the fast path and `read_notices` as the fallback for a coordinator that stays busy.
- [x] Host-poke-origin notices (child-death, needs-input, rate-limited, auth-required) are NOT written into the durable witness log — unchanged from today (unchanged code path; no new call site touches them).

## Non-goals

- **Still true, unchanged, not touched by this spec:** 341's other three non-goals stand.
  - "This does not make notices safe while a human is actively typing in the recipient pane" — unchanged; `humanDraftPresent`/held-human-draft handling is untouched.
  - "This does not redesign agent-to-agent coordination around a file inbox or runtime hooks." This spec
    does not build one either: `read_notices` is a read-only query over a log that already exists and
    was already durable for `from`/`to`/`at`; it adds two fields to that record and one read tool. There
    is no new addressed-file mailbox, no routing, no delivery semantics change.
  - "This does not change generic `write_input` behavior." Unchanged.
- **The 10-minute TTL is not touched.** The measurement that motivated this spec shows the TTL working
  correctly — ten of ten doorbells arrived before it, none lost. Reversing 341's persistence non-goal is
  not evidence for reversing its TTL decision; that would be fixing a mechanism that isn't broken.
- **Host-poke-origin notices stay excluded from the durable witness log.** `NoticeQueue`'s own
  `origin` distinction (`t-fb1453`) exists because a host-poke ("child X is waiting for input") is a claim
  about LIVE state that goes false the moment the child's state changes — persisting it and surfacing it
  hours later through `read_notices` would resurrect exactly the "dead child reaching out from beyond the
  grave" bug that origin-tagging was built to prevent. Widening the durable log to host-pokes is not a
  smaller version of this spec's fix; it would reintroduce a correctness bug this repository already paid
  to close.
- **No read-receipt / acknowledgment state.** `read_notices` does not mark anything "read" server-side.
  The caller's own `since` cursor (its bookmark, kept the same way continuity is already kept) is what
  "already read" means here. Adding a durable read-receipt store would be new persisted state beyond what
  the measured pain requires — the pain is "I can't see what rang," not "Tachyon should remember what I've
  seen."
- **No routing, subscriptions, or fan-out.** `read_notices` takes no target other than the caller's own
  resolved identity. It cannot be used to inspect another agent's notices.

## Open questions

- Unbound-relay notices (approval-decision relay, task-assignee wakeup, reload/session-summary line) are
  also currently non-durable and also currently un-witnessed in `.tachyon/doorbells.jsonl` — they are
  arguably the same class of "completed fact, not a live-state claim" as a `notify_agent` doorbell. This
  spec deliberately does not extend witnessing to them: doing so touches call sites beyond
  `communication-io.ts`'s `notify_agent` handler and beyond the measured incident (all ten delayed rings
  in the `t-167b5c` evidence were `notify_agent` completions). If the same blind spot is later measured
  for one of these origins, that is a new, separately-argued case — not an assumption to fold in here.
