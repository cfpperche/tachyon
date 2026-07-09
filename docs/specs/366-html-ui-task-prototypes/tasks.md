# 366 - html-ui-task-prototypes - tasks

_Generated from `plan.md` on 2026-07-09. Work top-to-bottom. T1-T3 are security gates: no task surface may render
agent HTML before they are green. If a task invalidates the plan, update `plan.md` before continuing._

## Implementation

- [x] **T1 - Store and lifecycle:** implement `TaskPrototypeStore` plus strict schema/caps/atomic writes,
  isolated task-scoped `prototypes/<sha256>` blobs, immutable revisions, the four-state transition table,
  authoritative human decision/review records, single-approved-anchor invariant, manifest CAS,
  integrity/unavailable states, reconciliation marker, and a cleanup helper without claiming a wired hard delete.
  Unit-test malformed/newer
  schema, traversal, missing/tampered blobs, duplicate approved anchors, every valid/invalid transition, stale CAS,
  dropped-task retention, and injected write failures. Agent draft creation accepts no state or `supersedes` input.
- [x] **T2 - Prototype HTML policy:** implement the 512 KiB HTML and 256 KiB decoded-data budgets plus fail-closed
  preflight. Reject external/privileged URLs, forms, base/meta-refresh, iframe/object/embed, import maps, workers,
  author CSP, every `on*` inline handler, external CSS/script/assets, oversized/invalid data URIs, cumulative decoded
  budget overflow, and encoded bypass variants. Implement a standalone superset policy; share only
  decode/normalize helpers with `entryHtmlValidator`, never its weaker policy result.
- [x] **T3 - Sandbox hard gate:** extract the generic host-owned srcdoc assembler while preserving
  `assemblePluginSrcdoc`; add static and interactive prototype policies; add `frameSrc` passthrough to Studio
  surfaces. Browser-test opaque origin, byte-exact static `sandbox=""`, static script suppression, local click
  behavior, and blocked fetch, beacon/image, parent/storage, form, popup, worker, download, nested frame, and
  postMessage spoofing. For `location.href`, `location.replace`, `window.open`, synthetic `_self` links, and
  runtime-injected meta refresh, assert a server-side request counter remains zero. Existing plugin-frame tests must
  stay green. Record a second proof in a real `vscode-webview://` host; if either navigation proof fails, explicitly
  select the static-only v1 fallback and do not implement/register T5. **Result: static-only v1 selected because
  no real `vscode-webview://` zero-navigation-egress evidence was available; the interactive panel is absent.**
- [x] **T4 - Producer/read API:** add agent-authenticated, draft-only `attach_task_prototype` using Bridge-resolved
  authorship; extend `flag_for_human` with an optional exact prototype subject; enrich `get_task` with bounded
  first-party metadata, an `untrustedAgentAuthored` envelope for title/author/review text, and the active approved
  anchor path/hash. Add tests for agent and legacy caller attribution, cap failures, no partial mutation, malicious
  metadata labeling, response bounds, rejection of caller-supplied supersession, and absence of any agent-callable
  approval/demotion transition.
- [x] **T5 - Interactive panel (conditional on T3):** add `TaskPrototypePanel` and bundle registration only after
  both navigation proofs pass. Render a first-party untrusted header outside a full-height
  `sandbox="allow-scripts"` frame, use `retainContextWhenHidden:false`, pass no task/approval/Bridge data, and
  register zero message listeners. Read `document.currentScript.nonce` synchronously at module top-level and make
  the assembler throw on an empty nonce. Tests pin the byte-exact sandbox and prove neither `allow-same-origin` nor
  prototype `script-src 'unsafe-inline'` appears in source or built bundle. **Not applicable in the selected
  static-only fallback: no panel, bundle, command, or registration was added.**
- [x] **T6 - Task Detail decision UX:** add static preview/revision/integrity UI, open-interactive action,
  four-sided gutter/over-frame watermark, approve/request-changes/review-note controls separated from the frame,
  authoritative manifest records, fan-out, CAS errors, and idempotent reconciliation of only an exact matching
  prototype `awaitingHuman` subject. Test that status-transition auto-clear never changes manifest decision state.
  Never expose decision controls in the interactive panel.
- [x] **T7 - Task Studio authoring UX:** add static prototype preview and local `.html` import/version management
  through the same store/policy; keep prototype state outside `RichDocAttachment[]` and preserve all existing
  body/sidecar no-op/CAS behavior. HTML crosses the host boundary as a bounded plain JSON string, never base64.
  Add focused adapter/panel/webview tests, including byte-exact static sandbox and no pointer interaction.
- [x] **T8 - Workflow and visual-QA anchor:** document coordinator routing (declared UI/UX specialist or ad-hoc),
  producer-not-approver-or-superseder rule, mocked/self-contained constraints, approved sha256 handoff, and
  visual-QA anchor resolution. Treat every producer as untrusted regardless of declared ownership/hook-trust and
  document the legacy Bridge attribution caveat. Add a fixture with draft/rejected/approved history.
- [ ] **T9 - Regression and closure:** run focused store/policy/panel/browser tests, existing plugin UI frame tests,
  Task Detail/Task Studio regressions, `npm run typecheck`, and `npm run verify:full`; perform blocking real VS Code
  visual/security dogfood with screenshots and DevTools/network evidence. Close the SDD/task only after the human
  decision workflow and, when enabled, zero-navigation-egress claim are exercised end to end.

## Verification

- [ ] Draft attachment is content-addressed, bounded, schema-validated, task-scoped, and leaves no partial manifest
  on rejection/failure.
- [ ] Prototype lifecycle is immutable/versioned, CAS-protected, and exposes at most one approved anchor.
- [ ] Static previews render in Task Detail and Task Studio with scripts/pointer interaction disabled and
  first-party untrusted chrome outside the iframe.
- [ ] Interactive preview either works only in the dedicated panel after both navigation proofs, or is absent under
  the documented static-only fallback; no blank-frame repair weakens sandbox/CSP.
- [ ] Approval/request-changes/notes are first-party manifest records and fail closed around exact-subject
  `awaitingHuman` CAS; journal capacity cannot block or define the decision.
- [ ] Bridge lets an authenticated agent create drafts and lets consumers discover the approved path/hash, but
  exposes no agent approval action.
- [ ] Existing plugin UI, Task Detail, Task Studio, rich-doc attachment, full build, and typecheck suites remain green.

**Headless check:** `npm test -- --run test/unit/taskPrototypeStore.test.ts test/unit/prototypeHtmlPolicy.test.ts test/unit/taskDetailPanel.test.ts test/unit/taskStudioPanel.test.ts && npm run test:browser -- taskPrototypeFrame && npm run typecheck`

**Verify:** `npm test -- --run test/unit/taskPrototypeStore.test.ts test/unit/prototypeHtmlPolicy.test.ts test/unit/taskDetailPanel.test.ts test/unit/taskStudioPanel.test.ts`
**Verify:** `npm run test:browser -- taskPrototypeFrame`
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full`

## Dogfood

**Dogfood:** `npm run test:browser -- taskPrototypeFrame`

**Human dogfood (blocking for interactive v1):** In a clean fixture workspace: (1) delegate a self-contained mock to an agent and have it call
`attach_task_prototype`; (2) open Task Detail and confirm the static, watermarked preview cannot be clicked; (3)
if T3 enabled it, open the dedicated interactive panel and exercise all mock controls; (4) return to Task Detail, add a note, request
changes, attach revision 2, approve it, and confirm the task leaves Awaiting you; (5) call `get_task` and verify the
approved id/path/sha; (6) reopen both panels after reload; (7) verify a hostile prototype cannot abut/mimic
first-party chrome; (8) in the real VS Code host capture DevTools/network evidence that all dynamic navigation
variants produce zero requests. A failed/unavailable step 8 means static-only v1.

## Visual QA

- [ ] Evidence: agent-screen captures of Task Detail (draft, rejected, approved, unavailable), Task Studio import
  and version list, four-sided gutter/over-frame watermark, and, if enabled, the interactive panel in light/dark
  plus narrow/wide editor widths. Include real-host zero-request evidence for interactive v1.
- [ ] Verdict:
