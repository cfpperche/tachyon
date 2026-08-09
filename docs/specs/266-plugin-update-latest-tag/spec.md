# 266 — plugin-update-latest-tag

_Created 2026-06-26._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

**Closure:** Latest-semver-tag detection in front of the unchanged load→preview→provenance pipeline:
**Verify:** `env -u TMUX npx vitest run test/unit/pluginSource.test.ts test/unit/pluginFetcher.test.ts test/unit/pluginEngine.test.ts`
`source.parseSemverTag`/`compareSemver` (now the single comparator — `engine.compareVersions` delegates)/
`rewriteRef`; `fetcher.resolveLatestSemverTag` (`ls-remote --tags --refs`, returns the full tag list);
`engine.resolveEffectiveUpdateSpec` (bump only when the current ref is PROVEN a real tag, then to a strictly
higher semver tag); wired into `PluginsPanel.checkUpdates` + `previewUpdateOp` (a forced reinstall never bumps).
Codex dueto raised one BLOCK (a semver-shaped BRANCH could be mis-bumped) — folded via the tag-membership proof
+ regression test; re-review SHIP, no residual findings. Full gate green (1610 vitest + tsc×2 + engine-boundary
+ esbuild). **Live-proven against the real `cfpperche/tachyon-plugins` repo:** `@v0.5.0` → bumped `@v0.6.0`,
`previewUpdate` 1.0.0→2.0.0. **Part 2 (dogfood):** the dev install of `secrets-guard` was taken to `@v0.6.0`
2.0.0 (two-layer) — Layer 1 (gitleaks pre-commit via the Tachyon dispatcher) blocks a staged private key (commit
exit 1); Layer 2 (claude+codex PreToolUse shape-gate) blocks `--no-verify` / compound `add && commit` and allows
a clean commit / a valid `# OVERRIDE`. Deviation: adopting Layer 2 needed a remove+reinstall (spec 263 — an
update keeps the consented runtime set, and the 1.0.0 install had none), not a plain update. Dogfood state is
gitignored (per-machine), so Part 2 has no commit. NOTE: the detection ships to the live VS Code UI only after a
`.vsix` rebuild + reload (the running 0.43.1 build predates this); not packaged here (publish stays gated).

## Intent

"Check updates" re-resolves a plugin's **exact** pinned source ref. A plugin pinned to an immutable tag
(`github:org/repo@v0.5.0`) therefore re-resolves to the **same** commit, loads the **same** manifest version,
and is forever reported "up to date" — even when the source repo has published a newer tag (`@v0.6.0`) carrying
a newer plugin. A branch pin (`@main`) or `@HEAD` already follows the moving ref; an immutable tag/SHA pin
correctly does not. That immutability is a feature (reproducibility), but it means a tag-pinned plugin can
**never discover a newer release** — the package-manager job ("a newer version is available; bump?") is missing.

This spec adds **latest-version detection** to the update check: when a plugin is pinned to a **semver tag**,
Tachyon additionally resolves the source repo's **highest semver tag** and, if it is higher than the current
pin, evaluates the update **against that tag** — surfacing "update available" and, on the user's confirm,
bumping the pin to the newer immutable tag. Reproducibility is preserved end-to-end: the bump rewrites one
immutable tag pin to another; Tachyon never floats to "latest" silently and never resolves to a moving ref a
user pinned away from.

The version that decides "newer" stays the plugin's **manifest version**, not the repo tag. In a monorepo
where one tag (`v0.6.0`) ships many plugins, bumping the tag for a plugin whose manifest did **not** change must
still report "up to date". The repo tag only decides **which ref to evaluate**; the existing 3-way
`previewUpdate` (manifest version + hook drift/conflict) decides the outcome.

**Done** = a plugin pinned to a semver tag whose source repo has a higher semver tag is evaluated against that
higher tag: it reports "update available" iff the higher tag's manifest version is actually newer (and surfaces
drift/conflict/downgrade exactly as today otherwise); confirming the update re-pins the lockfile to the higher
immutable tag with full provenance/integrity. Branch/`HEAD`/SHA pins and non-semver tags are unchanged. No
network "latest" is ever fetched outside an explicit Check-updates / update action.

## Acceptance criteria

- [x] **Scenario: a tag-pinned plugin discovers a newer repo tag**
  - **Given** an installed plugin pinned `github:org/repo@v0.5.0#path=p` (manifest 1.0.0) and the source repo
    has tags `v0.5.0` … `v0.6.0`, where `v0.6.0` ships that plugin at manifest 2.0.0
  - **When** the user runs Check updates
  - **Then** the card reports **update-available** with `latestVersion` = the higher tag's manifest version
    (2.0.0), derived by re-resolving the source against `@v0.6.0` (not `@v0.5.0`).

- [x] **Scenario: a monorepo tag bump that does not change THIS plugin reports up-to-date**
  - **Given** an installed plugin pinned `@v0.5.0` whose manifest version is identical at `v0.6.0` (only a
    sibling plugin changed in the new tag)
  - **When** the user runs Check updates
  - **Then** the card reports **up-to-date** — the higher repo tag selects the ref to evaluate, but the equal
    manifest version is the deciding signal (no false "update available").

- [x] **Scenario: confirming the update re-pins to the newer immutable tag**
  - **Given** Check updates reported update-available for a tag-pinned plugin via a higher tag
  - **When** the user confirms the update
  - **Then** `applyUpdate` materializes the higher tag's version and the lockfile's `source.spec`/`ref`/
    `resolvedCommit`/`integrity` are re-pinned to `@v0.6.0` (a still-immutable tag) — a later reinstall is
    byte-reproducible at the new pin.

- [x] **Scenario: branch / HEAD / SHA / non-semver pins are unchanged**
  - **Given** a plugin pinned `@main`, `@HEAD`, a 40-hex SHA, or a non-semver tag (`@nightly`)
  - **When** the user runs Check updates
  - **Then** the existing behavior holds verbatim: branch/HEAD re-resolve to the moving ref; a SHA/non-semver
    tag re-resolves to itself (up-to-date unless its content changed). No latest-tag bump is offered — only a
    current pin that is itself a semver tag is eligible.

- [x] **Scenario: latest-tag resolution fails closed and never blocks the existing check**
  - **Given** the `ls-remote --tags` lookup errors (network/auth/git-absent) or returns no semver tag higher
    than the pin
  - **When** the user runs Check updates
  - **Then** the check falls back to the current exact-ref behavior (re-resolve the pin as today); an auth
    failure surfaces the existing `AUTH_REQUIRED: <host>` shape. A failed latest-tag probe never turns a
    healthy "up-to-date" into an error.

- [x] **Scenario: a downgrade is never silently offered as an update**
  - **Given** a plugin somehow pinned **above** the repo's highest tag (e.g. local manual pin `@v9.9.9`)
  - **When** the user runs Check updates
  - **Then** no lower tag is offered as an update; the highest available tag is **not** higher than the pin, so
    the eligible-bump check declines and the existing exact-ref evaluation runs (up-to-date / its own result).

## Non-goals

- A registry or curated marketplace (`name@version` resolution) — that remains v2, built on top.
- Auto-update / background polling / a "latest" floating pin — detection is on-demand (Check updates) and the
  bump is always human-confirmed; Tachyon never silently follows a tag stream.
- Pre-release / build-metadata ordering nuance beyond major.minor.patch (the existing `compareVersions` numeric
  policy stands; a `-rc` suffix is ignored for ordering, consistent with the installed-version comparison).
- Per-plugin tags in a monorepo (e.g. `secrets-guard-v2.0.0`) — v1 reads repo-level semver tags only.
