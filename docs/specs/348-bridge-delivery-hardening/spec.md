# 348 — bridge-delivery-hardening

_Created 2026-07-03._

**Status:** shipped
**Closure:** Implemented 2026-07-03 — `write_input`'s `submit=true` path now consults `deps.attentionOf` and refuses (structured `refused-busy` error) against working/throttled/needs-input recipients instead of a raw `sendKeys` paste, routing the safe path through `TmuxService.sendSubmittedLine`; `submit=false` is unchanged bar the tool description. `update_task` now fires a best-effort assign notice (via `deliverNotice`/fallback) when a patch changes `assignee` to a live running agent. Both in `src/bridge/tools.ts` only. Verified: `npm test -- test/unit/bridge.test.ts` (40/40) + `npm run typecheck` (main+webview+browser-test), see `notes.md`. Human dogfood is a documented maintainer follow-up (`tasks.md`) — not run in this session, so this spec is NOT closed yet.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

_Origin: task t-12ec8a (residual of the t-8f86e2 verification of spec 341) and task t-ea86e6 (found during the same flow exercise). Both harden a Bridge delivery path that currently either types blind or stays silent._

Spec 341 hardened `notify_agent`: busy recipients (working/throttled/needs-input) queue instead of getting a raw paste-and-Enter, and delivery goes through `TmuxService.sendSubmittedLine` with capture-based retry. `write_input` was explicitly left alone by 341 (`this spec only changes semantic notices`) — it still does `tmux.sendKeys(session, text, submit)` unconditionally. That is the exact shape of the trap 341 fixed: evidence 4 of the t-8f86e2 dossier was a `claude` envelope stuck in a busy composer, captured 18:27, with 341 already installed — because it arrived via `write_input`, not `notify_agent`.

`write_input` is a direct command gesture (an operator typing into a specific pane on purpose), so the fix is NOT to queue it silently the way `notify_agent` queues — silently changing when a command lands would be worse than the current bug. Instead, `submit=true` (the default) now routes through the same hardened submit path as 341 and refuses outright, with a structured error, when the recipient's attention state is `working`, `throttled`, or `needs-input`. The caller is told to use `notify_agent` (which queues) or wait for idle. `submit=false` (type without pressing Enter) keeps its current raw behavior — it cannot get "stuck" mid-submit because it never submits — but the tool description now warns that typed-but-unsubmitted text can land in a live composer.

Separately, task assignment is silent today: `update_task` can set `assignee` to any agent name, and that agent only learns about it by polling `next_task`/`list_tasks`. Composing with 332's `notify_agent` primitive, `update_task` now fires a best-effort notice at the new assignee when the patch actually changes `assignee` to a name that resolves to a live, running agent (declared or ad-hoc) — reusing the same `deliverNotice`-or-fallback delivery 341/332 already built, so a busy assignee gets queued rather than an interrupted paste.

Both changes live in the Bridge tool handlers (`src/bridge/tools.ts`), not in `TaskStore` or the webview: `TaskStore` is a headless entity store with no concept of a live agent, and the notification is delivery policy, not task state.

## Acceptance criteria

- [x] **Scenario: write_input submit=true against an idle/untracked recipient**
  - **Given** a running agent target whose attention state is idle, or not yet tracked by the monitor
  - **When** another agent calls `write_input(name, text, submit: true)`
  - **Then** Tachyon sends the text through the hardened submit path (`TmuxService.sendSubmittedLine` when available) and the result reports a `submitted` receipt
- [x] **Scenario: write_input submit=true against a busy recipient is refused, not queued**
  - **Given** a running agent target whose attention state is `working`, `throttled`, or `needs-input`
  - **When** another agent calls `write_input(name, text, submit: true)`
  - **Then** Tachyon does NOT type into the pane, returns a structured error naming the recipient and its busy state, carrying a `refused-busy` receipt, and pointing the caller at `notify_agent` or waiting for idle — no silent queueing, because `write_input` is a direct command gesture
  - **AMENDED by t-8605be** (see `notes.md`): including `needs-input` in this refusal, combined with `notify_agent`'s own (correct) needs-input refusal from 341, made a child stuck on an interactive prompt unreachable by any agent tool. `write_input` now refuses only `working`/`throttled`; `needs-input` is allowed (answering the prompt is its most legitimate use), optionally flagged `answering: true` for a `answered-prompt` receipt. This checkbox records what 348 shipped, not the current behavior.
- [x] **Scenario: write_input submit=false stays raw**
  - **Given** any running agent target, busy or idle
  - **When** another agent calls `write_input(name, text, submit: false)`
  - **Then** Tachyon types the literal text with no Enter, exactly as before 348 — attention state is not consulted
- [x] The `write_input` tool description warns that `submit=false` leaves raw, unsubmitted keystrokes that can land in or concatenate with a live composer.
- [x] **Scenario: update_task assigns to a live running agent**
  - **Given** a task whose `assignee` is not currently `"sibling"`, and `"sibling"` is a running agent
  - **When** another caller runs `update_task(id, { assignee: "sibling" })`
  - **Then** the task updates normally AND `"sibling"` receives one best-effort notice naming the task id and title (queued if `"sibling"` is busy, delivered immediately if idle)
- [x] **Scenario: update_task assignee target is not a live agent**
  - **Given** `assignee` is set to a name that is not a running agent (unknown, a terminal-kind entry, or a declared-but-stopped agent)
  - **When** `update_task` sets `assignee` to that name
  - **Then** the task update still succeeds and no notice is attempted (no error surfaced to the caller from the notify step)
- [x] **Scenario: update_task assignee unset (unassign)**
  - **Given** a patch that sets `assignee: null`
  - **When** `update_task` applies it
  - **Then** no notice fires
- [x] **Scenario: update_task re-asserts the same assignee**
  - **Given** a task already assigned to `"sibling"`
  - **When** `update_task(id, { assignee: "sibling" })` is called again with no actual change
  - **Then** no duplicate notice fires
- [x] A failure in the best-effort assign-notice (delivery throws) never fails the `update_task` call itself.
- [x] Neither change touches `src/webview/**` or `src/tasks/TaskStore.ts` — the notification is composed and dispatched from the Bridge tool handler.
- [x] Full unit suite and both typechecks (main + webview) stay green; no version bump. (See `tasks.md` verification note: one unrelated, pre-existing `webviewPreviewCatalog` failure traced to concurrent uncommitted spec-349 work in this shared workspace, not this spec's diff.)

## Non-goals

- Does not change `notify_agent`'s own queueing/delivery semantics (341/332 already shipped that) — this only gives `write_input` an explicit refusal and reuses the existing delivery plumbing for task-assign notices.
- Does not add a durable "assignment history" or read-receipt for the assign notice — it is the same best-effort, ephemeral pane notice class as `notify_agent`, not a persisted inbox.
- Does not change task-store semantics (transitions, CAS `expect`, rank) — `TaskStore` itself is untouched.
- Does not add attention-state polling or retries beyond what `TmuxService.sendSubmittedLine` already does.

## Open questions

- None hard — the maintainer's dogfood (human, pending) is the remaining open item before this spec closes; see `tasks.md`.
