# 411 — startup-brief-semantics

_Created 2026-07-19._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Tachyon safely diverts a long onboarding body to `.tachyon/briefs/spawn/<agent>.md`, but calls every
such aggregate a "spawn contract" even when no delegated task exists. The body may contain project
guidance, soul, role, persistent instructions and/or a structured task contract. In the observed
self-hosting case, declared agent `codex` received only project guidance while its pointer promised a
"full spawn contract"; the bytes were intact, but the label made operational context look like a lost
delegation. A reused derived file also has no explicit freshness semantics, so its existence alone can
be mistaken for evidence about the current launch.

This spec makes the aggregate a **startup brief** and reserves **task/spawn contract** for the
`TASK` / `CONTEXT` / `CONSTRAINTS` / `DELIVERABLE|DONE_WHEN` delegation layer. Composition carries a
typed, bounded manifest of the layers actually delivered; the pane states whether a task objective was
supplied; the file preserves provenance and readable layer boundaries; and derived-artifact freshness,
diagnostics and operator documentation become explicit. The existing file-plus-pointer transport,
prompt precedence, project-ownership boundary and fail-closed safety remain unchanged.

Affected Product Invariants: **PI-001 — promise unchanged**. Project guidance remains opt-in,
source-labelled, ordered and absent from an unconfigured consumer. Any mechanical evidence update
requires independent equivalence review; the fixed oracle and its strength do not change.

## Acceptance criteria

- [x] **Scenario: guidance-only long startup brief is not presented as a delegation**
  - **Given** a prompt-capable declared agent with configured project guidance whose composed body exceeds the file threshold, and no soul, role, persistent instructions or task brief
  - **When** Tachyon launches or restarts the agent
  - **Then** the pane calls the aggregate a `startup brief`, reports the actual layer presence, and states that no task objective was supplied
  - **And** the file contains the configured guidance losslessly with its existing source labels and project-owned delimiters
  - **And** neither the pane nor the file claims that a task/spawn contract exists
- [x] **Scenario: a delegated long contract remains identifiable and lossless**
  - **Given** an ad-hoc or gated child whose composed startup brief exceeds the file threshold
  - **When** the child is launched with `TASK`, `CONTEXT`, `CONSTRAINTS` and exactly one completion field
  - **Then** the bounded pane summary reports a present task contract and distinguishes `DELIVERABLE` from `DONE_WHEN`
  - **And** every contract byte reaches the startup-brief file in canonical precedence without truncation or heuristic reconstruction
- [x] **Scenario: all prompt layers have a typed source of truth**
  - **Given** any combination of project guidance, soul, role, persistent instructions, Bridge guidance and task brief
  - **When** Tachyon composes onboarding
  - **Then** typed composition metadata describes only the non-empty layers actually eligible for delivery through that runtime path
  - **And** a bounded, content-free projection of that metadata produces the pane summary
  - **And** readable file boundaries do not create a second renderer or change layer precedence
- [x] **Scenario: short delivery retains the safe inline path**
  - **Given** a composed startup brief at or below the transport threshold
  - **When** Tachyon delivers it
  - **Then** the body stays inline and no long-brief file is created or replaced for that launch
  - **And** shell-escaped bytes, Unicode and apostrophes continue to be measured by the established transport rules
- [x] **Scenario: derived-file freshness is explicit**
  - **Given** a pre-existing `.tachyon/briefs/spawn/<agent>.md` followed by an inline, failed or semantically different launch
  - **When** an agent or operator inspects current launch evidence
  - **Then** the old file's existence alone is not presented as proof of a current task, gate or startup delivery
  - **And** the documented correlation/lifecycle rule distinguishes the file referenced by the current launch from retained postmortem residue
- [x] **Scenario: failed replacement preserves the prior launch**
  - **Given** a valid existing long startup brief and a replacement whose preview, transport validation or atomic write fails
  - **When** launch or restart is attempted
  - **Then** Tachyon fails before mutating the live pane/session and preserves the previous complete file
  - **And** the error identifies purpose, stage and relevant byte counts without printing brief content
- [x] **Scenario: startup and re-anchor artifacts remain isolated**
  - **Given** the same agent receives both long startup and long re-anchor content
  - **When** either artifact is refreshed
  - **Then** each purpose retains its own path, terminology and lifecycle without overwriting the other
- [x] **Scenario: transcript-owning and unsupported runtimes keep their launch semantics**
  - **Given** explicit resume/continue/session-id syntax, or an agent adapter without a startup-prompt channel
  - **When** the runtime starts
  - **Then** Tachyon does not add a new positional startup brief or infer layer presence that was not delivered
- [x] **Scenario: project guidance ownership remains unchanged**
  - **Given** configured and unconfigured consumer workspaces
  - **When** startup briefs are composed across supported adapters
  - **Then** PI-001's fixed oracle remains true: configured sources are labelled and ordered, while unconfigured consumers receive none
- [x] The pane manifest has a tested maximum size and contains no task text, arbitrary source paths, soul content, instructions, credentials or other free-form payload.
- [x] The path, 4,000-byte diversion threshold, safe inline ceiling and public `SpawnContract` field schema remain compatible unless a separately ratified decision changes them.
- [x] Product documentation answers who generates the artifact, why it exists, what it may contain, when it is used, and why its presence alone does not prove an active task.
- [x] Sanitized dogfood proves guidance-only, `DELIVERABLE`, `DONE_WHEN`, re-anchor and explicit-resume behavior through at least two supported runtime delivery channels.
- [ ] Focused tests, PI-001, typecheck and configured full verification pass, and an independent reviewer records PI-001 equivalence.

## Non-goals

- Redesign the five-field delegation contract or rename `SpawnContract` where it correctly models a task delegation.
- Change project-guidance policy, limits, opt-in ownership or discover runtime-specific files such as `AGENTS.md` or `CLAUDE.md`.
- Change tmux, the long-brief threshold, the safe inline ceiling or the file-plus-pointer transport pattern.
- Make a startup-brief file, manifest or timestamp authoritative for Delivery, task status, gate state, approvals or permissions.
- Automatically claim or infer work from Mission Control, project handoff, git status or retained files when no task contract was supplied.
- Redesign continuity, project handoff, agent focus, prompt-template storage or the broad Agent Studio UI.
- Automatically delete retained files without a deliberate postmortem and compatibility decision.
- Implement the separate `create_task` oversized-body guidance tracked by `t-cf2a50`.

## Open questions

None at the product-contract level. The representation of launch correlation and retained residue is an
implementation decision constrained by the acceptance scenarios and must be recorded in `plan.md` before code.
