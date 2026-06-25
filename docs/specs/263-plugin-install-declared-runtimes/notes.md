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

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._
