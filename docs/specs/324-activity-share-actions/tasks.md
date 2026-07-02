# 324 — activity-share-actions — tasks

_Generated from `plan.md` on 2026-07-02. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add pure share helpers that decide whether an `ActivityItem` is shareable and format a bounded payload with provenance.
- [x] Extend the Activity webview message contract with webview→host share action messages carrying item sequence and a stale-item token.
- [x] Render compact hover/focus share controls on text-bearing Activity rows.
- [x] Handle external share in `ActivityPanelManager` with payload preview plus Email, WhatsApp Web, and Copy options.
- [x] Handle internal share in `ActivityPanelManager` with a destination picker limited to other running AI agents and paste-without-submit delivery.
- [x] Add focused unit tests for payload formatting, destination filtering, and message handling where pure seams exist.
- [ ] Update `spec.md` acceptance boxes and closure after validation.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Text-bearing Activity items produce bounded share payloads with source agent, item kind, timestamp, and content.
- [x] Unsupported/no-text Activity items do not expose share controls.
- [x] Internal destination list excludes self, stopped/dead rows, and non-AI rows.
- [x] Stale sequence/token mismatch refuses to share instead of resolving to the wrong item.
- [x] URL channels cap/truncate payloads before encoding; Copy keeps the full bounded share payload.
- [x] Typecheck proves the webview/host message contract stays aligned.

**Verify:** `npm test -- test/unit/activityShare.test.ts test/unit/activityView.test.ts && npm run typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `npm test -- test/unit/activityShare.test.ts`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** Open an agent Activity panel, share a visible message externally via Copy and WhatsApp/Email, then send a visible message to another running Tachyon agent and confirm the destination receives the formatted prompt.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->
