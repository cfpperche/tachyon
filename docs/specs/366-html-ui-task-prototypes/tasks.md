# 366 - html-ui-task-prototypes - tasks

_Generated from `plan.md` on 2026-07-09. Work top-to-bottom. T1-T3 are security gates: no task surface may render
agent HTML before they are green. If a task invalidates the plan, update `plan.md` before continuing._

## Implementation

- [x] **T1 - Store and lifecycle:** implement `TaskPrototypeStore` plus strict schema/caps/atomic writes,
  isolated task-scoped `prototypes/<sha256>` blobs, immutable revisions, the four-state transition table,
  first-party UI decision/review records, single-approved-anchor invariant, manifest CAS,
  integrity/unavailable states, reconciliation marker, and a cleanup helper without claiming a wired hard delete.
  Focused tests cover newer/malformed schemas, tampered blobs, single-anchor supersession, stale CAS, invalid
  post-approval transitions, exact-byte `readHtml`, cleanup, and agent draft creation without state or `supersedes`
  input; broader injected-failure/retention coverage remains part of T9 closure debt if this spec ships beyond v1.
- [x] **T2 - Prototype HTML policy:** implement the 512 KiB HTML and 256 KiB decoded-data budgets plus fail-closed
  preflight. Reject external/privileged URLs, forms, base/meta-refresh, iframe/object/embed, import maps, workers,
  author CSP, every `on*` inline handler, external CSS/script/assets, oversized/invalid data URIs, cumulative decoded
  budget overflow, and representative encoded bypass variants. Implement a standalone superset policy; share only
  decode/normalize helpers with `entryHtmlValidator`, never its weaker policy result. Tests also pin that ordinary
  inline script identifiers such as `data`, `href`, and `action` are not misclassified as HTML URL attributes.
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
- [x] **T6 - Task Detail decision UX:** add static preview/revision/integrity UI,
  four-sided gutter/over-frame watermark, approve/request-changes/review-note controls separated from the frame,
  first-party manifest records, fan-out, CAS errors, and idempotent reconciliation of only an exact matching
  prototype `awaitingHuman` subject. Tests cover exact selected-draft decision targeting so an approved/rejected
  selected revision cannot approve a hidden latest draft. Never expose decision controls in the interactive panel.
- [x] **T7 - Task Studio authoring UX:** add static prototype preview and local `.html` import/version management
  through the same store/policy; keep prototype state outside `RichDocAttachment[]` and preserve all existing
  body/sidecar no-op/CAS behavior. HTML crosses the host boundary as a bounded plain JSON string, never base64.
  Add focused adapter/panel/webview tests, including byte-exact static sandbox and no pointer interaction.
- [x] **T8 - Workflow and visual-QA anchor:** document coordinator routing (declared UI/UX specialist or ad-hoc),
  producer-not-approver-or-superseder rule, mocked/self-contained constraints, approved sha256 handoff, and
  visual-QA anchor resolution. Treat every producer as untrusted regardless of declared ownership/hook-trust and
  document the legacy Bridge attribution caveat. Add a fixture with draft/rejected/approved history.
- [x] **T9 - Regression and closure:** focused store/policy/panel/browser tests green; plugin-frame gate green;
  Task Detail/Task Studio unit suites green; `npm run typecheck` green; `npm run verify:full` green
  (308 files / 3684 tests). Static-only v1 (T3 fallback): interactive panel absent; browser dogfood proves
  empty sandbox, script suppression, pointer suppression, four-sided gutter/watermark, and tall-document scroll.
  Visual evidence under `.tachyon/evidence/366-html-ui-task-prototypes/`. Installed-host interactive zero-egress
  proof remains deferred with the interactive panel (documented static-only fallback).

## Verification

- [x] Draft attachment is content-addressed, bounded, schema-validated, task-scoped, and leaves no partial manifest
  on rejection/failure.
- [x] Prototype lifecycle is immutable/versioned, CAS-protected, and exposes at most one approved anchor.
- [x] Static previews render in Task Detail and Task Studio with scripts/pointer interaction disabled and
  first-party untrusted chrome outside the iframe.
- [x] Interactive preview either works only in the dedicated panel after both navigation proofs, or is absent under
  the documented static-only fallback; no blank-frame repair weakens sandbox/CSP.
- [x] Approval/request-changes/notes are first-party workspace manifest records and fail closed around exact-subject
  `awaitingHuman` CAS; journal capacity cannot block or define the decision.
- [x] Bridge lets an authenticated agent create drafts and lets consumers discover the approved path/hash, but
  exposes no agent approval action.
- [x] Existing plugin UI, Task Detail, Task Studio, rich-doc attachment, full build, and typecheck suites remain green.

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

- [x] Evidence: `.tachyon/evidence/366-html-ui-task-prototypes/static-preview-dark.png`,
  `static-preview-light.png`, `static-preview-scrolled.png` (first-party chrome + empty sandbox + watermark;
  scrollable tall static mock). Browser proof: `test/browser/taskPrototypeFrame.test.ts` (3/3).
  Interactive panel: N/A under static-only v1 fallback (T3).
- [x] Verdict: **PASS** for static-only v1 — untrusted chrome, sandbox="", pointer suppression, gutter/watermark,
  and inspectable tall content. Interactive zero-egress host dogfood deferred with interactive panel.
