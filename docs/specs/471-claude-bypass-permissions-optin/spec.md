# 471 — claude-bypass-permissions-optin

_Created 2026-07-26._

**Status:** shipped
**Closure:** Shipped in the t-98427e worktree: per-agent `authorize: [bypassPermissions]`
on the Claude permissions policy, schema + per-runtime legality, projector, Agent Studio control with
localized risk copy, and fresh/restart/resume/fork projection. Evidence: `npm run verify:full:quiet`
(517 files, 5789 tests), `npm run dogfood -- claude-bypass-optin` (5/5), and the Visual QA screenshots
under `evidence/`. Codex confirmed to have no equivalent blocker; its own gap filed as `t-b0440a`.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

The canonical Claude projector refuses `permissions.defaultMode: "bypassPermissions"` outright
(`CLAUDE_PERMISSION_MODES` in `src/config/claudeNativeConfigProjection.ts`). That refusal is correct
as a default — `bypassPermissions` disables Claude's permission prompts, and silently inheriting it
from a person's own `~/.claude/settings.json` would hand a canonical agent that authority without
anyone deciding to. It is also, today, a dead end: a very common global setting makes the whole
Permissions family unusable, and the only way forward is to exclude the family entirely (`t-111190`).

The human decision is to support the value, but only as a deliberate, per-agent authorization. This
spec separates two things the current code conflates: the global file **supplying** a value, and the
profile **authorizing** it. Inheritance alone must never be enough. An agent whose profile does not
carry the explicit authorization keeps getting today's refusal; an agent whose profile does carry it
projects the measured value into its private `CLAUDE_CONFIG_DIR` on every lifecycle phase.

Done looks like: an explicit control in Agent Studio with unambiguous risk copy, an authorization
persisted in the canonical profile, a projector that reads authorization rather than trusting the
source file, and fresh/restart/resume/fork all materializing the same authorized generation.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: global bypassPermissions is not inherited without authorization**
  - **Given** a canonical Claude profile selecting the permissions family from `global`, with no
    authorization declared, and a `~/.claude/settings.json` whose `permissions.defaultMode` is
    `bypassPermissions`
  - **When** the profile is projected
  - **Then** activation is refused with the existing diagnosis naming the subkey, the value and the
    way out, and nothing is projected into the private home.
- [x] **Scenario: explicit authorization projects the measured value**
  - **Given** the same profile and global file, but the profile declares the explicit
    `bypassPermissions` authorization on its permissions policy
  - **When** the profile is projected
  - **Then** the projection carries `permissions.defaultMode: "bypassPermissions"` and activation
    succeeds.
- [x] **Scenario: authorization survives every lifecycle phase**
  - **Given** an authorized canonical Claude agent
  - **When** it is started fresh, restarted, resumed, and forked
  - **Then** each private `CLAUDE_CONFIG_DIR` generation contains the same authorized
    `permissions.defaultMode`, and the fork's own private home carries it too.
- [x] **Scenario: authorization is per-agent, not ambient**
  - **Given** one authorized canonical Claude agent and a second unauthorized one in the same
    workspace, both selecting permissions from the same `global` source
  - **When** both are projected
  - **Then** only the authorized agent projects the value; the other is still refused.
- [x] **Scenario: Agent Studio round-trips the authorization**
  - **Given** Agent Studio editing a canonical Claude agent
  - **When** the authorization control is enabled and saved, then the form is reloaded
  - **Then** the control reflects the saved state and the profile on disk carries the
    authorization.
- [x] The authorization control is only offered for Claude, only when the permissions family is not
  excluded, and is off by default for both new and existing agents.
- [x] The control's label and risk copy go through the Agent Studio translate function and are
  present in `l10n/bundle.l10n.json` and `l10n/bundle.l10n.pt-br.json`.
- [x] An authorization declared on a non-Claude profile, on a family other than permissions, or
  naming an unknown value is rejected by schema/policy validation rather than ignored.
- [x] Every other refused permission value stays refused, unselected global keys stay opaque, and
  unselected workspace keys stay fail-closed.
- [x] Codex is confirmed to have no equivalent creation blocker, with the finding recorded; any real
  Codex gap is filed as its own task rather than implemented here.

## Non-goals

- Authorizing any other Claude permission mode, or any dangerous value outside
  `permissions.defaultMode`.
- Copying unrestricted global settings, widening the projected key allowlist, or relaxing the
  workspace fail-closed rule.
- Changing Codex behavior, or any other runtime's permission handling.
- A workspace-wide or global "allow bypass" switch — the authorization is per-agent only.
- Publishing a release or touching Marketplace state.

## Open questions

None blocking. The authorization's storage shape (a declared list on the permissions policy versus a
separate profile block) is settled in `plan.md` with the rejected alternative recorded.
