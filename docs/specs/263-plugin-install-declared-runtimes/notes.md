# 263 — plugin-install-declared-runtimes — notes

_Created 2026-06-25._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

### 2026-06-25 — codex spec debate (NEEDS-REVISION → folded)

Adversarial codex review of the draft (transcript: Agent0 `.agent0/.runtime-state/codex-exec/20260625T173255Z-spec263-debate/`). Diagnosis confirmed correct (`detectRuntimes`-as-gate → `resolveCompat → missingFromWorkspace → skipped`). Verdict NEEDS-REVISION; all folded into `spec.md` acceptance:

- **BLOCKER — consent/TOCTOU vs deselection (D1).** The fingerprint covers the computed plan but not a separate runtime SELECTION; today `confirm` carries only token + skill/MCP decisions. → new scenario: `selectedRuntimes` is an input to preview + fingerprint; apply recomputes from the same selected set.
- **BLOCKER — D3 not reconstructible.** The lockfile records installed runtimes + targets but NOT which parent ancestors (`.claude/`, `.agents/`, …) Tachyon created → uninstall can't tell installer-created from pre-existing. → new scenario + D3 amended: persist `createdPaths`/`createdAncestors`, bound into the remove fingerprint.
- **HIGH — update symmetry.** `previewUpdate`/`applyUpdate` also pass `detectRuntimes(ws)`; install-declared + update-present would silently drop a runtime on drift repair. → new scenario: update/reinstall/checkUpdates target the consented installed set.
- **HIGH — partial failure.** Install is not fully transactional (payload+lockfile before settings/skills/MCP); creating new structure means claude-ok/codex-fail leaves orphan dirs + partial hooks. → new scenario: rollback OR record cleanup metadata before activation so `applyRemove` cleans newly created ancestors.
- **MEDIUM — deselect-all.** Undefined; D1 lets the user reach zero targets. → new scenario: confirm disabled / becomes cancel; never a payload-only no-op.
- **MEDIUM — regression invariant.** → new golden-style scenario: both-dirs-present preview byte-identical old vs new.
- **LOW — unsupported runtime.** → new bullet: declaring `gemini`/unknown still fails manifest validation before consent.

### 2026-06-25 — codex plan review (NEEDS-REVISION → folded)

Adversarial codex review of `plan.md` (transcript: Agent0 `.agent0/.runtime-state/codex-exec/20260625T175321Z-plan263-review/`). Corrected the plan's two load-bearing claims:

- **BLOCKER — fingerprint NOT "for free".** A declared runtime with no hooks/skills/MCP produces no per-`rt` artifact, so select vs deselect yields the same hash. → bind an explicit `targetRuntimes` into `InstallPreview` + `fingerprintOf`.
- **BLOCKER — `createdAncestors` preview-time is stale.** Ancestors are created during activation (`atomicWrite` l.106, skills `mkdirSync` l.904, MCP l.974), not preview. → compute inside `applyInstall` immediately before the lockfile write, from the fresh plan; drift → re-preview.
- **HIGH — schemaVersion bump breaks downgrade.** Parser hard-rejects ≠1 (l.219) + the lockfile is committed. → keep `schemaVersion: 1`, add `createdAncestors` as an optional plugin field (old parser ignores unknown fields).
- **HIGH — update runtime mismatch.** If the new manifest drops a runtime the lockfile recorded, deriving from `lock.runtimes` alone silently no-ops it. → target = `lock.runtimes ∩ new manifest.runtimes`; subset violation = incompatible-runtime error.
- **MEDIUM — remove validation.** Recorded ancestors need the same containment/normalize/dedupe/deepest-first validation as targets; use non-recursive `rmdir` (atomic empty-check); ENOENT/ENOTEMPTY = no-op.
- **MEDIUM — `atomicWrite` temp leak.** A failed write after creating the dir leaves a temp file → ancestor non-empty. → `try/finally` temp cleanup + failure tests.
- **MEDIUM — call sites.** Enumerated all 4 `detectRuntimes` gates + their new source of truth (in `plan.md` Risks).
- **LOW — confirm round-trip.** Host-owned preview recompute on each toggle (not selection-on-confirm).

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

### 2026-06-25 — confirm carries no `targetRuntimes` (the preview does)

The plan listed "carry `targetRuntimes` in `PendingOp` + the `confirm` message". Implemented as: the host-held `PendingOp.preview` (an `InstallPreview`) already carries `targetRuntimes`, and `confirmOp` applies with `new Set(op.preview.targetRuntimes)`. The `confirm` MESSAGE does NOT echo the selection — it would be redundant with the fingerprint check, which already binds `targetRuntimes` (task 2). A `reselect` round-trip re-previews host-side and replaces `op.preview`, so the held preview is always the consented selection. Net: one source of truth (the preview), no redundant message field, same safety (fingerprint TOCTOU).

### 2026-06-25 — engine param renamed `present` → `target`

`previewInstall`/`applyInstall`'s runtime-set parameter was renamed from `present` to `target` for honesty (it is now the materialize set, not "what exists on disk"). `previewUpdate`/`applyUpdate` DROPPED the parameter entirely (they derive `lock.runtimes ∩ new manifest` internally). `detectRuntimes` survives only as a drawer/card LABEL hint (present vs will-be-created), passed into `buildInstallConsent`/`buildUpdateConsent`.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._
