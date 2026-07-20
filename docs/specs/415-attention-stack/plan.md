# 415 — attention-stack — plan

_Drafted from `spec.md` on 2026-07-19. The approach, not the steps (those go in `tasks.md`)._

## Approach

Make the daemon notice inbox the canonical Attention queue. Load and validate it from `DaemonStateStore`, persist every enqueue/dedupe/dismiss/action mutation atomically, and keep action callbacks live only in memory. Remove the daemon-to-shell `notice.present` broker path entirely, so shell attachment is no longer involved in notice ordering or progress.

Project the complete ordered open queue to the Sidebar. The webview globally orders multi-root items oldest-first, renders the first six as cards, and reports the remaining count. The `WebviewView.badge` mirrors the total open count even when the view is not visible. Existing notice action dispatch remains the exactly-once execution boundary.

Split shell notification behavior by intent at the central provider: `modal: true` retains VS Code's modal API; non-modal requests without choices become transient status-bar feedback; non-modal choice prompts use QuickPick. Engine/domain notices continue through `EngineHost.notify` and therefore enter the durable Attention Stack. Inventory producers and document their intended class so later additions have an explicit routing rule.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Sidebar Attention Stack is the sole non-modal attention surface** — it is Tachyon-controlled and can display six parallel items; rejected native Notification Center because VS Code fixes capacity/order/lifetime and rejected an auxiliary bell because it creates two sources of truth.
- **Oldest-first active queue with six-card window** — preserves FIFO and makes promotion deterministic; rejected newest-first because a busy producer could starve earlier requests.
- **No automatic dismissal** — unread attention is human/domain-owned state; rejected the existing four-second race because completion was not evidence of visibility.
- **Persist data, not callbacks** — messages and ordering survive daemon restart while non-serializable action closures become unavailable; rejected replaying action ids without callbacks because it would imply a false executable state.
- **Central shell feedback split** — preserves modal safety and keeps acknowledgements lightweight while eliminating all non-modal native messages; rejected bulk-converting shell acknowledgements into attention because it would create permanent noise.
- **Keep the legacy protocol removal atomic in this release** — packaged shell and engine are build-coupled, so leaving an unused presentation request would preserve misleading architecture and tests.

## Files touched

- `src/workspace/DaemonEngineHost.ts`, `noticeInbox.ts` — persistent FIFO queue, validation, exact-once mutations; remove presentation broker.
- `src/engine-service/protocol.ts`, `src/shell/WorkspaceClient.ts`, `src/extension.ts` — remove `notice.present` transport and shell handler.
- `src/workspace/notify.ts`, `NotificationService.ts` — modal/status/QuickPick routing without native non-modal messages.
- `src/webview/SidebarPrototype.ts` — passive native view badge sourced from the projected open count.
- `src/webview/sidebar/App.tsx`, `sidebar.css` — six-card Attention Stack, FIFO overflow, accessible actions.
- `test/unit/*notification*`, `daemonEngineHost`, `workspaceClient`, `engineServiceProtocol`, `sidebarPrototype` — behavior and structural regression coverage.
- `docs/specs/415-attention-stack/notes.md` — producer inventory, baseline, and dogfood evidence.

## Risks & unknowns

- Action callbacks cannot survive a daemon process restart. Persisted rows must state that honestly and must never execute an action more than once.
- A multi-root Sidebar merges per-workspace queues; stable timestamp plus workspace/id tie-breaking is required for deterministic order.
- A global shell notice may occur before any workspace is attached. Status feedback must remain available without inventing a phantom durable owner.
- Status messages can overwrite one another under heavy shell-command activity; that is acceptable only for the classified ephemeral producer set.
- Removing the protocol variant touches compatibility tests and snapshot guards; packaged build coupling must stay green.

## Visual impact

The current one-line `Notices` strip becomes an `Attention` stack of up to six compact cards. Visual risks are excessive vertical capture, truncated actions, poor level contrast, and ambiguous queued count. Capture baseline and final screenshots from the installed VS Code surface at 2560×1528, including a seven-item overflow case and keyboard/action inspection.

## Sources consulted

- `src/workspace/DaemonEngineHost.ts` and spec 397 inbox behavior.
- `src/webview/sidebar/App.tsx` current `NoticeStrip` and Sidebar projection.
- VS Code `WebviewView.badge` API in the pinned `@types/vscode` dependency.
- VS Code workbench notification implementation: native toast maximum three, spam limiter three per 800 ms, level-based purge timers.
- Human decisions recorded in task `t-42b37b` journal on 2026-07-19.
