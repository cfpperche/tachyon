# 415 — attention-stack

_Created 2026-07-19._

**Status:** shipped
**Closure:** Attention Stack integrated on `main` by merge `144b9981`; automated and human EDH evidence is recorded in `notes.md`, with the headless capture under `evidence/attention-overflow-360x900.png`.
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
**Dogfood:** `npx vitest run test/unit/attentionStack.dogfood.test.ts --maxWorkers=1`
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Tachyon currently serializes daemon notices through VS Code's native Notification Center. VS Code owns that surface's capacity, ordering, and lifetime (including a hard maximum of three visible toasts), so independent agent events arrive one-by-one and the human cannot compare parallel requests. Tachyon also races passive notices against a four-second timer, which advances its queue without proving that the human saw the message.

Replace that channel with a Tachyon-owned **Attention Stack** in the primary Sidebar. It is the single non-modal source of truth: at most six oldest open items are visible together, later items wait in FIFO order, and only an explicit dismiss, clear, resolution, or action promotes the next item. The Sidebar view badge remains a passive count when the view is closed. Native modal confirmations and QuickPick remain valid; user-initiated acknowledgements use transient status feedback and never become attention debt.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: six parallel items with FIFO overflow**
  - **Given** an empty Attention Stack
  - **When** seven distinct notices arrive before the human acts
  - **Then** the six oldest notices are visible, the surface reports one queued item, and no Tachyon native toast is opened
- [x] **Scenario: promotion requires a human or domain resolution**
  - **Given** six visible notices and at least one queued notice
  - **When** the human dismisses a visible notice or invokes its action
  - **Then** that notice is removed exactly once and the oldest queued notice becomes visible
- [x] **Scenario: unattended notices survive restart**
  - **Given** open notices in the daemon-owned stack
  - **When** the editor shell disconnects or the persistent engine restarts
  - **Then** the notices remain ordered and visible after reconnect; callback actions that cannot survive restart are shown as unavailable rather than re-executed
- [x] **Scenario: exact duplicate collapse**
  - **Given** an open notice
  - **When** the same level and normalized message arrive inside the dedupe window
  - **Then** one item remains in its original FIFO position with an incremented occurrence count
- [x] **Scenario: closed Sidebar**
  - **Given** at least one open attention item and the Tachyon Sidebar closed
  - **When** more notices arrive
  - **Then** no pop-up overlays the editor and the Sidebar view badge reflects the total open count
- [x] **Scenario: modal confirmation remains modal**
  - **Given** a destructive or blocking confirmation declared with `modal: true`
  - **When** it is requested
  - **Then** VS Code presents the modal and the operation still requires an explicit choice
- [x] **Scenario: shell acknowledgement is ephemeral**
  - **Given** a user-initiated command completes with a simple acknowledgement and no follow-up action
  - **When** the shell reports success
  - **Then** feedback appears in the status area and does not add an Attention item or a native notification
- [x] The Sidebar renders accessible notice cards with keyboard-reachable actions, level semantics, timestamps, duplicate counts, and reduced-motion-safe styling.
- [x] No Tachyon production path calls VS Code's non-modal `showInformationMessage`, `showWarningMessage`, or `showErrorMessage`.
- [x] The open-item cap remains bounded at 100 and persistence rejects malformed stored rows safely.

## Non-goals

- Replacing blocking VS Code modals, QuickPick, input boxes, progress UI, or editor diagnostics.
- Adding auto-dismiss or timeout semantics to Attention items.
- Adding a second bell, native toast, operating-system notification, or editor overlay.
- Turning every success acknowledgement into durable attention.
- Building a separate full-history Control panel in this slice; the Sidebar owns the active queue and the daemon store is the canonical source.
- Synchronizing attention across different machines or users.

## Open questions

None. The human ratified the surface, capacity, FIFO policy, absence of auto-dismiss, and removal of native non-modal notifications before implementation.
