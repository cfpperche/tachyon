# 455 — claude-canonical-parity

_Created 2026-07-25._

**Status:** shipped-partial
**Closure:** Canonical Claude now has a launch-boundary fresh/restart/resume exact-projection test; Claude Code 2.1.220 permission and isolated interactive-stop measurements are recorded in `runtimeProfile`; active/drafted stop and authored native permission-policy precedence remain explicit follow-up `t-b727bd`. Existing Soul startup-argument dogfood (`t-2278bc`) remains the delivery evidence.
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Canonical Claude already uses a private `CLAUDE_CONFIG_DIR`, recreates its workspace settings/skills/MCP
projection, and limits folder trust to the workspace plus effective cwd. But its capability model still
describes graceful stop as unmeasured, supplies no measured permission profile, and has no lifecycle
proof that the canonical private home remains exact through fresh spawn, restart, and resume.

Close those gaps without treating the ad-hoc `--permission-mode auto` convenience as canonical policy.
Any profile-native permission projection must be explicit, lifecycle-safe, and must not widen a user
choice or inject bypass mode.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: canonical Claude lifecycle**
  - **Given** a canonical Claude profile with its supported workspace configuration and effective cwd
  - **When** it is freshly spawned, restarted, and resumed
  - **Then** its private home has identical generated settings/skills/MCP/trust state, external credentials
    remain external, and stale ambient or sibling state is absent.
- [x] Claude's declared permission behavior distinguishes a canonical profile policy from the ad-hoc
  ownership-only `auto` convenience and never introduces bypass mode.
- [x] Graceful stop has isolated interactive evidence; active/drafted states remain explicitly unverified
  and require the concrete follow-up recorded with this slice.
- [x] Soul delivery is proven for a canonical Claude lifecycle without claiming that the provider consumed
  the content.
- [x] The parity matrix reflects only the evidence obtained by this slice.

## Non-goals

- Bypassing Claude permissions, sandboxing, hooks, or provider confirmation prompts.
- Broadly importing ambient CLAUDE.md, plugins, commands, or agents into canonical profiles.
- Claiming that startup-prompt delivery proves model obedience.

## Open questions

Whether Claude's native `permissions` settings can be safely represented as an authored canonical policy,
rather than only as a validated workspace projection. Resolve by measuring the installed CLI and retaining
the existing workspace-copy behavior if the native precedence or schema is not safe to project.
