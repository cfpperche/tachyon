# 350 — studio-shell

_Created 2026-07-04._

**Status:** shipped

## Intent

Tachyon has three "Studios" (assisted-creation editor views) built in three dialects: Agent Studio (5 tabs +
quick-add chips, host-side AgentForm.ts predating the panel pattern), Pin Studio (rich doc + visuals) and
Task Studio (kit fields + rich doc + CAS/freshness). Each hand-rolls the same five things: panel-manager
lifecycle (triplicated), header, field sections, fail-closed validation/error surfacing, and the
webview⇄host protocol (~20 wiring sites). Maintainer decision (task t-5c1cc5): extract ONE **studio shell**
so each studio becomes thin configuration over shared infrastructure — and the **Pipeline Studio (pin
p-cbcc94) is GATED on this spec**: born on the shell, never a fourth dialect.

**Proof strategy (dueto F1/F3/F4, accepted — inverts the draft's pilot):** the shell is proven FIRST
against two fakes that cannot be casualties — a behaviorally-complete Pipeline skeleton (fake adapter,
in-memory persistence, full lifecycle) and a SINGLE-ENTITY Agent-shaped fixture (the densest real form,
proving domain components map to shell regions — tabs dissolved by the dismemberment decision). Only after shell lifecycle/protocol tests pass against both does the
delicate, weeks-old Task Studio migrate (Phase 2). "The Task migration must not be both the experiment and
the casualty."

## Acceptance criteria

- [x] **Scenario: shell panel-manager base** (dueto F7 folded)
  - **Given** `src/webview/shared/studio/` with a `StudioPanelManagerBase`
  - **Then** it owns the triplicated lifecycle — new-entity singleton per workspace + per-id edit panels,
    reveal-on-reopen, dispose, refreshAll — parameterized by an adapter (entity type, id parser, title,
    load/save/delete semantics), **plus panel restore**: serialize/deserialize of panel identity, mode,
    entity id and (where the domain allows) unsaved patch snapshot, with reload-recovery behavior — tests
    cover window-reload restore for new-entity, edit, dirty and failed-load states
  - **And** the base model is SINGLE-DOCUMENT only (maintainer decision 2026-07-04: the one tabbed studio
    dismembers into per-entity studios, so no navigation contract is built — dueto F3's tabbed-support
    requirement is superseded; if a future studio genuinely needs tabs, that is a spec amendment, not a
    silent hook)
- [x] **Scenario: shell surface frame with declared content regions** (dueto F10/F11/F12 folded)
  - **Then** the frame renders the standard header (big title, action slots, Cancel/Save right-aligned),
    kit-based sections, and **declared content regions** — `fields`, `richDoc`, `previewVisual`,
    `sideActions` — with layout constraints tested in the preview harness (Pin's future migration notes
    must map its chrome to regions or name what cannot map)
  - **And** validation/errors are a typed taxonomy: store-authoritative blocking/non-blocking results;
    unknown validation/persistence/transport errors are BLOCKING by default; the SHELL owns save-button
    gating from this taxonomy (an adapter can never surface an error while leaving save enabled)
  - **And** every shell-owned visible string goes through the existing localization path (or a shell
    `labels` contract adapters feed); protocol error codes are stable identifiers, display text localizes
    in the webview layer
- [x] **Scenario: one message protocol with a disciplined extension slot** (dueto F2, accepted)
  - **Then** `StudioMessage` is a discriminated union versioned by `studioProtocolVersion`; core messages
    own ready/load/patch/save/cancel/error/dirty/restore; `domain` messages are REGISTERED by the adapter
    as a typed union with explicit names and schema validation at the host boundary; unknown versions or
    messages fail closed (tested); domain messages MAY NOT duplicate core lifecycle/dirty/validation/save/
    cancel/error semantics — that rule is enforced by review + a lint-style test over registered names
- [x] **Scenario: adapter-declared domain hooks** (dueto F5/F6, accepted)
  - **Then** dirty tracking is adapter-declared, never globally inferred — `computeDirty`,
    `serializePatch`, `canDiscard` hooks with shared shell-gating tests plus domain fixtures (Task
    body-hash/dirty-patch; rich-doc edits; per-tab edits) — and concurrency is a typed
    `ConcurrencyContract` (`none | cas` with expected revision/hash, stale detection, stale banner state,
    retry/reload action, fail-closed save blocking)
- [x] **Scenario: adapter surface budget** (dueto F9, accepted)
  - **Then** the public adapter API is documented and reviewed BEFORE any migration; every hook maps to one
    of: identity/lifecycle, navigation, layout regions, domain fields, validation, persistence,
    concurrency, domain actions; hooks that bypass header, dispatch, dirty gating, error mapping or
    save/cancel flow are forbidden without a spec amendment — "thin configuration" is a checkable property,
    not a hope
- [x] **Scenario: Phase 1 proof — Pipeline skeleton, behaviorally complete** (dueto F1/F4, accepted)
  - **Then** a disabled `pipeline-studio` (no command contribution, or dev-flag-hidden) runs the FULL shell
    exercise on a fake adapter with in-memory load/save/delete and validation: load new/edit, field patch,
    dirty indicator, validation block, save enable/disable, save success, save failure through the standard
    error mapping, cancel, reveal-on-reopen, refreshAll, panel restore, preview-harness route and visual
    pass — no real pipeline semantics
- [x] **Scenario: Phase 1 proof — Agent-entity fixture (tabs DISSOLVED by maintainer decision)** (dueto
  F3/F8 superseded — see disposition addendum)
  - **Given** the maintainer's ratified direction (2026-07-04): Agent Studio's 5 tabs were an accident of
    the current UI, not a requirement — they DISMEMBER into five single-entity studios (New Agent, New
    Terminal, New Command, New Runbook, New Schedule), each entered from its OWN sidebar section's existing
    "+" button (entry is already contextual today; no picker needed) plus a per-entity palette command
  - **Then** Phase 1's second fixture is a SINGLE-ENTITY Agent-shaped fixture (the Agent tab's fields:
    quick-add CLI detection chips as domain components, role template, instructions, worktree section)
    proving the densest real form maps to shell regions; the **AgentForm compatibility spike** remains:
    document whether AgentForm.ts's host side adapts or needs rewrite-to-config, recording needed shell
    APIs; the Agent DISMEMBERMENT follow-up task may not be queued before this fixture + spike exist
- [ ] **Scenario: Phase 2 — Task Studio migrates** (only after Phase 1 gates pass)
  - **Then** Task Studio (both modes) runs on the shell with zero behavior regression — 339's authoring
    contract intact (body-hash anchoring via the cas ConcurrencyContract, dirty-patch via the hooks, staged
    create, freshness banner) — its behavioral suites green unchanged, adjusted only where they touched
    replaced plumbing, plus new shell-level conflict tests
- [x] **Migration follow-ups queued, not forced**: Agent Studio (after its fixture) and Pin Studio (with
  region-mapping notes) as queue tasks — this delivery stays bounded
- [x] **Stateful preview + visual pass** (dueto F13): preview routes include clean, dirty,
  validation-blocked, save-pending, stale/conflict, load-error and domain-action states; the visual pass
  checks shell chrome consistency while allowing declared domain regions and navigation differences
- [x] Pure, unit-tested shell decision modules (dirty gating, save gating, error taxonomy mapping, restore
  decisions); full suite + both typechecks green

## Non-goals

- Migrating Agent Studio and Pin Studio in this delivery (queued with their own gates).
- The real Pipeline Studio (own spec, on the shell, after this ships).
- New editor capabilities (rich-doc/visuals stay the 339/342 modules the shell composes via regions).
- Changing store/entity semantics — the shell is presentation + lifecycle + protocol only.

## Open questions

_Resolved in the dueto fold: pilot order inverted (fakes first, Task second — F1); tabs are first-class in
the base model, proven by fixture (F3); AgentForm gets a compatibility spike before the shell is declared
stable (F8). Remaining: shell location (`shared/studio/` vs kit namespace — plan decides by import-graph
cleanliness)._
