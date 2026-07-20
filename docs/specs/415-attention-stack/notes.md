# 415 — attention-stack — notes

_Created 2026-07-19._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- 2026-07-19 — Human ratified complete removal of Tachyon's native non-modal Notification Center usage. Sidebar Attention is primary and sole; no auxiliary bell/toast. Blocking modals and QuickPick remain.
- 2026-07-19 — Capacity is six visible cards. Overflow is FIFO with an explicit queued count. No timeout or auto-dismiss applies to Attention items.
- 2026-07-19 — Sidebar-closed behavior is passive badge/count only; nothing overlays the editor.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

- Persisting callback labels without executable closures preserves honest history after restart but means the human may need to navigate manually for an old actionable item. Reconstructing arbitrary closures would be unsafe and non-deterministic.

## Baseline

- Installed surface: Tachyon v0.56.75 in VS Code on 2026-07-19.
- Screenshot: `.tachyon/evidence/attention-stack/baseline-vscode.png` (workspace-local evidence channel).
- Current Sidebar has a compact `Notices` strip above tabs. Daemon presentation remains serialized by `noticePresentationActive`; passive info presentation races a four-second timer.
- VS Code native toasts cannot meet the requested capacity: upstream workbench code fixes three visible toasts and owns spam/lifetime behavior.

## Visual QA log

- 2026-07-19 — Headless Chrome preview, `sidebar:attention-overflow`, viewport 360×900, anchor: “single Sidebar surface, six simultaneous FIFO cards, explicit +N queued, no auxiliary toast.”
- First capture exposed that the 52vh container showed only about five cards. Raised the bounded stack viewport to `min(64vh, 600px)` and repeated the capture.
- Final verdict: **pass**. All six cards are visible before the section tabs; `+1 queued`, severity rails/tags, timestamps, duplicate count, action/unavailable state and dismiss controls remain legible.
- Durable evidence: `docs/specs/415-attention-stack/evidence/attention-overflow-360x900.png`.
- Worktree evidence attachment was unavailable because this is a task-owned managed worktree, not a worktree-agent record; the screenshot is therefore tracked with the spec.

## EDH handoff

- The official `Tachyon: Dev Host` F5 pointer is armed at spec 415 / slug `attention-stack`, resolving this worktree and an isolated fixture.
- Its private daemon state is preloaded with seven sanitized attention rows. Human validation steps: press F5, verify six cards plus `+1 queued`, confirm no native toast, dismiss one card and observe the seventh promote.
- No desktop visual judgment was performed. The earlier GUI launch exited without a live window; after the human clarified the rule, only headless visual evidence is agent-authored.
- 2026-07-19 — First human EDH attempt exposed malformed seeded notice ids causing the Sidebar projection to fail UUID validation. Production hardening in `5530df77` now rejects malformed persisted notice/action ids before projection; the fixture was reseeded with UUIDs.
- 2026-07-19 — Human reran the real EDH and confirmed all four checks: six cards plus `+1 queued`, passive badge after closing/reopening the Sidebar, no native toast, and immediate FIFO promotion after dismiss. Human verdict: “tudo funcionou”.

## Producer inventory

| Producer family | Examples | Destination | Rationale |
| --- | --- | --- | --- |
| Daemon/domain `EngineHost.notify` | needs-input, throttle, crash, verify failure, task/schedule proposal, Bridge/runtime/worktree failure | Durable Attention | May require human awareness/action and already has workspace ownership. |
| Blocking confirmations | delete/remove/force/recovery/approval prompts declared `modal: true` | Native modal | Safety boundary; must block for an explicit choice. |
| Choice prompts without `modal: true` | open docs/config/PR follow-up choices | QuickPick | Choice remains explicit without using Notification Center. |
| User-command acknowledgements | copied, saved, created, started, restarted, stopped, requirements OK | Status feedback | Immediate response to a human gesture; durable attention would be noise. |
| Shell validation/no-target feedback | no active workspace, nothing selected, already configured | Status feedback | Local and immediately actionable in command context; no durable domain event. |
| Shell infrastructure failures before workspace attach | persistent engine start/connection, Sidebar refresh | Status feedback plus logs | No canonical workspace host may exist yet; avoid a phantom queue owner. Once attached, domain failures use Attention. |
| Webview-local acknowledgements | pin/activity copied or pasted, panel refresh outcomes | Status feedback or inline panel state | User is already looking at the owning surface. |

Guardrail for new producers: use `EngineHost.notify` only for durable human attention owned by a workspace; use `modal: true` for safety confirmations; otherwise return inline/status feedback. Production code must not call VS Code's non-modal message APIs directly.

## Open questions

None at implementation start.

## Verification log

### 2026-07-20 — final candidate gates after EDH fix

- `npm run test:invariants` — pass: 1 invariant, 2 tests.
- `npm run typecheck` — pass.
- `npm run verify:full:quiet` — pass: 442 files, 5094 passed, 3 skipped.
- The preceding full-suite attempt hit one transient failure in `restartModesDogfood.test.ts`; all 6 tests in that file passed immediately in isolation, and the required full suite then passed cleanly.

### 2026-07-20T00:05Z — direct required gates

- `npm run test:invariants` — pass: 1 invariant, 2 tests.
- `npm run typecheck` — pass.
- `npm run verify:full:quiet` — pass: 442 files, 5094 passed, 3 skipped.
- Focused Attention suite — pass: 6 files, 68 tests.

### 2026-07-19T23:53:00Z — pass (2/2) — source: tasks.md
- `npm run typecheck` — pass
- `npm run verify:full:quiet` — pass

## Dogfood log

### 2026-07-20T00:01:41Z — fail (0/1) — source: tasks.md — commit: 5d87258423c4d681a743df697fec08ccab122226
- `npm run test:unit -- --run test/unit/attentionStack.dogfood.test.ts` — fail

### 2026-07-20T00:01:58Z — pass (1/1) — source: tasks.md — commit: 5d87258423c4d681a743df697fec08ccab122226
- `npx vitest run test/unit/attentionStack.dogfood.test.ts --maxWorkers=1` — pass
