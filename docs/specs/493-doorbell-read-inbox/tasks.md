# 493 — doorbell-read-inbox — tasks

_Generated from `plan.md` on 2026-08-06. Work top-to-bottom. Check boxes as tasks complete. If a task
reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] `docs/specs/341-notify-agent-idle-delivery/spec.md`: add a pointer line immediately after the first
      non-goal bullet (text of the bullet itself untouched) plus an `## Amendments` section at the end,
      dated, naming this spec and quoting the reason.
- [x] `src/bridge/doorbell.ts`: add `summary?: string` and `pointer?: string` to `DoorbellEvent`; add
      `readDoorbellEventsFor(workspaceRoot, agent, sinceIso?)` returning events with `to === agent`
      (and `at > sinceIso` when given), oldest-first, capped (see below) with a `truncated` signal.
- [x] `src/bridge/tools/communication-io.ts`: pass `summary`/`pointer` into all three
      `appendDoorbellEvent(...)` call sites in `notify_agent`. Register `read_notices` with inputs
      `agent` (resolved like `notify_agent`'s own `agent` param) and optional `since` (ISO 8601).
      Deviation from plan: no default time window when `since` is omitted (see `notes.md`) — capped at
      200 items, oldest-first, with `returned`/`truncated` in the response, mirroring `get_task`'s
      `journalWindow` shape.
- [x] `src/bridge/tools/communication-io.ts`: reword the `queued '${to}' for idle delivery` receipt to
      state the notice is durably recorded and readable via `read_notices` even if pane delivery never
      lands or lands late. Keep the existing `held-human-draft` branch's wording (unaffected).
- [x] `src/bridge/tools/fleet.ts`: reword the `spawn_agent` delegation-contract sentence — the
      unqualified "so YOU get woken up — no need to tell it separately" now names the pane wake-up as
      the fast path (spec 341) and `read_notices('<your name>')` as the fallback for a coordinator that
      stays busy past the drain window (spec 493).

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Busy-recipient scenario: `notify_agent` while target is working, then `read_notices` (no prior
      delivery) returns the summary/pointer/from/at.
- [x] Durable-after-restart scenario: events read back purely from `.tachyon/doorbells.jsonl` on a fresh
      `Workspace`/process (no reliance on in-memory `NoticeQueue` state).
- [x] `since` cursor scenario: a second `read_notices` call with `since` set to the first item's `at`
      excludes that item.
- [x] Self-only scenario: `read_notices` has no way to target another agent's notices.
- [x] Host-poke-origin notices (child-death etc.) do not appear in `.tachyon/doorbells.jsonl` and are not
      returned by `read_notices` — unchanged from today, asserted so a future change can't silently widen
      scope.
- [x] Reworded receipt/promise text asserted by string match in the relevant tool tests.

**Headless check:** `npx vitest run test/unit/doorbell.test.ts test/unit/bridge.test.ts && npm run typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

**Verify:** `npx vitest run test/unit/doorbell.test.ts test/unit/bridge.test.ts`
**Verify:** `npm run typecheck`

## Dogfood

**Dogfood-Opt-Out:** Bridge-tool-only change exercised end-to-end by the vitest MCP-client harness in
`test/unit/bridge.test.ts` (real tool registration + call path, fake tmux/host). No headless dogfood
scenario exists for a single new read-only tool call; a human dogfood route is listed below instead.

**Human dogfood:** Spawn a delegated child with `parent` set, let it call `notify_agent` while you (the
parent) are mid-turn on something else, then call `read_notices(agent: "<your name>")` once you're free
and confirm the summary/pointer show up even though you never watched for the idle-flush.

## Visual QA

**Visual QA Opt-Out:** no rendered surface — Bridge tool + JSONL record only.

## Cookbook

**Cookbook:** yes
<!-- new Bridge tool (read_notices) — a usable surface another agent/operator will invoke; add
     cookbook.md at ship time via sdd-cookbook.sh once the tool's shape is final. -->
