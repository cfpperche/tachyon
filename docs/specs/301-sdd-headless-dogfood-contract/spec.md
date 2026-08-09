# 301 — sdd-headless-dogfood-contract

_Created 2026-06-30._

**Status:** shipped
**Closure:** 2026-06-30 — SDD plugin source now has a preview-by-default `sdd-dogfood.sh`, `sdd-close` requires passing dogfood proof or a non-empty visible opt-out for shipped specs, docs/templates formalize Dogfood/Human dogfood and `shipped-partial`, and plugin manifest is bumped to 1.4.0. Validated by spec smoke, dogfood log, targeted plugin engine/manifest tests, typecheck, and a real engine materialization test into temp `.claude/skills/sdd` + `.agents/skills/sdd`.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes / placeholders). -->

**Verify:** `bash docs/specs/301-sdd-headless-dogfood-contract/smoke.sh verify && npm test -- --run test/unit/sddDogfoodMaterialization.test.ts test/unit/pluginEngine.test.ts test/unit/pluginManifest.test.ts && npm run -s typecheck`
**Dogfood:** `bash docs/specs/301-sdd-headless-dogfood-contract/smoke.sh dogfood`

## Intent

The SDD plugin already supports mechanical verification (`**Verify:**`) and closure hygiene (`sdd-close`), but it has no first-class way to require a real dogfood proof before a spec is declared shipped. Today dogfood evidence is written ad hoc in `notes.md` or closure prose. That works when a maintainer remembers to ask, but it is not a contract agents can consistently inspect or enforce.

Add a lightweight dogfood contract to SDD: shipped specs must either have a passing headless dogfood log produced by an executable dogfood command, or explicitly opt out with a non-empty reason. Human dogfood remains optional and documented as a checklist/route for maintainer approval. The contract must stay runtime-neutral, file-based, preview-by-default where commands are involved, and compatible with the current `verify`/`close` trust model.

## Acceptance criteria

- [x] **Scenario: headless dogfood is declared and previewed**
  - **Given** a spec whose `tasks.md` declares `**Dogfood:** `<cmd>``
  - **When** an agent runs the dogfood helper without `--run`
  - **Then** it prints the resolved spec and command(s), runs nothing, and writes nothing
- [x] **Scenario: headless dogfood executes and logs**
  - **Given** a spec whose `tasks.md` declares one or more `**Dogfood:** `<cmd>`` lines
  - **When** an agent runs the dogfood helper with `--run`
  - **Then** each command runs from the workspace root and a timestamped result is appended to `notes.md` under a dogfood log
- [x] **Scenario: shipped spec missing dogfood proof is blocked by close**
  - **Given** a spec with `**Status:** shipped` or `shipped-partial`
  - **When** `sdd-close` audits it
  - **Then** it reports a dogfood finding unless the spec has a passing `## Dogfood log` entry or a valid `**Dogfood-Opt-Out:** <reason>`
- [x] **Scenario: declared but unrun dogfood is blocked by close**
  - **Given** a shipped spec with `**Dogfood:** `<cmd>`` but no passing dogfood log
  - **When** `sdd-close` audits it
  - **Then** it reports dogfood as unrun/stale instead of accepting the declaration alone
- [x] **Scenario: opt-out requires a reason**
  - **Given** a shipped spec with `**Dogfood-Opt-Out:**`
  - **When** the opt-out reason is empty or whitespace
  - **Then** `sdd-close` reports an invalid opt-out finding
- [x] **Scenario: human dogfood is optional and visible**
  - **Given** a spec whose `tasks.md` declares human dogfood steps/checklist
  - **When** `sdd-close` audits it
  - **Then** the absence of completed human dogfood does not fail close, but the expected human route is documented for maintainer approval
- [x] The SDD skill docs define the difference between `Verify`, `Dogfood`, `Dogfood-Opt-Out`, and optional human dogfood.
- [x] The dogfood helper preserves the same containment and preview-by-default safety posture as `spec-verify.sh`.
- [x] `shipped-partial` is either formalized in the SDD status docs/templates or removed from this feature's logic; the plugin must not leave a status enum mismatch.

## Non-goals

- No Tachyon engine validator framework or automatic hook that runs dogfood on every edit.
- No runtime-specific Claude/Codex hook enforcement in v1.
- No interactive prompt; all command execution is explicit via `--run`.
- No requirement that every dogfood command prove user-facing UI manually; human dogfood remains opt-in.
- No migration of historical shipped specs beyond allowing `Dogfood-Opt-Out` with a non-empty reason where retroactive dogfood is not useful.

## Open questions

- Resolved: use a new `sdd-dogfood.sh` helper. `Verify` and `Dogfood` have separate semantics and logs.
- Resolved: dogfood logs include the current `git rev-parse HEAD` for audit, but v1 does not fail close on freshness.
