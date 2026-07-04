# 350 — studio-shell — plan

_Drafted 2026-07-04 (post-dueto + dismemberment amendment). THIS DELIVERY = PHASE 1 ONLY: the shell proven
by two fakes. Phase 2 (Task Studio migration) and the dismemberment of Agent Studio are follow-up tasks
gated on Phase 1's exit criteria._

## Approach

1. **`src/webview/shared/studio/` — the shell**:
   - `StudioPanelManagerBase` (host side): generalizes the triplicated lifecycle — new-entity singleton per
     workspace + per-id edit panels, reveal-on-reopen, dispose, refreshAll, panel restore
     (serialize/deserialize identity/mode/entityId/unsaved-patch-snapshot per adapter permission, reload
     recovery). Adapter interface: entity type, id parse/format, tab title/icon, load/save/delete,
     ConcurrencyContract (none|cas), dirty hooks (computeDirty/serializePatch/canDiscard).
   - `StudioMessage` protocol (shared types): discriminated union, `studioProtocolVersion`, core messages
     (ready/load/patch/save/cancel/error/dirty/restore), adapter-registered domain messages (typed union,
     schema-validated at host boundary, unknown fails closed, lint-test against core-semantics duplication).
   - `StudioFrame` (webview side, Preact): header (title, action slots, Cancel/Save), declared content
     regions (`fields`, `richDoc`, `previewVisual`, `sideActions`), kit-based sections, error taxonomy
     surfacing with SHELL-owned save gating (unknown errors blocking), labels/i18n contract, standard CSP.
   - Pure decision modules: dirty gating, save gating, error mapping, restore decisions (DOM-free, tested).
2. **Fake 1 — Pipeline skeleton** (`src/webview/pipeline-studio/` + a `PipelineStudioAdapter` with
   in-memory load/save/delete + validation): dev-flag-hidden entry; exercises the FULL lifecycle per the
   spec criterion (load new/edit, patch, dirty, validation block, save success/failure, cancel, reveal,
   refreshAll, restore, preview route, visual pass states).
3. **Fake 2 — Agent-entity fixture**: a single-document fixture with the Agent tab's real field shapes
   (quick-add CLI chips as a domain component, role template select, instructions textarea, worktree
   section) proving dense domain components map into shell regions — test-only (no command), preview route.
4. **AgentForm compatibility spike** (read-only analysis, recorded in notes.md): can AgentForm.ts's host
   side become a thin adapter, or does dismemberment imply rewrite-to-config? Output = the needed shell
   APIs list; shell not declared stable until the fixture represents them.
5. **Preview + visual pass**: routes for pipeline-studio (all stateful scenarios: clean/dirty/validation-
   blocked/save-pending/stale-conflict/load-error/domain-action) and the agent fixture; agent-browser
   visual pass against "one chrome" anchors before notify.

## Phase 1 exit criteria (gate for Phase 2 / dismemberment / real Pipeline Studio)

Shell lifecycle + protocol tests green against BOTH fakes; adapter surface budget documented (hook
categories, no bypass hooks); restore proven across a simulated reload; error taxonomy save-gating proven;
spike documented.

## Key decisions

- Phase 1 ships NO user-visible change (maintainer accepted the return profile during ratification).
- Single-document only (dismemberment amendment — tabs contract dropped; future tabs = spec amendment).
- Shell location: `src/webview/shared/studio/` (kit stays atoms-only; shell composes kit, not vice versa).
- Entry points unchanged in Phase 1 (sidebar "+" wiring changes land with the dismemberment follow-up).

## Files touched

All new under src/webview/shared/studio/, src/webview/pipeline-studio/, fixtures + preview routes +
tests. NO changes to existing studios, stores, bridge (zero collision with the 351 work in flight).

## Risks

- Wrong-abstraction pressure: the adapter budget is the guardrail — any hook outside the categories stops
  the work and escalates (notify claude), never a silent hook.
- Restore semantics for unsaved patches: adapter-permission-gated; when in doubt, restore LESS (fail to
  clean load) — losing a draft is better than resurrecting a stale one silently.

## Sources consulted

spec 350 post-dueto+amendment · notes.md dispositions · PinStudioPanel/TaskStudioPanel/AgentForm (the
triplication) · 342 kit + 339 authoring contract (the cas ConcurrencyContract shape) · probe-8e5deca0.
