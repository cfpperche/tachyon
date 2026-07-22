# 426 — agent-profile-migration — notes

_Created 2026-07-22._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## 2026-07-22 — boundary review

Probe `probe-44cae0a6-9037-4c2d-a7f3-a87eb85e0df2` rejected both a dormant migrator that could
write unreadable pointers and a broad loader that bypassed host authority/native attestation. The
accepted boundary is a narrow end-to-end vertical slice: strict source union, trusted read-only
resolution, measured adapter, offline migration command, exact preflight and recoverable rollback.
Unsupported fields remain wholly legacy. Full probe evidence is retained at
`.tachyon/probes/probe-44cae0a6-9037-4c2d-a7f3-a87eb85e0df2/result.json`.

## 2026-07-22 — first trusted loading slice

The first adapter is intentionally narrower than the eventual migrator: it accepts only literal
`codex`, no runtime selectors, and requires every known Codex native config source to be absent or
whitespace-only. Inspection walks from retained directory descriptors and opens every component
without following symbolic links. A non-empty real user config therefore keeps that agent legacy;
support expands only with another measured inspector/projector revision.

`parseConfig` remains the side-effect-free legacy parser. `parseProfileAwareConfigSyntax` substitutes
only a non-authoritative placeholder for constructor-time workspace settings, while
`loadProfileAwareConfig` owns profile bytes, SecretStorage authority and native attestation. The
Workspace caches authority before its first trusted reload. A failed warm reload retains the old row
for visibility but explicitly blocks new starts of every previously profile-backed row. The LKG stores
profile identity/digests for rendering only.

The implementation uses a separate SecretStorage registry from Delivery authority heads. Corruption
in profile custody fails profile-backed agents closed without disabling Bridge caller identity or
Delivery authority. Migration-time authority mutation/reconciliation remains in `t-1d1842`.
