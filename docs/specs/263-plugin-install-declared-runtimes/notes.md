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

### 2026-06-25 — build complete; live cutover validation pending

All 9 tasks + 8 acceptance checks implemented and green (full suite 1423 passed, typecheck clean, webview esbuild clean). Commits `8c1eeaa`→`85072bd`. Status → in-progress (not shipped) because the build's purpose is the Agent0→Tachyon cutover, which needs the **live human drive** before shipping: install `github:cfpperche/tachyon-plugins@v0.3.0#path=sdd` into a FRESH `/home/goat/tachyon` (no `.claude`/`.codex`) via the Plugins View → the drawer must show claude+codex as *will be created* toggles → Install → confirm `/sdd` lands in `.claude/skills/sdd` + `.agents/skills/sdd` → remove → confirm the created dirs are cleaned. Once that passes, flip to shipped and proceed to the cutover (delete `.claude`/`.codex` from the Tachyon repo, prove the migrated SDD plugin is the only path).

### 2026-06-25 — live cutover validation PASSED → shipped

Drove the Plugins View against a fresh `/home/goat/tachyon` (the `.claude`/`.codex` had been deleted earlier). The consent drawer for `sdd@1.1.0` from `github:cfpperche/tachyon-plugins@v0.3.0#path=sdd` showed the per-runtime selector with **claude + codex both as "will be created"** toggles (the exact spec-263 surface — replacing the old "skipped (not present)"), plus the honest skills-only warnings. Install → toast "Installed sdd into claude, codex" and the tree gained `.claude/skills/sdd/` AND `.agents/skills/sdd/` (scripts + templates + SKILL.md). Status → shipped; closure recorded in `spec.md`.

Observed minor follow-up (NOT part of this spec): the installed-card runtime pill showed `codex —` because it derives "present" from `detectRuntimes` (`.codex/` existence), but a skills-only codex install writes to `.agents/skills/` and never creates `.codex/`. codex *was* installed (lockfile + skill on disk). The pill should reflect the lockfile's recorded runtimes for skills-only/`.agents`-targeted installs. Filed in the closure as a follow-up. (FIXED 2026-06-25, commit `73a700c`: the pill now reflects on-disk materialization via the lockfile targets; the Remove drawer was also fixed to count skills+MCP, not just hooks — `d2f4a0e`.)

### FOLLOW-UP (open) — gitignoring plugin-materialized output should be a USER decision

During the "prove the plugin is the only SDD path" audit, we found the plugin-materialized runtime dirs (`.claude/`, `.agents/`, `.codex/`, `.mcp.json`) were not ignored, so a reinstall would dirty the repo and could re-commit a capability's output. We gitignored them in THIS repo (commit `7049198`) so the Tachyon dogfood repo stays clean and "the plugin is the only SDD path" holds.

**But this is a per-project policy choice, not a universal one** — a consuming team may legitimately want to COMMIT their installed plugin output so the whole team shares the same materialized skills/hooks without each member re-installing. The plugin system should NOT hardcode "ignore plugin output"; it should let the user/consumer decide (e.g. a documented recommendation + an optional `.gitignore` snippet the installer can opt into, or a per-workspace setting). **Action when revisited:** treat gitignoring of `.claude/.agents/.codex/.mcp.json` as a consumer choice; keep this repo's ignore (it's the right call for the Tachyon dogfood repo) but do not bake the assumption into the engine/docs as mandatory. Deferred per the maintainer (2026-06-25): keep as-is for now, surface to the user as a decision later.
