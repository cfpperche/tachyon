# 451 — pi-canonical-exact-trust

_Created 2026-07-25._

**Status:** shipped
**Closure:** `t-20c856` shipped exact canonical Pi trust across fresh/restart/resume, with Pi 0.80.10 TTY dogfood and integrated verification recorded in `notes.md`.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`

## Intent

Canonical Pi homes currently copy ambient `trust.json` once and then preserve it as runtime-owned
state. Pi's native trust lookup accepts canonical path grants from any ancestor, so this imports
unrelated authority and retains stale grants or denials through restart and resume.

Canonical profiles must instead regenerate a native trust store containing exactly the workspace root
and effective launch cwd on every lifecycle launch. Other private Pi homes retain their existing
runtime-owned settings and trust behavior.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: Exact trust on every canonical lifecycle launch**
  - **Given** a canonical Pi profile whose ambient and private trust stores contain unrelated grants,
    denials, or parent entries
  - **When** it is spawned fresh, restarted, or resumed with an effective cwd
  - **Then** its private `trust.json` contains only canonical workspace-root and cwd keys set to
    `true`, with duplicates removed
- [x] **Scenario: Canonical trust replacement preserves the rest of the private home**
  - **Given** canonical Pi auth, settings, captured resources, sessions, and Bridge wiring
  - **When** exact trust is regenerated
  - **Then** those unrelated artifacts remain available and unchanged by the trust replacement
- [x] **Scenario: Non-canonical Pi remains runtime-owned**
  - **Given** an ordinary private Pi home with a runtime-authored trust decision
  - **When** it is rematerialized
  - **Then** Tachyon validates but does not replace that trust decision
- [x] The exact trust target is a regular no-follow JSON-object file, atomically published with mode
  `0600`.
- [x] Pi 0.80.10 real-runtime dogfood enters a trust-gated project without showing the trust prompt
  when launched from the exact canonical private home.
- [x] `docs/runtimes/parity.md` records the completed Pi exact-trust lifecycle evidence.

## Non-goals

- Changing Pi's auth snapshot or single-live-Pi concurrency policy.
- Changing project trust for non-canonical/legacy Pi agents.
- Treating project trust as an OS sandbox or granting paths broader than workspace root and cwd.
- Changing Pi's native schema, `/trust` command, or project-resource discovery.

## Open questions

None. Runtime schema and semantics were established by `t-68ee7a`.
