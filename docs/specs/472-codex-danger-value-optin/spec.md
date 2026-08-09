# 472 — codex-danger-value-optin

_Created 2026-07-26._

**Status:** shipped
**Closure:** Shipped in the t-b0440a worktree: `approval_policy`/`sandbox_mode` held to enums
measured against `codex-cli 0.145.0`, the two dangerous values gated behind per-agent
`authorize: [neverAskForApproval|dangerFullAccess]`, the SDD 471 authorization gate generalized
per runtime, Agent Studio controls with localized risk copy, and fresh/restart/resume projection.
Evidence: `npm run verify:full:quiet`, `node scripts/dogfood/run.mjs codex-danger-optin` (7/7), and the Visual QA
screenshots under `evidence/`.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**Verify:** `npm run verify:full:quiet`
**Dogfood:** `node scripts/dogfood/run.mjs codex-danger-optin`

## Intent

SDD 471 made Claude's `bypassPermissions` require a deliberate per-agent authorization: the global
file supplies a value, the profile authorizes it, and inheritance alone is never enough. Codex has
no equivalent gate at all — `projectCodexScalarNativeConfig` reads `approval_policy` and
`sandbox_mode` through a type-only check, so **any** string passes.

The consequence is the same class of problem, running the other way: a person whose
`~/.codex/config.toml` says `approval_policy = "never"` or `sandbox_mode = "danger-full-access"`
gets that projected into a canonical agent's private `CODEX_HOME` silently, just because they had it
globally. A canonical Codex agent can be born with no sandbox and no approval prompt without anyone
deciding to. A canonical profile is meant to describe the agent's authority, not mirror the human's
ambient defaults.

Done looks like: the dangerous values, measured against the real CLI, refused by default with a
diagnosis naming the key, the value and the way out, and projectable only when the agent's own
profile authorizes them — reusing the `authorize` mechanism SDD 471 built, so the two runtimes share
one concept instead of growing two.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: a dangerous global value is not inherited without authorization**
  - **Given** a canonical Codex profile selecting the permissions family from `global`, with no
    authorization declared, and a `~/.codex/config.toml` whose `approval_policy` is `never`
  - **When** the profile is projected
  - **Then** activation is refused, the refusal names `approval_policy`, the value `never` and the
    way out, and nothing is projected.
- [x] **Scenario: `danger-full-access` is refused the same way**
  - **Given** the same profile and a global `sandbox_mode = "danger-full-access"`
  - **When** the profile is projected
  - **Then** activation is refused naming `sandbox_mode` and that value.
- [x] **Scenario: explicit authorization projects the measured value**
  - **Given** a profile declaring the matching authorization on its permissions policy
  - **When** it is projected
  - **Then** the dangerous value reaches the projection and activation succeeds.
- [x] **Scenario: authorization is per-agent, not ambient**
  - **Given** two canonical Codex agents reading the same global config, one authorized and one not
  - **When** both are projected
  - **Then** only the authorized one projects the value.
- [x] **Scenario: the safe measured values keep working untouched**
  - **Given** a profile selecting permissions from `global` and a config using any non-dangerous
    measured value (`untrusted`, `on-failure`, `on-request`, `read-only`, `workspace-write`)
  - **When** it is projected
  - **Then** it projects with no authorization required and no new error.
- [x] **Scenario: authorization survives every Codex lifecycle phase**
  - **Given** an authorized canonical Codex agent
  - **When** it is started fresh, restarted and resumed
  - **Then** each private `CODEX_HOME` generation carries the same authorized value.
- [x] A value outside the measured enums is refused as unsupported rather than projected blindly.
- [x] The Codex authorizations are refused on a non-Codex adapter, on any family other than
  permissions, and for unknown members — mirroring the Claude rule, with neither runtime able to
  claim the other's authorization.
- [x] Agent Studio offers the Codex authorizations explicitly, off by default, only for Codex and
  only while the permissions family is projected, with localized risk copy.
- [x] The accepted value sets are recorded as measured against a named Codex CLI version, and
  `docs/runtimes/parity.md` reflects the new contract.

## Non-goals

- Changing Claude's behavior or the `authorize` mechanism SDD 471 shipped.
- Authorizing anything outside `approval_policy` and `sandbox_mode`.
- Supporting the `granular` approval policy: it is a newtype variant (a TOML table, not a scalar),
  so it is outside the scalar projection this spec touches.
- Widening the projected key allowlist, or relaxing the workspace fail-closed rule.
- Publishing a release or touching Marketplace state.

## Open questions

None blocking. Which values count as dangerous is settled by measurement plus the CLI's own naming
(`danger-full-access`) and documented semantics (`never` = never ask for approval); recorded with
the measurement transcript in `plan.md`.
