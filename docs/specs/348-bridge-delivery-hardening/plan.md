# 348 — bridge-delivery-hardening — plan

_Drafted from `spec.md` on 2026-07-03._

## Approach

Two independent, additive changes in `src/bridge/tools.ts` (the Bridge MCP tool layer). No new files, no store changes.

**1. `write_input` hardening (t-12ec8a, option a).** Inside the `write_input` handler:
- `submit === false`: unchanged — `deps.tmux.sendKeys(session, text, false)`, just a description update.
- `submit === true`: read `deps.attentionOf?.(name)` (the same accessor `notify_agent`'s busy check and `executeWait` already use). If the state is `"working" | "throttled" | "needs-input"`, return a structured `fail()` — no pane write at all — naming the recipient, its state, and pointing at `notify_agent`/idle-wait, with a `refused-busy` tag in the message text so the receipt is greppable. Otherwise (idle, or `attentionOf` returns `undefined` because monitoring isn't tracking this target — the same "untracked = safe" convention `Workspace.deliverNotice` already uses for its idle/undefined branch) call `deps.tmux.sendSubmittedLine(session, text)` when the method exists (real `TmuxService` always has it; only a minimal test double might not), falling back to `sendKeys(session, text, true)`. Return an `ok()` whose text embeds a `submitted` receipt tag.

**2. `update_task` assign-notice (t-ea86e6, composes with 332/341).** Inside the `update_task` handler, after `deps.tasks.update(...)` succeeds: if the incoming `assignee` argument is a non-null string AND it differs from the task's assignee *before* this update, best-effort fire a notice at that name reusing the exact `deliverNotice`-or-`deliverNoticeFallback` dispatch `notify_agent` already uses (so a busy assignee queues instead of getting an interrupted paste, per 341). Guard with the same `manager.kindOf(name) === "agent"` + `tmux.hasSession(session)` checks `notify_agent` uses, so a terminal, unknown, or stopped target is silently skipped (assignment must not depend on whether the assignee happens to be online). Wrap the notify step in try/catch so a delivery failure can never surface as an `update_task` error — assigning a task must not depend on notification succeeding.

To detect "assignee actually changed," read the task's current state with the store's existing synchronous `get(id)` **before** calling `update`, and compare `before.assignee` to the incoming `assignee` param (not the patched-in-place object, since `update`'s return already reflects the new value).

## Key decisions

- **Refuse-in-busy, not queue, for `write_input`** — chosen because `write_input` is a direct command gesture (an operator/agent typing into a specific pane on purpose); silently changing *when* that lands (queue-and-flush-later, as 341 does for the semantic `notify_agent` channel) would be a worse surprise than today's blind paste. Rejected: mirroring 341's queue-on-busy for `write_input` too — that was 341's own explicit non-goal (`this does not change generic write_input behavior`), and t-12ec8a's author (claude) called out the queue-changes-semantics-silently risk directly in the task body.
- **`needs-input` also refuses** — chosen for symmetry with 341 (`needs-input is not safe` is one of 341's own acceptance scenarios for `notify_agent`); a target waiting on a prompt is exactly the state where an unrelated keystroke landing mid-prompt is most dangerous. Rejected: treating `needs-input` as "safe to type into" (it's arguably the state a human deliberately drives `write_input` for) — but the task body is explicit ("needs-input tambem recusa (mesma regra da 341)"), so this is a ratified decision, not an open question.
- **`attentionOf` returning `undefined` is treated as safe-to-submit** — chosen because it matches `Workspace.deliverNotice`'s own existing branch (only `working`/`throttled`/`needs-input`/`recoveryInFlight` divert; anything else, including a target the monitor isn't tracking, submits). Rejected: failing closed on unknown state — that would make `write_input` unusable against any entry attention-monitoring is disabled for (e.g., attention off in config), which is a real, common, non-busy case.
- **Receipt is a text-embedded tag (`submitted` / `refused-busy`), not a JSON envelope** — chosen for consistency with every other simple confirmation in `tools.ts` (`` `input sent to '${name}'` ``, `` `notified '${to}'` ``, etc. are plain strings, not JSON); `notify_agent` itself only returns JSON when the payload is a genuine object (task/pin), never for a one-line confirmation. Rejected: wrapping the result in `JSON.stringify({...})` — inconsistent with the sibling tool and unnecessary since the receipt only needs to be greppable, not machine-parsed by another tool call.
- **Assign-notice lives in the `update_task` handler, not `TaskStore`** — chosen per the task's own constraint and rationale: `TaskStore` is a headless entity store with zero knowledge of live agents/sessions; teaching it about `AgentManager`/`TmuxService` would break that boundary for one feature. Rejected: a `TaskStore` "on assign" hook/event emitter — over-engineered for a single Bridge-side side effect, and it would still need the Bridge to supply the agent-liveness check anyway.
- **Change-detection reads `get(id)` before `update`, not an event from the store** — chosen because it's a single extra synchronous local read (`TaskStore.get` is a plain `fs.readFileSync`-backed call), no store change needed, and it directly answers "did assignee change" without inventing new plumbing. Rejected: comparing `expect.assignee` (the caller's optimistic-lock precondition) — that field is optional and caller-supplied, not authoritative; a caller could omit it and get no comparison signal.
- **A stopped/declared-but-not-running assignee is a silent skip, not an error** — chosen because assignment is a valid state, independent of whether the assignee is currently online (matches `notify_agent`'s own "not running" gate conceptually, but here the caller isn't notify_agent — they're just assigning a task and shouldn't be blocked by delivery mechanics). Rejected: surfacing a warning in the `update_task` result — adds noise to the common case (assigning to a human, or an agent that'll start later) for no actionable benefit.

## Files touched

- `src/bridge/tools.ts` — `write_input` handler (busy-refusal + hardened submit path + description update); `update_task` handler (assign-notice best-effort dispatch); one small shared helper for the assign-notice compose+dispatch (mirrors `deliverNoticeFallback`'s existing shape).
- `test/unit/bridge.test.ts` — update the existing `write_input lands in the sibling's session` case (its current target, `"claude"`, is stubbed `needs-input` in this fixture and would now be refused) to exercise an idle target instead; add cases for busy-refusal, submit=false-stays-raw, and the `update_task` assign-notice's 4 scenarios (live agent / non-agent-or-not-running / unassign / no-op re-assign).
- `docs/specs/348-bridge-delivery-hardening/*` — this spec.

## Risks & unknowns

- The one pre-existing test that calls `write_input` targets `"claude"`, whose `attentionOf` stub in `bridge.test.ts` is hardcoded to `"needs-input"`. That test must be repointed at an idle/untracked target or it starts failing the moment busy-refusal ships — treated as an expected, in-scope test update, not a regression.
- `deps.attentionOf` and `deps.deliverNotice` are optional on `BridgeDeps` (some hosts may not wire them). `write_input` must degrate sanely when `attentionOf` is absent (treat as untracked → safe, same as `undefined` state) and `update_task`'s assign-notice must degrade to `deliverNoticeFallback` when `deliverNotice` is absent (already the pattern `notify_agent` uses).

## Visual impact

None — both changes are MCP tool-handler behavior with no UI/webview surface. (Confirmed against the constraint: `src/webview/**` is out of scope for this spec.)

## Sources consulted

- `docs/specs/341-notify-agent-idle-delivery/{spec,notes}.md` — the busy/idle queue-and-flush contract this reuses for `update_task`'s assign-notice, and the explicit non-goal (`write_input` unchanged) this spec now closes.
- `docs/specs/332-notify-agent-a2a/spec.md` — the `notify_agent` envelope/provenance/gating contract (`kindOf === "agent"`, `hasSession`, self-notify rules) mirrored for the assign-notice's liveness check.
- `src/bridge/tools.ts` — current `write_input` (~L685-708), `notify_agent` (~L710-749), `update_task` (~L898-932), `deliverNoticeFallback` (~L312-319), and the `BridgeDeps` shape (`attentionOf`, `deliverNotice`, `manager`, `tmux`).
- `src/workspace/Workspace.ts` — `deliverNotice`/`enqueueNotice`/`flushQueuedNotice`/`submitNoticeLine` (~L1331-1368), the real host-side implementation of the busy/idle branch being reused.
- `src/attention/AttentionMonitor.ts` — the `AttentionState` union (`working | idle | needs-input | throttled`) and its transition rules.
- `src/tmux/TmuxService.ts` — `sendKeys` vs `sendSubmittedLine` (~L594-624), confirming the hardened path is a drop-in replacement for a raw submit.
- `src/tasks/TaskStore.ts` / `src/tasks/types.ts` — confirmed `get`/`getView` are synchronous local reads and `assignee` is nullable on both `Task` and `TaskUpdateInput`.
- `test/unit/bridge.test.ts` — existing fixture wiring (`attentionOf`, `deliverNotice`, `noticeMode`) and the current `write_input`/`notify_agent`/`update_task` test coverage this spec extends.
