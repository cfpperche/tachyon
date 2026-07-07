# 350 Phase 4 — finish the dismemberment (Terminal/Command/Runbook/Schedule) + retire AgentForm.ts — plan (t-4c4de4)

_Drafted 2026-07-06 by claude (coordinator). Continues Phase 3 (Agent pilot, DONE+visual-passed). Phase 3's
plan named this "the other 4 follow the mold in a second wave." Hardened by an adversarial codex dueto
(probe-c862e363, 2026-07-06): **the naive "mirror the agent pilot ×4" is wrong** — 2 blockers + 5 majors below
reshape it. GUARD (unchanged from Phase 3): `formLogic.ts` tests (`test/unit/agentStudio.test.ts`, 38) stay
green UNCHANGED — the validated domain contract; a test needing a real change = regression, STOP._

## What's already done (Phase 3)
Agent kind → `agent-studio-shell` (adapter `AgentStudioAdapter`, panel `AgentStudioPanel`, concurrency
`{kind:"none"}`). Legacy `AgentForm.ts` (`openAgentStudio(deps, existing?, kind)`) STILL serves the other 4
kinds via its tabs, wired from ~8 entry points in extension.ts (new terminal/command/runbook/schedule + edit
per kind + palette). `formLogic.ts` already exposes every load helper the 4 studios reuse: `fromCommandDef`,
`fromRunbookDef`, `fromScheduleDef` (+ `fromDef`), `toEntry`, `validateForm`/`blockingErrors`, `parseSteps`,
`parseWatch`, `stepResolutions(raw, commandNames)`, `quickAddChips`, `suggestName(base, taken)`.

## Dueto-mandated design changes (why this isn't "just mirror it")

### STEP 0 (base-contract amendment, BEFORE any studio) — `referenceData` WITH refresh
Dueto blocker #1 + major #3. Adjunct catalog data (Runbook's `commandNames`, Agent's `detectClis`, everyone's
`takenNames` for `suggestName`) must NOT live in the persisted entity payload (blurs domain boundary; risks
round-tripping through `toEntry`). Add an **additive `referenceData` slot** to `StudioLoadResult`
(`adapter.ts:35`), typed per adapter, shipped alongside `entity` on `load`. **Runbook forces refresh
semantics**: the command catalog changes while a runbook studio is open, so a load-time snapshot goes stale →
false unresolved steps. So the contract needs a **push/refresh path** (host pushes updated `referenceData` into
the open webview when the catalog changes, or a `requestReferenceData` round trip), NOT an immutable load-time
blob. Sanctioned additive amendment (same discipline as Amendments 2–5 in notes.md). Tests: `toEntry` ignores
`referenceData`; Runbook resolution uses REFRESHED `commandNames` (add/rename/delete/import a command with a
studio open).

### Ordering is dependency-driven, NOT independent (dueto #7, #6)
1. **Terminal** — simplest, no cross-kind coupling. The re-established pilot for the non-agent mold.
2. **Command** — BEFORE Runbook. Defines the command catalog + its invalidation/refresh behavior.
3. **Runbook** — consumes the live command catalog (Step 0 refresh). Verify rename/delete/import scenarios.
4. **Schedule** — LAST. Dueto #6: not just a persisted doc — timers / next-run / scheduler re-registration may
   fire on save. Mirroring the agent adapter will persist the entry but may fail to re-register timers. Verify
   runtime scheduler side effects on create/edit/delete/save; may need a post-save adapter hook.

### No split-brain during coexistence (dueto #4)
Each kind migrates FULLY & atomically — every public + internal route (new + edit-existing + palette + sidebar
"+") flips to the new studio in the SAME change. AgentForm keeps serving only the not-yet-migrated kinds. Never
leave one route for a kind on legacy while another is on the new studio (divergent validation/i18n/defaults).

### Cutover = behavior migration, not cleanup (dueto blocker #2, major #5)
The riskiest deletion is the **open-existing-entry** routing. Before deleting `AgentForm.ts`:
- Build a **dispatch table keyed by persisted `entry.kind`** → the right studio's `openExisting`. Add
  command-level tests opening ONE existing entry of each kind and asserting the specific studio/panel selected.
- Enumerate every SIDE EFFECT of the legacy `studioSubmit` path (tree refresh after save, schedule timer
  resync, sidebar selection, focus restoration, error mapping, telemetry) and reproduce each in the studio save
  path or prove it obsolete. Smoke coverage per kind: save success, validation failure, cancel/dirty, post-save
  refresh.

### Delegation shape (dueto #8, #9)
Sequential single codex (shared hotspots: extension.ts, esbuild.mjs, l10n bundle → parallel = contention).
**HARD CHECKPOINT after Terminal** (the first non-agent) — I review shell contract, wiring, i18n, save side
effects, tests — BEFORE cloning the pattern to Command/Runbook/Schedule, so a missed side effect isn't cloned
4×. Before creating 4 full 6-file surfaces (24 files), the implementer identifies what is truly kind-specific
vs shared webview glue and shares primitives where the agent pattern already allows — without touching
formLogic. Maintain a **migration matrix** per kind: command ID · palette contribution · sidebar-"+" route ·
edit route · esbuild entry · i18n keys · panel manager · adapter · tests.

## Per-studio recipe (mirrors the Agent pilot)
Each of Terminal/Command/Runbook/Schedule: `<Kind>StudioAdapter.ts` (wraps formLogic `from<Kind>Def`/`toEntry`,
`concurrency {kind:"none"}`, dirty hooks, `referenceData`) · `<kind>-studio-shell/` webview surface (App/css/
domain/main/messages/types, minus shared primitives) · `<Kind>StudioPanel.ts` (StudioSurfaceConfig viewType +
iconName, Manager openNew/openExisting over StudioPanelManagerBase) · esbuild entry · extension.ts wiring
(section "+" + `tachyon.new<Kind>Studio` palette + edit route + panel serializer) · i18n en/pt-br.

## Done-when (Phase 4 / t-4c4de4 complete)
All 4 kinds create + edit via their own studio; every legacy route rewired; `AgentForm.ts` + `agent-studio/`
legacy tab glue DELETED; `formLogic.ts` core (from*Def/toEntry/validate) SURVIVES and its 38 tests green
UNCHANGED; full `npm test` + 3 typechecks green; per-kind command-level edit-routing tests + scheduler
side-effect test present; visual pass per studio. Then t-24f87c/t-1115bb/t-4c4de4 all →done as the 350 ship.
