# 341 — notify-agent-idle-delivery — plan

_Drafted from `spec.md` on 2026-07-03. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add a semantic notice delivery layer between Bridge tools and tmux pane input.

`notify_agent` will continue to compose and sanitize the envelope in `notifyAgent.ts`, but it will no longer call `tmux.sendKeys(..., true)` directly. Instead, Bridge receives a `deliverNotice` dependency from `Workspace`. The delivery layer checks the current attention state:

- `idle` or unknown monitor state: submit now through a hardened helper.
- `working` or `throttled`: enqueue the notice and return a queued result.
- `needs-input`: enqueue rather than submit, because the recipient may be at a permission or confirmation prompt.

`Workspace` owns a bounded in-memory `NoticeQueue`, because it owns attention transitions and lifecycle events. The existing idle monitor branch flushes one queued notice per idle wake, serialized through the same `recoverOnIdle` path so automatic recovery injections and notice delivery cannot interleave. Delivery happens before recovery injections; if the notice starts a turn, recovery waits for a later idle.

`TmuxService` gets a narrow helper for semantic notices. The helper sends literal text, waits briefly before the first Enter, captures the pane, and only retries Enter if the exact line still appears to be stranded. This avoids a blind second Enter that could accept an unrelated prompt in fallback/no-monitor cases.

## Key decisions

- **Queue busy recipients** — chosen because the observed failure is caused by typing while the recipient TUI is mid-turn; rejected immediate double-Enter because it can still leave drafts or hit prompts.
- **Flush only on idle** — chosen because idle is the safest existing signal for ordinary composer input; rejected `needs-input` because it may be a permission/confirmation prompt.
- **One notice per idle wake** — chosen to avoid starting a burst of turns or interleaving with recovery injections; rejected draining the full queue in one idle transition because the first notice may immediately make the recipient busy.
- **Bounded, ephemeral queue** — chosen because `notify_agent` remains best-effort pane delivery; rejected persistence because that would become a new durable inbox feature.
- **Drop oldest on overflow** — chosen because newer status is usually more relevant; log the drop so the loss is visible during debugging.
- **Capture-verify-retry helper** — chosen because it directly targets the stuck-composer symptom; rejected blind delayed `C-m` because it can submit/accept something unrelated when state is stale.

## Files touched

- `src/bridge/NoticeQueue.ts` — pure bounded queue with TTL cleanup.
- `src/bridge/tools.ts` — add `deliverNotice` dependency and route `notify_agent` through it.
- `src/tmux/TmuxService.ts` — add hardened submitted-line helper for semantic notices.
- `src/workspace/Workspace.ts` — own the queue, flush on idle, clear on lifecycle events, and route death-pokes through the same path.
- `test/unit/noticeQueue.test.ts` — pure queue behavior.
- `test/unit/tmux.test.ts` — hardened helper command sequence and retry behavior.
- `test/unit/bridge.test.ts` / `test/unit/workspaceHeadless.test.ts` — tool and lifecycle behavior.
- `docs/specs/341-notify-agent-idle-delivery/*` — spec contract, plan, tasks, and notes.

## Risks & unknowns

- Attention state is sampled and can be stale. Tool docs must keep the caveat that a human actively typing can still race the automation.
- Capturing the pane after submit is heuristic. Tests should prove retry is conditional, but real Claude/Codex dogfood is still needed.
- Queue TTL trades off missed delivery versus stale delivery. Prefer discarding stale notices over injecting into an unrelated later conversation.
- Death-pokes become queued too, so a busy parent may receive crash information later rather than immediately.

## Visual impact

No UI layout changes. The visible behavior is terminal delivery timing and the Bridge tool result text.

## Sources consulted

- `src/bridge/tools.ts` — current `notify_agent` validation and direct `sendKeys(..., true)` delivery.
- `src/tmux/TmuxService.ts` — current literal paste plus single `C-m` implementation.
- `src/workspace/Workspace.ts` — attention monitor idle branch, recovery serialization, and death-poke wiring.
- `src/agents/AgentManager.ts` — existing note that a leftover `notify_agent` draft can block Claude graceful stop.
- `docs/specs/332-notify-agent-a2a/*` — original A2A notice contract and its optimistic live-pane assumptions.
- Pin `p-c77b48` and ad-hoc Claude Fable review `fable-notify-submit-review` on 2026-07-03.
