# 348 — bridge-delivery-hardening — tasks

_Generated from `plan.md` on 2026-07-03. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [ ] `write_input`: read `deps.attentionOf?.(name)` when `submit === true`; refuse with a structured `fail()` (recipient name + state + `refused-busy` tag + "use notify_agent or wait for idle") when the state is `working`/`throttled`/`needs-input` — no pane write.
- [ ] `write_input`: on the non-refused `submit === true` path, call `deps.tmux.sendSubmittedLine(session, text)` (fallback to `sendKeys(session, text, true)` if the method is absent), and return an `ok()` whose text carries a `submitted` receipt tag.
- [ ] `write_input`: leave `submit === false` behavior byte-for-byte unchanged (still raw `sendKeys(session, text, false)`); update only the tool `description` to document the busy-refusal and warn that `submit=false` leaves unsubmitted keystrokes that can land in/concatenate with a live composer.
- [ ] `update_task`: before calling `deps.tasks.update`, if the incoming `assignee` arg is a defined key on the patch, read `deps.tasks.get(id)` to capture the prior assignee for change-detection.
- [ ] `update_task`: after a successful `deps.tasks.update`, when `assignee` is a non-null string different from the prior assignee, best-effort dispatch a notice (`[tachyon] task <id> assigned to you: <title>`) at that name — gated by `manager.kindOf(name) === "agent"` and `tmux.hasSession(session)` (silent skip otherwise), dispatched via `deps.deliverNotice` when present else `deliverNoticeFallback`, wrapped so any thrown error is swallowed and never surfaces from `update_task`.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [ ] `write_input` submit=true against an idle/untracked recipient submits via the hardened path and reports `submitted`.
- [ ] `write_input` submit=true against working/throttled/needs-input is refused with a structured `refused-busy` error and no pane write.
- [ ] `write_input` submit=false stays raw regardless of attention state.
- [ ] `update_task` assigning to a live running agent fires exactly one notice.
- [ ] `update_task` assigning to a non-agent/not-running/unknown name updates the task with no notice and no error.
- [ ] `update_task` setting `assignee: null` fires no notice.
- [ ] `update_task` re-asserting the same assignee (no real change) fires no duplicate notice.
- [ ] Full unit suite green; `npm run typecheck` (main) and the webview typecheck both green; no `src/webview/**` or `src/tasks/TaskStore.ts` diffs; no version bump.

**Headless check:** `npm test -- test/unit/bridge.test.ts`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

**Verify:** `npm test -- test/unit/bridge.test.ts`
**Verify:** `npm run typecheck`

## Dogfood

**Dogfood:** `npm test -- test/unit/bridge.test.ts`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** pending — maintainer to exercise `write_input` against a real busy agent (expect refusal) and `update_task` assigning a live task to a running agent (expect the assignee's pane to receive the notice), per the CONSTRAINTS on this delivery (spec stays open, not closed, until this runs).

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

**Visual QA Opt-Out:** MCP tool-handler behavior only (`src/bridge/tools.ts`) — no UI/webview surface changes; `src/webview/**` is explicitly out of scope for this spec.
