# 350 — studio-shell

_Created 2026-07-04._

**Status:** draft

## Intent

Tachyon has three "Studios" (assisted-creation editor views) built in three dialects: Agent Studio
(AgentForm.ts + agent-studio/, 5 tabs, its own quick-add chips/checkbox rows), Pin Studio
(PinStudioPanel.ts, rich doc + visuals) and Task Studio (TaskStudioPanel.ts, kit fields + rich doc). Each
hand-rolls the same five things — panel-manager lifecycle (new-singleton + per-id-edit, literally
triplicated), header (title + actions + Save/Cancel), field sections, fail-closed validation/error
surfacing, and the webview⇄host message protocol (~20 wiring sites across the three). The maintainer's
decision (task t-5c1cc5): extract ONE **studio shell** so each studio becomes a thin configuration over
shared infrastructure — and the **Pipeline Studio (pin p-cbcc94) is GATED on this spec**: it must be born
on the shell, never as a fourth dialect.

Done looks like: a shared shell (panel-manager base + header + section/field layer on the 342 kit + one
message protocol + one validation/error pattern), Task Studio migrated onto it as the proving pilot (it is
already closest, being half on the kit), Agent Studio and Pin Studio migration prepared as follow-up tasks
(not forced into this delivery), and a Pipeline Studio skeleton example proving a NEW studio is a config
file plus domain adapters, not a new surface.

## Acceptance criteria

- [ ] **Scenario: shell panel-manager base**
  - **Given** `src/webview/shared/studio/` (or equivalent) with a `StudioPanelManagerBase`
  - **Then** it owns the triplicated lifecycle — new-entity singleton per workspace + per-id edit panels,
    reveal-on-reopen, dispose discipline, refreshAll fan-in — parameterized by an adapter (entity type, id
    parser, title, load/save/delete semantics); PinStudio/TaskStudio/AgentForm managers become thin
    subclasses or configs WITHOUT behavior change (their existing panel tests keep passing unchanged)
- [ ] **Scenario: shell surface frame**
  - **Given** a studio webview built on the shell
  - **Then** the frame renders the standard header (big title, optional action slots like Import/Sketch,
    Cancel/Save right-aligned — the 339/342 pattern), kit-based section/FieldRow layout, the standard
    toast/error surfacing (structured store errors fail closed, CAS/stale treatment where the domain has
    it), and the shared webview shell CSP — all from configuration + domain components, no per-studio
    copies of frame markup/CSS
- [ ] **Scenario: one message protocol**
  - **Then** a typed `StudioMessage` envelope (ready/load/patch/save/cancel/error + domain extension slot)
    replaces the three ad-hoc protocols; the host side routes through one dispatcher in the panel base;
    domain-specific messages ride the extension slot with their own types — no studio invents parallel
    plumbing
- [ ] **Scenario: pilot — Task Studio on the shell**
  - **Then** Task Studio (both modes) runs on the shell with zero behavior regression: 339's authoring
    contract intact (body-hash anchoring, dirty-patch, staged create, freshness banner), its suites green
    unchanged where they encode behavior, adjusted only where they touched replaced plumbing
- [ ] **Scenario: Pipeline Studio skeleton (the gate made real)**
  - **Then** a minimal `pipeline-studio` example exists on the shell — empty domain fields, disabled entry
    point (no command contribution yet, or hidden behind a dev flag) — proving the "new studio = adapter +
    field config" claim compiles and renders in the preview harness; the REAL Pipeline Studio spec builds
    on it later
- [ ] **Migration follow-ups queued, not forced**: Agent Studio and Pin Studio migration are created as
  queue tasks with per-studio notes (Agent Studio's 5 tabs are the hard case — the shell must support
  tabbed studios or the task documents the extension needed), keeping this delivery bounded
- [ ] Preview-harness routes for every shell-based studio (Task Studio route exists; add the pipeline
  skeleton) + agent visual pass against "one frame, one rhythm, three studios indistinguishable in chrome"
- [ ] Pure, unit-tested modules for the shell's decision logic (dirty tracking, save gating, error
  mapping); panel-base covered by the pattern of the existing panel tests; full suite + typechecks green

## Non-goals

- Migrating Agent Studio and Pin Studio IN this delivery (queued follow-ups with their own dogfood).
- The real Pipeline Studio (own spec, on the shell, after this ships).
- New editor capabilities (rich-doc, visuals etc. stay as the 339/342 modules the shell composes).
- Changing any store/entity semantics — the shell is presentation + lifecycle + protocol only.

## Open questions

- Tabbed studios (Agent Studio's 5 entity tabs): shell v1 supports tabs natively, or single-entity shells
  with tabs as a documented extension? (Leaning: document the extension; don't over-build for one case.)
- Where the shell lives: `src/webview/shared/studio/` vs promoting into the kit namespace.
- AgentForm.ts (259 lines, host-side) predates the panel-manager pattern — subclass or rewrite-to-config?
