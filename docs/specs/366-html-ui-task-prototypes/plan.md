# 366 - html-ui-task-prototypes - plan

_Drafted from `spec.md` on 2026-07-09 and folded through the Claude Fable adversarial review at
`.tachyon/reviews/366-html-ui-task-prototypes-fable.md` before implementation delegation._

## Approach

Build the feature as four explicit layers, in trust-boundary order. No task UI renders agent HTML until layers 1
and 2 have adversarial browser proof.

1. **Task-local prototype store and lifecycle.** Add a `TaskPrototypeStore` whose manifest lives at
   `.tachyon/tasks/attachments/<task-id>/prototypes.json` and whose HTML uses an isolated content-addressed
   `.tachyon/tasks/attachments/<task-id>/prototypes/<sha256>` directory. The manifest is schema-versioned,
   atomically written, bounded, and transition-validated. It is separate from `TaskDetail.attachments` so a task
   can have a prototype without a rich-doc sidecar and the entity-neutral image/sketch union does not leak an
   active-content kind into Pin Studio. A cleanup helper is provided, but the current product has no hard-delete
   route and `dropped` tasks deliberately retain attachments.
2. **Prototype-specific validation and frame contract.** Extract only the generic srcdoc/CSP assembly needed
   from spec 349 into a shared pure helper, preserving plugin-host behavior with regression tests. Add a stricter
   prototype policy on top: 512 KiB UTF-8 HTML maximum, `text/html` only, 256 KiB cumulative decoded `data:`
   payload budget, no external URLs/resources, forms, base/meta refresh, nested frames/objects/embeds, import maps,
   workers, inline `on*` handlers, or author CSP. Static mode uses no scripts. Interactive mode nonce-stamps only
   inline `<script>` blocks. Both embedder and child CSPs are tested; T3 must prove, rather than inherit from spec
   349, that the embedder's `frame-src 'self'` blocks child self-navigation to an external document.
3. **First-party surfaces and decisions.** Add a reusable `PrototypePreview` component to Task Detail and Task
   Studio. It owns the label, four-sided gutter, over-frame watermark, revision selector, integrity state, and
   static iframe outside the untrusted document. A separate `TaskPrototypePanel` hosts the interactive iframe only
   if the navigation-egress gate passes; it deliberately has no approve/reject or parent RPC. Task Detail owns
   approve/request-changes/review-note controls. Task Studio owns local `.html` import and revision inspection.
   State mutations return fresh summaries and participate in the existing task fan-out.
4. **Agent producer/consumer path.** Add `attach_task_prototype` for agent-authenticated draft creation and enrich
   `get_task` with bounded prototype summaries plus the active approved anchor's contained path/hash. Every
   agent-authored metadata field is nested under an explicit untrusted envelope. Extend `flag_for_human` with an
   optional prototype subject so first-party approval resolves only the review it actually answered. The producer
   never gets a Bridge approval/supersede tool. Document coordinator routing and the handoff from approved
   prototype to implementation and visual QA.

## Key decisions

- **Separate prototype manifest inside the existing task attachment namespace** - chosen because prototypes have
  their own lifecycle/CAS and must exist independently of a rich-doc sidecar; rejected widening
  `RichDocAttachment` because that would expose active HTML to Pin Studio and every image/sketch consumer.
- **Static-in-task, interactive-in-separate-panel** - chosen because approval UI and active untrusted content must
  never share an interaction plane; rejected a simple `Interact` toggle beside Approve because UI-redress risk
  remains while both are visible.
- **No child-to-parent channel in v1** - chosen because a full-height panel needs neither resize RPC nor runtime DOM
  persistence; rejected forwarding annotations/actions from the frame because it creates authority the mock does
  not need. Review notes are first-party manifest records; journal notes are optional and non-authoritative.
- **Reuse spec 349's primitive, not an unproven security claim or its plugin broker** - chosen because opaque
  `srcdoc`, host-owned nonce
  CSP, and embedder frame CSP are reusable security mechanics, while fleet projection, consent, and `focusAgent`
  are plugin-specific authorities that a task prototype must never receive.
- **Approval manifest first, task flag second** - chosen as the fail-closed ordering: a crash can leave an approved
  artifact still visibly awaiting reconciliation, but cannot clear `awaitingHuman` without a durable anchor;
  rejected clearing first because a later manifest failure would unblock implementation with no approved source.
- **Bridge creates drafts only and accepts no `supersedes` target** - chosen so an agent can produce the artifact
  reproducibly but cannot approve, demote, or replace a human anchor; rejected a generic state-transition tool
  because caller identity is not human approval.
- **Content-addressed immutable revisions** - chosen so approvals bind to exact bytes and visual QA can prove which
  proposal it used; rejected in-place HTML editing because it invalidates the human decision after the fact.

## Lifecycle and transaction model

The store accepts only these transitions:

| From | To | Actor/effect |
| --- | --- | --- |
| none | draft | agent Bridge tool or human import |
| draft | approved | human Task Detail action; supersedes old approved anchor |
| draft | rejected | human Task Detail action + manifest review record |
| draft | superseded | first-party approval selects a different draft in the same decision set |
| approved | superseded | first-party human approval selects a replacement |

`approve` atomically updates `prototypes.json` first, including the authoritative human decision record. It then
clears `awaitingHuman` with `expect.updatedAt` only when the flag carries a matching
`subject:{type:"task-prototype",prototypeId}`. A CAS failure records `needsTaskReconciliation: true` in the manifest
and keeps the advisory task flag. Re-running first-party reconciliation is idempotent. At most one prototype may be
`approved`; a manifest violating that invariant is read-only malformed. A journal note is optional, cap-tolerant,
and never part of the approval transaction.

## Files touched

- `src/tasks/TaskPrototypeStore.ts` (new) - schema, caps, isolated content-addressed draft creation, lifecycle/CAS,
  integrity resolution, atomic manifest writes, reconciliation marker, cleanup helpers.
- `src/tasks/prototypeHtmlPolicy.ts` (new) - standalone strict preflight and cumulative size/data-budget checks;
  share only decode/normalize helpers with plugin validation, never the weaker policy result.
- `src/tasks/types.ts` - optional prototype subject on `awaitingHuman`; no new awaiting-human kind.
- `src/webview/shared/untrustedSrcdoc.ts` (new) and `src/webview/plugin-host/relay.ts` - shared policy-driven
  srcdoc assembler extraction with byte-for-byte/plugin regression coverage.
- `src/webview/shared/studio/StudioPanelManagerBase.ts` - additive `frameSrc: "self"` surface option.
- `src/webview/task-prototype/{main.ts,task-prototype.css}` and `src/webview/TaskPrototypePanel.ts` (new,
  conditional on T3) - dedicated interactive panel with untrusted header, `retainContextWhenHidden:false`, a
  synchronous top-level nonce read, and zero authority/message channel.
- `src/webview/task-detail/{App.tsx,messages.ts,task-detail.css}` and `src/webview/TaskDetailPanel.ts` - static
  preview, revision/state selector, open-interactive, approve/request-changes/note controls, reconciliation UI.
- `src/webview/task-studio/{App.tsx,domain.ts,messages.ts,types.ts,task-studio.css}`,
  `src/webview/TaskStudioAdapter.ts`, and `src/webview/TaskStudioPanel.ts` - static preview, import, summaries, and
  domain messages without mixing prototypes into the rich-doc attachment array.
- `src/bridge/tools.ts` plus Bridge schema/tests - agent-only `attach_task_prototype`; optional prototype subject on
  `flag_for_human`; bounded/untrusted prototype summaries in `get_task`; no approval mutation tool.
- `src/extension.ts`, `esbuild.mjs`, `src/webview/surfaces.ts` - panel manager lifecycle and bundle registration.
- `README.md` - coordinator convention and approved-anchor workflow.
- `test/unit/taskPrototypeStore.test.ts`, `test/unit/prototypeHtmlPolicy.test.ts`, panel/message tests, and
  `test/browser/taskPrototypeFrame.test.ts` - persistence, policy, anti-spoofing, navigation/egress, and lifecycle
  proof.

## Risks and unknowns

1. **Navigation egress is the hard gate and spec 349 did not prove it.** `connect-src 'none'` does not govern
   document navigation. A headless server request counter covers `location.href`, `location.replace`,
   `window.open`, synthetic `_self` links, and runtime-injected meta refresh. The same claim needs blocking,
   evidence-backed dogfood in a real `vscode-webview://` host. If either proof fails, interactive arbitrary
   JavaScript does not ship; v1 falls back to static prototypes.
2. **Shared srcdoc extraction can regress plugin UI.** Keep `assemblePluginSrcdoc` as a compatibility wrapper and
   run the existing spec-349 unit/browser/integration tests after extraction.
3. **Large HTML over MCP/webview messages.** The 512 KiB cap is a hard bound, but only one selected revision's
   content crosses to a webview. Lists/get_task expose metadata only. Tests pin response bounds.
4. **Manifest/task approval cannot be fully atomic.** The manifest is authoritative and the advisory flag is
   second. The fail-closed reconciliation marker makes partial completion explicit and retryable. Tests inject
   failure between manifest and task flag updates; journal capacity cannot block the decision.
5. **Task Detail and Task Studio can race.** Every prototype manifest mutation uses its own `updatedAt` CAS and
   returns a fresh snapshot; stale actions fail and refresh instead of last-write-wins.
6. **Prototype prompt injection.** Bridge output returns no raw HTML and nests title/author/review text under an
   explicit `untrustedAgentAuthored` envelope. Implementation agents opt into reading the approved blob and verify
   its sha256. Legacy shared-token callers can still forge attribution; content remains untrusted either way.
7. **Nonce and channel invariants are regression-prone.** The interactive bundle reads `currentScript.nonce`
   synchronously at module top-level, the assembler throws on an empty nonce, the iframe sandbox is byte-exact
   `allow-scripts`, and the bundle registers zero `message` listeners. Neither `allow-same-origin` nor prototype
   `script-src 'unsafe-inline'` may appear, even as a blank-frame repair.

## Visual impact

Task Detail gains the decision surface: a compact first-party prototype header, revision/state controls, a stable
preview viewport, decision buttons, and review notes. Task Studio gains the same static viewport plus import/version
management. The interactive panel, if enabled, is full-height and visibly watermarked outside the frame. Visual QA
must cover light/dark themes, narrow and wide editor tabs, long titles/state labels, unavailable/malformed blobs,
four-sided gutter, over-frame watermark, and prove the frame cannot overlap, abut, or mimic first-party controls.

## Sources consulted

- Task `t-119dc1` and journal entry `j-24b2fdb0c4e1` - product intent and the three security blockers.
- `docs/specs/339-task-studio/*` - task detail sidecar, attachment namespace, Task Detail/Task Studio surfaces.
- `docs/specs/349-plugin-ui-surfaces/*` - opaque-origin `srcdoc`, CSP, preflight, adversarial browser proof.
- `docs/specs/352-declared-subagents/*` - declared UI/UX ownership/routing convention; prototype content remains
  untrusted even though later hook-trust behavior means ownership is no longer metadata-only.
- `src/tasks/{TaskAttachmentStore,TaskDetailStore,TaskStore,TaskJournalStore}.ts` - current persistence/CAS/lifecycle.
- `src/plugins/entryHtmlValidator.ts`, `src/webview/plugin-host/{relay,main}.tsx`,
  `src/webview/shared/shell.ts` - current untrusted HTML policy and frame implementation.
- `src/webview/{TaskDetailPanel,TaskStudioPanel,TaskStudioAdapter}.ts` and their webview apps - integration seams.
- `.tachyon/reviews/366-html-ui-task-prototypes-fable.md` - 4 blockers, 6 majors, and accepted fold-ins.
