# 456 — grok-canonical-parity

_Created 2026-07-25._

**Status:** shipped-partial
**Closure:** Canonical Grok now binds `HOME` and `GROK_HOME` to one private home, preventing ambient Claude settings discovery across fresh/restart/resume. An authored Grok permission-policy projection and live composer/attention evidence remain outside this slice.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Canonical Grok launches already create a private `GROK_HOME`, regenerate Bridge MCP and exact folder
trust across fresh/restart/resume, and retain external auth through a symlink/reconciliation boundary.
Yet the runtime profile still calls Grok project-scoped, which forces parented work through an
unnecessary isolated-worktree gate despite the private home being the actual transcript/config
namespace. The profile also describes native permission modes but does not distinguish an applied
canonical workspace policy from modes merely accepted by the CLI.

Make the private-home lifecycle truthful and test it at the AgentManager boundary. Measure the installed
Grok CLI and its native configuration documentation without sending a billable prompt. Apply only a
permission posture whose source and precedence are explicit; no implicit `--always-approve` or
`bypassPermissions` is permitted.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: canonical Grok lifecycle**
  - **Given** a canonical Grok profile, effective cwd, Bridge entry, and external auth
  - **When** it is freshly spawned, restarted, and resumed
  - **Then** it receives the same private `GROK_HOME` with exact trust and Bridge config, retains
    only external auth, and excludes stale state.
- [x] Canonical Grok isolation is private through its explicit launch environment, while legacy/ad-hoc
  runtime-wide isolation remains project-scoped.
- [x] Native permission modes and config precedence are recorded only to the strength actually measured;
  canonical spawn never gains `--always-approve` or `bypassPermissions` implicitly.
- [x] The parity matrix accurately reconciles attention, permission, profile, config and lifecycle evidence.

## Non-goals

- Introduce an ambient global or workspace config import without an authored, allowlisted profile policy.
- Make `--always-approve`, `--yolo`, or `bypassPermissions` a canonical default.
- Claim a composer or rate-limit parser without live evidence.

## Open questions

- Whether `[ui] permission_mode` and `[permission]` configuration can be source-scoped and regenerated
  safely from the canonical profile, rather than merely passed as a command policy. Resolve from the
  installed 0.2.112 CLI documentation and existing private-home materializer.
