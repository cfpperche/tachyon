# 438 — agent-profile-studio — notes

_Created 2026-07-22._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- 2026-07-22 — Architecture probe `probe-ba265098-ea19-4b80-9f94-8b08fb7ea578` correctly identified that the original task crossed four independently reviewable boundaries. The umbrella was decomposed into `t-fdb422`, `t-293326`, `t-ecd405` and `t-fa332a`.
- 2026-07-22 — Probe suggestions for a generic import-plan registry, conflict-choice framework and new secret-binding API were not adopted. Existing bundle import is already validate-before-commit and V1 does not edit secrets; adding those abstractions would not close current acceptance.
- 2026-07-22 — Canonical and legacy modes remain a discriminated boundary. Canonical persistence never receives the legacy `FormState` wholesale.
- 2026-07-22 — `t-fdb422` keeps the proven Agent Studio form as presentation state but adds an explicit canonical marker whose serializer emits only `{agentName, expectedRevision, editable:{displayName,runtime,role}}`. The engine accepts that closed schema and projects only secret names/binding counts, never environment values, secret provider/ID, reference paths or resolved config.
- 2026-07-22 — Canonical creation is disabled at the lifecycle level and canonical edits preserve unrelated prompt bindings by rebuilding the narrow top-level patch from the inspected CAS snapshot. Soul and Evolution remain separate protocols; their toggles cannot be serialized through canonical save.
- 2026-07-22 — `t-293326` exposes enable/disable, rename and forget as a closed revisioned lifecycle union, not as form fields. Rename and forget reuse their existing canonical transactions; forget additionally requires the exact agent name as confirmation. Errors are redacted, stale revisions trigger a fresh bounded snapshot, dirty forms cannot launch lifecycle actions, and rename/forget confirmations focus Cancel first.
- 2026-07-22 — The Control host was decoding a hardcoded `browse/cwd` domain subset even though adapters already declare their domain vocabulary. It now decodes `adapter.domainMessageNames`; without this correction Agent Studio's typed lifecycle messages (and other registered domain actions) could not reach their existing handler.
- 2026-07-22 — `t-ecd405` keeps portable bundles byte-exact: export and clone bind the loaded profile revision, import crosses the existing staged-payload seam with the bundle service's 256 KiB cap, and the Studio only projects digest plus reauthorization requirements. Clone/import call the V1 services directly and create disabled, grant-free identities; no bundle is reconstructed from form fields.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

None.
