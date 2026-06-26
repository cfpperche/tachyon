# 266 — notes

## Motivation (live dogfood)

The dev dogfood install (this repo's `.tachyon/plugins.lock.json`) pins `secrets-guard` `@v0.5.0` (manifest
1.0.0, single-layer) and `sdd` `@v0.5.0`. The source repo `cfpperche/tachyon-plugins` has since published tag
`v0.6.0` carrying `secrets-guard` **2.0.0** (the two-layer gate: gitleaks pre-commit hook + a PreToolUse
shape-gate). Check updates reports "up to date" because it re-resolves the immutable `@v0.5.0` pin. This spec is
what lets that dogfood actually discover and adopt `@v0.6.0` — and the update is the spec's live acceptance.

## Key decision — repo tag selects the ref, manifest version decides the outcome

A monorepo tags many plugins together. The repo's highest semver tag (`v0.6.0`) is **not** a plugin version; it
only chooses **which ref to evaluate**. The existing 3-way `previewUpdate` (manifest version + hook drift) is the
sole authority on "newer / drift / downgrade / up-to-date". So bumping the evaluated ref to a tag where THIS
plugin's manifest is unchanged still reports up-to-date — no false positives, and the same path handles the
real bump (secrets-guard 1.0.0 → 2.0.0) without a second code path. This is why the fix is a thin "effective
ref" selector in front of the unchanged load→preview→provenance pipeline, not a new update mechanism.

## Reproducibility invariant

The bump rewrites one immutable tag pin to another (`@v0.5.0` → `@v0.6.0`). Tachyon never floats to a moving
"latest", and the lockfile's re-pinned `resolvedCommit`/`integrity` keep a reinstall byte-reproducible at the new
pin. Branch/`HEAD`/SHA/non-semver pins are deliberately ineligible — only a current pin that is itself a semver
tag can be bumped to a higher semver tag.

## Fail-closed posture

A latest-tag probe (`ls-remote --tags`) that errors or finds nothing higher degrades to today's exact-ref check
— a network blip must never turn a green "up-to-date" red. The rewritten ref is the verbatim author tag,
re-validated by `parseSource` before any git shell-out (no argument injection past the existing guards).

## Decisions & deviations

- **Comparator unified (`source.compareSemver`).** `engine.compareVersions` previously parsed char-by-char and
  would have mis-read a `v`-prefixed tag (`v0` → NaN→0); it now delegates to the single tolerant `compareSemver`
  (also `v`-stripping), so the manifest-version and tag orderings can never drift. Behavior for plain manifest
  versions (no `v`) is unchanged.

- **codex dueto BLOCK folded — branch-vs-tag disambiguation.** `parseSource` classifies any non-SHA/non-HEAD ref
  as `refKind: "named"` (branch OR tag), and `parseSemverTag` only checks the NAME shape. So a plugin pinned to a
  **branch** named `v1.0.0` would have been mis-treated as a tag pin and silently bumped to `@v1.1.0`, violating
  the "branch pins unchanged" invariant. Fix: `resolveLatestSemverTag` now also returns the full repo tag-name
  list, and `resolveEffectiveUpdateSpec` only bumps when the current ref is **proven present as a real tag**
  (`tags.includes(currentRef)`). A semver-shaped branch (absent from the tag list) is left untouched. Regression
  test added (`@v1.0.0` branch + repo tag `v1.1.0` → original spec unchanged).
