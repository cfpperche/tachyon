# 383 — primer-project-guidance-boundary

_Created and ratified 2026-07-14 from task `t-9cb29e` and the maintainer discussion that separated Tachyon protocol from project policy._

**Status:** shipped

## Intent

Tachyon currently mixes two different owners in the global primer it injects into agents. Identity, delegation-gate facts, continuity and the completion doorbell are Tachyon orchestration protocol; `npm ci`, Git staging/commit style and VS Code localization are policies of Tachyon's own repository. Because the same primer is used in consumer workspaces, those repository assumptions can be imposed on unrelated projects. The primer also invents `npm test` when no verification command is configured and can render an invalid `<your spawner>` notify target.

This spec establishes a hard ownership boundary. The product-global primer carries only universal Tachyon protocol plus project facts explicitly declared in `tachyon.yml`. A project may opt in to a separate, provenance-labelled `PROJECT GUIDANCE` block whose contents it owns. Tachyon transports that content without authoring, inferring or sharing it across workspaces. Tachyon's own repository rules move to such a project-owned document.

## Acceptance criteria

- [x] **Scenario: an unconfigured consumer receives product protocol only**
  - **Given** a workspace with no `settings.projectGuidance` and no `settings.verify`
  - **When** Tachyon composes onboarding for an agent
  - **Then** the primer contains identity and applicable orchestration protocol
  - **And** it contains no package-manager fallback, `npm ci`, `node_modules`, Git workflow, task-id commit wording or VS Code localization policy
  - **And** it contains no `PROJECT GUIDANCE` delimiters
- [x] **Scenario: configured verification is a sourced project fact**
  - **Given** a workspace that explicitly configures `settings.verify.full` and/or `settings.verify.typecheck`
  - **When** Tachyon renders the primer and before-finishing block
  - **Then** the configured commands appear exactly and are attributed to workspace config `settings.verify`
  - **And** an absent command is not replaced by `npm test` or another product default in onboarding
- [x] **Scenario: a project opts in to its own guidance**
  - **Given** `settings.projectGuidance.files` names one or more valid workspace-relative UTF-8 files
  - **When** Tachyon composes onboarding
  - **Then** their content is preserved verbatim and in configured order inside a distinct `PROJECT GUIDANCE (PROJECT-OWNED)` block
  - **And** every file is labelled with its workspace-relative source path outside the verbatim content
- [x] **Scenario: project guidance is isolated and current**
  - **Given** two configured workspaces with different guidance and a third unconfigured workspace
  - **When** agents are spawned or restarted in each workspace
  - **Then** each configured workspace receives only its own current content and the unconfigured workspace receives none
  - **And** changing a declared file is observed at the next injection without a process-global cache
- [x] **Scenario: invalid declared guidance fails closed**
  - **Given** a declared path that is missing, unreadable, absolute, traversing, a symlink leaf, outside the canonical workspace, non-regular, invalid UTF-8, duplicated or over the documented limits
  - **When** Tachyon attempts an injection
  - **Then** it reports a source-specific error before creating/replacing a session or typing a partial block
  - **And** failure in one workspace does not affect another workspace
- [x] **Scenario: every onboarding injection path uses the same ownership boundary**
  - **Given** configured project guidance
  - **When** an agent is spawned, restarted or re-anchored
  - **Then** the same primer/project-guidance/before-finishing ordering is used
  - **And** a long composed body uses the existing brief-file diversion before reaching tmux
  - **And** resume remains transcript-only as established by spec 363
- [x] **Scenario: universal protocol remains intact**
  - **Given** a parent/delegator and, optionally, a gated delegation
  - **When** onboarding is rendered
  - **Then** real-target doorbell, identity, gate test/stub/owns, continuity, long-finding and approval-confirmation guidance remains present
  - **And** no doorbell instruction is rendered when no real parent/delegator exists
- [x] **Scenario: Tachyon self-hosts the boundary**
  - **Given** this repository's bootstrap, Git workflow and localization conventions
  - **When** the repository configuration opts into project guidance
  - **Then** those conventions live in a repository-owned document referenced by `tachyon.yml`, not in `src/bridge/primer.ts`
- [x] `settings.projectGuidance` is an explicit closed config object with a required ordered non-empty `files` list; schema, README and tests document its ownership, precedence, path/size limits and errors.
- [x] Project guidance is delivered only to agent entries; terminal/server entries neither read nor receive it.
- [x] Startup delivery uses existing prompt-capable runtime adapters; explicit self-managed/resume commands and runtimes without a startup-prompt adapter preserve their launch semantics, while manual re-anchor remains available for running agents.
- [x] The line-by-line primer audit is recorded in the implementation plan and each emitted line is classified as universal protocol, explicitly configured project fact or removed project policy.
- [x] Runtime-specific context files such as `AGENTS.md` and `CLAUDE.md` are neither discovered nor made authoritative; Tachyon's owned push channel remains the transport.
- [x] Focused onboarding/configuration tests, typecheck and full repository verification pass.

## Non-goals

- Define or adopt the separate Product Invariant Testing standard tracked by `t-2b8808`.
- Redesign gated delegation's existing behavior-stub generator. Its `test/unit` + Vitest convention is
  a separate remaining project-assumption outside the primer and is explicitly carried into `t-2b8808`;
  this spec must not be read as claiming that every Tachyon project-policy assumption is eliminated.
- Add `AGENTS.md`, `CLAUDE.md` or any runtime-specific file discovery.
- Build a Project Guidance editor UI or inline policy field.
- Expand startup-prompt support to runtimes that do not currently have a prompt delivery adapter.
- Implement the deferred `orient` tool; the stale primer pointer to that unavailable tool is removed here.
- Change `verify_task`'s landing-side default command. This spec removes invented defaults only from onboarding text.
- Turn project guidance into an enforcement or trust boundary. It is project-owned agent context; existing machine gates remain authoritative.

## Open questions

None. The maintainer ratified the ownership boundary and explicit project-owned channel in the discussion that created `t-9cb29e`; implementation details are fixed in `plan.md`.

**Closure:** Shipped 2026-07-14 in isolated branch `codex/t-9cb29e-project-guidance`: the global primer now carries only Tachyon protocol and explicitly configured verification facts; `settings.projectGuidance.files` provides bounded, provenance-labelled project-owned content across supported spawn/restart/re-anchor paths, including Hermes and long-brief delivery. Self-managed and unsupported startup adapters remain unchanged, invalid sources fail closed, Tachyon self-hosts via `docs/project-guidance.md`, three independent reviews accepted the final delta, and the declared focused checks, typecheck, full verification, and AgentManager-backed dogfood passed. The pre-existing Vitest/`test/unit` gated-stub assumption remains explicitly deferred to dependent task `t-2b8808`.
