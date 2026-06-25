# 264 — plugin-git-hook-target — notes

_Created 2026-06-25._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

### 2026-06-25 — origin

Spec A of a two-spec arc (264 git-hook target → 265 tool/binary provisioning) decided in a design discussion: evolve the plugin system to do secrets-scan PROPERLY (real commit-time enforcement + a provisioned scanner binary) instead of a runtime-hooks-only band-aid. The maintainer rejected making secrets-scan engine-native — the plugin layer already owns the consent/lockfile/TOCTOU trust machinery, so extending it is more consistent than carving an engine exception. Linux/WSL/macOS only (no Windows). 264 ships first (the real enforcement, with a detect-and-guide fallback for the missing binary); 265 closes the fail-closed story by guaranteeing the binary is present.

## Deviations

## Tradeoffs

## Open questions
