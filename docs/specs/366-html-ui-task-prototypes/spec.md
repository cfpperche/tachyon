# 366 - html-ui-task-prototypes

_Created 2026-07-09 from task `t-119dc1` and its design-review journal. Folded with the Claude Fable
adversarial review in `.tachyon/reviews/366-html-ui-task-prototypes-fable.md`._

**Status:** shipped
**Closure:** 2026-07-12 — Static-only v1 of HTML UI task prototypes: content-addressed store, strict prototype HTML
**Verify:** `npm test -- --run test/unit/taskPrototypeStore.test.ts test/unit/prototypeHtmlPolicy.test.ts test/unit/taskDetailPanel.test.ts test/unit/taskStudioPanel.test.ts`
**Verify:** `npm run test:browser -- taskPrototypeFrame`
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full`
**Dogfood:** `npm run test:browser -- taskPrototypeFrame`
policy, Bridge draft-only attach, Task Detail/Studio static previews with empty sandbox + first-party decision chrome,
interactive panel omitted after T3 real-host egress proof unavailable. T9: typecheck + focused suites +
`verify:full` (308 files / 3684 tests) green; browser `taskPrototypeFrame` 3/3; scrollable tall static mocks fixed
via static pointer-guard overflow. Evidence `.tachyon/evidence/366-html-ui-task-prototypes/`. Worktree
`tachyon/htmlUiPrototypes366T9`.

## Intent

Tasks that need a human UI decision currently ask the maintainer to infer a proposed interaction from prose,
screenshots, or sketches. Tachyon should let the coordinator delegate a self-contained, mocked HTML prototype,
attach it to the task, and let the human see the proposal in both Task Detail and Task Studio before real product
code is implemented.

Agent-authored HTML is untrusted active content. This feature is done only when the prototype is stored as a
versioned, content-addressed task artifact and rendered through a prototype-specific trust boundary: strict
preflight, an opaque-origin `srcdoc` iframe, no external egress, no task/Bridge/VS Code authority, and first-party
decision controls that the prototype cannot cover or imitate. The read-only task preview is static by default;
interaction happens in a separate explicitly opened panel that contains no approval controls.

Approval is a first-party Tachyon UI action. In v1 the prototype manifest is the workspace decision record: it
selects one active approved anchor and records the human decision against exact bytes for normal Tachyon flows.
Because the manifest lives inside the mutable workspace, it is not a tamper-evident host-owned approval root
against direct filesystem edits by a process with workspace write access; that stronger authority boundary is a
follow-up, not a v1 security claim. `awaitingHuman` remains an advisory board signal and is cleared only when it
explicitly names that prototype review. The approved anchor is the input for implementation and later visual QA.
Prototype authorship remains an orchestration convention: the coordinator may choose a declared UI/UX specialist or
an ad-hoc agent based on fit; Tachyon does not hardcode one agent name.

## Acceptance criteria

- [x] **Scenario: an agent attaches a bounded self-contained draft**
  - **Given** an existing task and an agent-authenticated Bridge caller
  - **When** the caller submits a prototype title and HTML through `attach_task_prototype`
  - **Then** Tachyon validates the task id, UTF-8 byte cap, MIME, markup policy, external-resource ban, and decoded
    `data:` budget before storing a content-addressed blob under that task's existing attachment namespace
  - **And** the stored metadata records a stable prototype id, blob sha256, byte size, policy version, bounded
    title/author, timestamps, and lifecycle state `draft`; the agent cannot name or mutate a superseded/approved id
  - **And** malformed, oversized, externally-referencing, form/iframe/object/embed/base/meta-refresh,
    worker/import-map, inline-handler, or traversal payloads are rejected before any manifest mutation

- [x] **Scenario: prototype metadata is versioned and fail-closed**
  - **Given** multiple prototype revisions for one task
  - **When** Task Detail, Task Studio, or `get_task` reads them
  - **Then** the reader receives ordered metadata for `draft | approved | superseded | rejected`, integrity and
    availability for each blob, and exactly one active approved anchor at most
  - **And** an unknown manifest/policy version, malformed transition, missing blob, hash mismatch, or stale CAS
    expectation is surfaced as unavailable/read-only and is never silently repaired or overwritten

- [x] **Scenario: both task surfaces show a safe static preview**
  - **Given** a task with an available prototype
  - **When** the human opens Task Detail or Task Studio
  - **Then** the selected revision renders in an iframe with byte-exact `sandbox=""`, scripts disabled, and
    first-party `pointer-events: none`
  - **And** a four-sided first-party gutter, an over-frame watermark, and a non-overridable header identify it as
    untrusted, show revision/state/integrity, and keep prototype pixels from abutting or mimicking decision chrome
  - **And** Task Studio can import a local `.html` revision through the same store/policy as the Bridge tool

- [x] **Scenario: interaction ships only after the navigation-egress gate passes in the real host**
  - **Given** headless request-counter tests and a real VS Code `vscode-webview://` dogfood prove that dynamic
    self-navigation produces zero external requests
  - **When** the human explicitly opens the interactive prototype and its agent-authored script runs
  - **Then** it runs in a dedicated panel inside `sandbox="allow-scripts"` without `allow-same-origin`, forms,
    popups, top navigation, downloads, modals, workers, nested frames, or external resource/navigation egress
  - **And** its CSP is exactly host-owned (`default-src 'none'`; nonce-only scripts; inline styles; bounded
    `data:` images; `connect-src`, `frame-src`, `object-src`, `base-uri`, `form-action`, and `worker-src` all none)
  - **And** the frame receives no task data, approval ids, VS Code API, Bridge token, workspace path, or parent
    message channel; messages from it are ignored
  - **And** browser tests prove rendering and local click behavior while fetch, beacon/image egress, navigation,
    storage, parent DOM access, form submit, popup, worker, download, and message spoof attempts all fail
  - **And** if the real-host gate cannot prove zero navigation egress, the interactive command/panel do not ship in
    v1; static preview, approval, storage, and the producer workflow remain the complete fallback

- [x] **Scenario: the human approves through first-party chrome**
  - **Given** a `draft` prototype on a task flagged `awaitingHuman.kind = decision`
  - **When** the human selects `Approve prototype` in Task Detail
  - **Then** only first-party controls outside any prototype frame perform the transition, the selected revision
    becomes the sole `approved` anchor, any prior approved anchor becomes `superseded`, and the manifest records
    `approvedAt`, `approvedBy: "human"`, prototype id, and sha256 as the workspace decision record
  - **And** only after that durable transition Tachyon clears `awaitingHuman` when its subject exactly matches this
    prototype review, using the task's current CAS value; a concurrent task edit leaves the advisory flag set and
    reports retryable reconciliation instead of claiming that the board signal is reconciled

- [x] **Scenario: the human requests changes or annotates a revision**
  - **Given** a visible draft or approved prototype
  - **When** the human adds a review note or selects `Request changes`
  - **Then** Tachyon appends a bounded first-party review record to the prototype manifest; requesting changes marks
    that revision `rejected`, resolves only a matching prototype `awaitingHuman` subject, and never mutates runtime
    DOM back into stored HTML
  - **And** any task-journal note is optional, cap-tolerant, and non-authoritative

- [x] **Scenario: implementation and visual QA consume the approved anchor**
  - **Given** a task with one approved prototype
  - **When** an implementation agent reads `get_task`
  - **Then** the response includes prototype summaries and a workspace-contained blob path plus sha256 for the
    active approved anchor, clearly labeled as untrusted task content
  - **And** visual QA and implementation resolve only the currently approved, non-superseded sha256; implementation
    completion remains normal task/artifact history, not a prototype lifecycle transition

- [x] **Scenario: lifecycle cleanup does not leak or orphan authority**
  - **Given** a task is hard-deleted, a draft is superseded, or a panel closes/reloads
  - **When** cleanup runs
  - **Then** a prototype cleanup helper removes its isolated blob directory when a future hard-delete path calls it;
    the current `dropped` lifecycle deliberately retains task attachments, including prototypes
  - **And** stale revisions remain auditable, panels use `retainContextWhenHidden: false`, close/dispose drops all
    in-memory content, and reload reconstructs state only from validated persisted metadata

- [x] The producer convention is documented: choose a declared UI/UX specialist when the project declares one,
  otherwise spawn an ad-hoc designer; require a self-contained mocked prototype; attach through the Bridge tool;
  never let the producer approve or supersede its own work; use the approved sha256 as the
  implementation/visual-QA anchor; treat every producer payload as untrusted regardless of declared ownership.

## Non-goals

- Using HTML as a payload inside the generic approval panel or letting prototype content own approval chrome.
- Backend/API access, real production data, external fonts/assets/scripts, network allowlists, or arbitrary host RPC.
- Persisting runtime DOM mutations, editing source HTML inside the iframe, or treating a prototype as product code.
- Hardcoding a `designer`, `uiux`, Claude, Codex, or other agent name into routing.
- Replacing plugin-UI consent/projection/action semantics or broadening the plugin UI broker.
- Auto-implementing a proposal immediately after a click; approval only removes the decision block and records the
  anchor, after which normal orchestration/delegation/verification still applies.
- Providing tamper-evident host-owned approval signatures or an out-of-workspace approval registry in v1.

## Open questions

No blocking product fork remains for v1. Exact caps and the narrow lifecycle transition table are plan-level
constants and must be pinned by tests before implementation proceeds past the storage gate.
