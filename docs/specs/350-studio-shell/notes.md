# 350 — studio-shell — notes

_Created 2026-07-03._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Design dueto (probe codex, adversarial-review, 2026-07-04, runId probe-8e5deca0)

13 findings (3 blockers), spec inline per [[probe-sandbox-no-fs]]. ALL ACCEPTED — no rebuttals; the review's
center of gravity (F1: "the Task migration must not be both the experiment and the casualty") inverted the
draft's pilot strategy and is plainly right:
- F1/F4: proof-by-fakes first — behaviorally-complete Pipeline skeleton (fake adapter, full lifecycle) is
  Phase 1, Task Studio migration is Phase 2 behind the gate.
- F3/F8: Agent Studio named as the studio that breaks the abstraction first — tabs become a first-class
  navigation contract proven by an Agent-shaped fixture + AgentForm compatibility spike BEFORE the shell is
  declared stable; the Agent migration task cannot even be queued before the fixture exists.
- F2: the extension slot gets discipline (versioned discriminated union, adapter-registered typed domain
  messages, fail-closed unknowns, no duplication of core semantics) — otherwise the three dialects just
  move inside the envelope.
- F5/F6: dirty tracking adapter-declared (computeDirty/serializePatch/canDiscard); ConcurrencyContract
  none|cas typed — "where domain has it" was too loose for a fail-closed house.
- F7: panel restore across window reloads enters the base contract (was missing entirely from the draft).
- F9: adapter surface budget — "thin configuration" becomes checkable (hook categories; bypass hooks
  forbidden without amendment).
- F10-F13: content regions (Pin's future), typed error taxonomy with shell-owned save gating, i18n labels
  contract + stable error codes, stateful preview scenarios so the visual pass can't mask behavior.

## Amendment (2026-07-04, maintainer ratification discussion)

The maintainer's ORIGINAL motivation for t-5c1cc5 surfaced during ratification: break the Agent Studio's
5-tab mega-form into five per-entity forms. That decision DISSOLVES dueto F3's hard case — the tabs were an
accident of the current UI, not a requirement — so the navigation/tabbed contract is REMOVED from the shell
base (single-document only; future tabs = spec amendment). Dueto F3/F8 disposition updated: F3's
tabbed-support requirement superseded by product decision (the honest rebuttal the dueto itself could not
have made — it defended the abstraction against a requirement the maintainer has now revoked); F8's
AgentForm compatibility spike SURVIVES (host-side adaptation risk is unchanged). Entry points: each sidebar
section's existing "+" opens its own entity's studio directly (already contextual today — no picker), plus
per-entity palette commands. The Agent migration follow-up becomes the DISMEMBERMENT task (5 studios on the
shell). Standardization inventory discussed and agreed (atoms→kit; behavior→shell; domain→adapter): header,
validation/error taxonomy + save gating, dirty/unsaved-changes semantics, keyboard conventions (Esc/submit/
autofocus), entry-point naming, panel behavior incl. reload restore, concurrency/freshness treatment,
empty/loading/failed states, destructive-action confirmation, i18n of shell strings.

## T6 — AgentForm compatibility spike (read-only, 2026-07-04)

Read `src/webview/AgentForm.ts` (host) + `src/webview/formLogic.ts` (pure logic) end to end against the
shell built in T1-T5. Verdict: **rewrite-to-config, not host-side adaptation-in-place** — the current shape
and the post-dismemberment target are different enough that "adapt AgentForm.ts to implement
StudioHostAdapter" is the wrong frame. The LOGIC survives almost entirely; the HOST GLUE and the tab shell
do not.

**Why adaptation-in-place doesn't fit:**
- `AgentForm.ts` is a single **global** `let panel` — one studio at a time, no per-workspace/per-entity-id
  identity at all ("reopening resets state"). `StudioPanelManagerBase`'s whole lifecycle model is keyed on
  `(entityType, wsKey, entityId)`; there is no such key here to adapt, because there's no such concept yet.
- The 5-tab mega-form's raison d'être — shared `FormState` fields across kind switches, `inferKind`-driven
  "switch tab?" hints, one panel title that changes as the active tab changes — has **no home** in a
  single-document shell and was already ruled dissolved by the maintainer's amendment. There's nothing to
  "port": that plumbing should be deleted, not translated.

**Why the logic survives:** `formLogic.ts`'s `fromDef`/`fromCommandDef`/`fromRunbookDef`/`fromScheduleDef`
(load), `validateForm`/`blockingErrors` (validation), and `toEntry` (save patch) are ALREADY shaped almost
exactly like `StudioHostAdapter.load`/`validate`/`save` — and `toEntry` already writes the WHOLE state
wholesale on every save (no granular dirty-patch composition), which is precisely the `serializePatch(fields,
dirty) => dirty ? fields : undefined` simplification Fake 1's `pipeline-studio/domain.ts` already uses. Each
dismembered studio (New Agent / New Terminal / New Command / New Runbook / New Schedule) gets its OWN thin
adapter reusing these helpers directly — `quickAddChips`, `toggleFlag`, `parseSteps`, `parseWatch`,
`suggestName` need zero changes.

**Needed shell APIs this spike surfaces (must exist before the Agent dismemberment task is queued):**
1. **`StudioLoadResult<TEntity>` needs an adapter-declared reference-data slot.** AgentForm's `init` payload
   carries the entity's own fields PLUS adjunct catalog data it isn't part of — `detectClis()` (quick-add
   chips), `takenNames()`, `commandNames()`, `verifyCandidates()`. Task Studio's `knownAgents` VM field is
   the same shape. `adapter.ts`'s `StudioLoadResult<TEntity>` has no slot for this today — it needs an
   optional `referenceData` (opaque to the shell, adapter-typed, shipped alongside `entity` in the `load`
   message) before any real studio can migrate.
2. **Two recurring domain-action PATTERNS worth naming in the README, not new primitives:** (a) a native
   picker round trip (AgentForm's `browse` folder dialog; Pin/Task's `importImage`) and (b) a host-side
   "infer and suggest" round trip (AgentForm's `inferKind` → "switch tab?" hint — post-dismemberment this
   would become "infer and suggest a DIFFERENT dismembered studio", a one-time domain action, not a tab
   switch). Both already fit the existing registered-domain-message slot end to end (proven live by Fake 1's
   `importStages`/`stagesImported` pair in T4) — no shell change needed, just a documented example.
3. **No bypass hook was found.** Nothing in AgentForm's behavior needs a hook outside the seven declared
   categories (identity/lifecycle, navigation-N/A, layout regions, domain fields, validation, persistence,
   concurrency, domain actions) — a good signal the adapter surface budget (README.md, T7) is right-sized,
   not just untested against a real form.

**Not a gap, just a note:** i18n already matches the shell's intended direction — `AgentForm.ts` computes
`studioStrings()` host-side via `vscode.l10n.t()` and ships the whole object in `init`; that's the same
host-computed-strings shape the shell's `labels` contract already assumes (`StudioFrame.labels`).

## Amendment 2 (2026-07-04, Phase 2 — approved by claude, filed by taskStudioMig, pin p-9eb9bd)

Phase 2 (Task Studio migration) surfaced a REAL shell gap — exactly the "shell reveals what it lacks at the
first rich real consumer" that the design anticipated: StudioPanelManagerBase.open() hardcodes its
renderWebviewShell() call, so an adapter/surface cannot request connectSrc/workerSrc/childSrc/imgBlob or a
bootstrapGlobals hook — all ALREADY supported by shared/shell.ts's WebviewShellOptions. Task Studio's
Excalidraw sketch (TaskStudioPanel.ts:73-87) needs exactly these; unlike attachments/new-id, it cannot be
dodged adapter-side (CSP + inline globals are composed by the base, not the domain).

APPROVED as an additive, opt-in, backward-compatible amendment (the Phase-1 fakes pass none of these and are
unaffected): extend StudioSurfaceConfig with optional imgBlob/connectSrc/workerSrc/childSrc fields + an
optional bootstrapGlobals(uriHelper) hook, threaded through open()'s existing renderWebviewShell call. This
is the sanctioned way to touch shared/studio/ — the adapter-surface budget (Amendment/dueto F9) is preserved
because these are declarative surface config, not a hook that bypasses header/dispatch/gating/save-cancel.
taskStudioMig implements it as a prerequisite step of Phase 2 (a new T1.5, before the panel T2 wiring).

## Amendment 3 (2026-07-04, Phase 2 — approved by claude, filed by taskStudioMig)

Second real shell gap from the Task Studio migration: StudioPanelManagerBase's "cancel" case
(StudioPanelManagerBase.ts:182) disposes the panel directly with no adapter hook, so 339's
cleanup-orphaned-attachments-on-cancel behavior can't run — cancelling a new-task after staged-create began
leaves the sidecar/attachments orphaned (disk hygiene; NO data loss / broken feature; 13/14 taskStudioPanel
tests pass otherwise). APPROVED as an additive, opt-in `onCancel?(entityId): Promise<void> | void` hook on
the StudioHostAdapter, awaited before dispose in the cancel case. Backward-compatible (Phase-1 fakes don't
implement it → unchanged). Within the adapter surface budget: `cancel` is an existing lifecycle stage the
budget explicitly lists — this is a lifecycle hook, not a bypass of header/dispatch/gating. Same sanctioned
pattern as Amendment 2 (CSP passthrough). taskStudioMig implements it as part of Phase 2, then the 339
cancel-cleanup test passes UNCHANGED (the regression guard held: the test failing WAS the signal, not a test
to weaken).
