# 421 — Tachyon Agent Evolution — tasks

_Drafted from `plan.md` on 2026-07-21. Work top-to-bottom in the dedicated
`tachyon/change/agent-evolution` worktree. If implementation disproves the plan, update `plan.md`
before continuing._

## Phase 0 — Design and trail setup

- [x] Scaffold and commit SDD 421 with the ratified product decisions.
- [x] Create the managed change worktree `agent-evolution` on branch
  `tachyon/change/agent-evolution`.
- [x] Map the existing config, Task, Bridge, startup/session, Agent Skills, lifecycle and Agent Studio
  seams in `plan.md`.
- [x] Maintainer reviews the architecture plan and resolves any requested product-contract change.
- [x] Mark `spec.md` `in-progress` after architecture ratification.
- [x] Create one Mission Control umbrella for SDD 421 and follow-up Tasks for the five delivery slices;
  attach this SDD as the deliverable and keep each Task independently reviewable.

## Slice 1 — Configuration and Evolution Profile foundation

- [x] Add `SelfEvolutionDef` and `ManagedEntryDef.selfEvolution` with the closed
  `{ enabled: boolean }` shape.
- [x] Parse/validate `agents.<name>.selfEvolution`, reject it for terminals, add it to `AGENT_KEYS`,
  and prove absence/false remain disabled.
- [x] Publish the same closed contract in `tachyon.schema.json` and update the schema contract test.
- [x] Add `FormState.selfEvolution`, blank/fromDef/toEntry round-trip and form tests; write only
  `selfEvolution: { enabled: true }` when enabled.
- [x] Add pure Evolution domain types for profile, active version, review and target-scoped candidate
  operations.
- [x] Implement `EvolutionStore` canonical paths, create/read/list behavior and serialized atomic
  per-agent mutation.
- [x] Render approved individual learning entries deterministically into `LEARNINGS.md`.
- [x] Validate skill create/update bundles with the existing Agent Skills frontmatter parser,
  including `scripts/`, `references/` and `assets/` file inventories.
- [x] Persist candidates and promotion history without changing active state on proposal creation.
- [x] Cover store reload, malformed profile, independent candidate targets and skill-name collisions.
- [x] Commit Slice 1 separately with focused tests green.

## Slice 2 — Task-end review and Bridge submission

- [ ] Add a post-write `TaskStore` mutation observation seam that exposes committed `before/after`
  values without changing the Task mutation result.
- [ ] Implement a stable completion revision so duplicate delivery is idempotent and a reopened Task
  can create a new review.
- [ ] Implement `EvolutionCoordinator` eligibility: transition to `done`, assigned declared agent,
  and `selfEvolution.enabled:true` only.
- [ ] Create the durable pending review before attempting pane delivery, recording Task, agent,
  session and activity anchors.
- [ ] Build the fixed runtime-neutral review prompt and queue it through Workspace `deliverNotice`.
- [ ] Add `submit_evolution_review` to the Bridge with an empty result or independent learning/skill
  proposals and idempotent submission.
- [ ] Wire Bridge-resolved caller/review matching and return clear errors for stale, completed or
  wrong-agent review ids.
- [ ] Record a visible failed review when the assigned session is unavailable without reverting the
  completed Task.
- [ ] Prove idle, `landed`, resume/rebind and the evolution review itself never recurse into analysis.
- [ ] Commit Slice 2 separately with focused Task/Coordinator/Bridge tests green.

## Slice 3 — Human promotion and next-session delivery

- [ ] Implement proposal detail/diff projection plus target/version expectations for Approve and Reject.
- [ ] Implement rejection as candidate-only state change with no active-file change.
- [ ] Implement learning approval as one entry operation and skill approval as one complete bundle
  create/update; increment the active profile version and write history.
- [ ] Reject stale target digests and collisions with user-declared harness skills while leaving both
  sources unchanged.
- [ ] Resolve an immutable `EvolutionStartupSnapshot` containing active version/digest, Learned Context
  and the approved skill catalog.
- [ ] Extend `AgentPromptLayers`/manifest with an optional labeled Evolution layer while preserving
  exact disabled/no-Soul legacy bytes.
- [ ] Add Evolution version/digest to `SessionLedger` and startup-brief inventory.
- [ ] Resolve a new snapshot on fresh spawn/restart only; resume, rebind, native fork and re-anchor reuse
  the session's recorded snapshot.
- [ ] Render standard skill name/description/digest/canonical path without copying to workspace-global
  runtime skill directories or inventing a runner.
- [ ] Prove switching the declared runtime preserves the same canonical profile and logical startup
  snapshot.
- [ ] Run PI-001 and obtain independent equivalence review if its executable evidence mechanics change.
- [ ] Commit Slice 3 separately with focused prompt/session/runtime tests green.

## Slice 4 — Agent Studio

- [ ] Add host-localized Agent Evolution labels/help copy and project them into the webview entity.
- [ ] Render the self-evolution toggle while creating/editing an agent, clearly separate from Identity
  and Persistent Instructions.
- [ ] Add typed host/webview messages for profile summary, proposal list/detail, Approve and Reject.
- [ ] Extend `WorkspaceAgentStudioTarget`, `AgentStudioAdapter` and `AgentStudioPanel` with evolution
  queries/actions.
- [ ] Show saved-agent state, active version, last review outcome and pending proposal count.
- [ ] Render learning and multi-file skill diffs on demand, including source Task and reason.
- [ ] State visibly that approval applies to the next session; do not imply the current pane changed.
- [ ] Handle empty, loading, failed-review, stale-conflict, rejected and approved states.
- [ ] Add protocol/domain/adapter/component tests and update pt-BR localization bundles.
- [ ] Commit Slice 4 separately with focused Agent Studio tests green.

## Slice 5 — Lifecycle, docs and closure proof

- [ ] Move the Evolution Profile on supported agent rename and keep profile ownership metadata aligned.
- [ ] Add evolution artifacts to `FORGET_AGENT_FOOTPRINTS` and explicit declared-agent deletion.
- [ ] Prove disabling retains but deactivates the profile and changing `cmd` does not move/recreate it.
- [ ] Add runtime-parity tests for every currently supported startup delivery channel.
- [ ] Add `scripts/dogfood-agent-evolution.mts` covering Task completion, empty/proposed review,
  rejection, approval-next-session and runtime switch in a temporary workspace.
- [ ] Scaffold and finish `cookbook.md` with opt-in, proposal review, active files and disable behavior.
- [ ] Point the Dev Host at this worktree and complete human Agent Studio dogfood with an actual declared
  agent and a standard skill containing one helper script.
- [ ] Capture Agent Studio visual evidence for empty, pending-learning, pending-skill, approved and
  narrow-width states; record verdict/fixes in `notes.md`.
- [ ] Run focused tests, SDD dogfood, PI-001, typecheck and configured full verification.
- [ ] Check every acceptance criterion against evidence, mark `spec.md` shipped, add Closure, and run
  the SDD close audit.
- [ ] Land the isolated branch through normal review, then remove the managed worktree and its branch.

## Verification

- [ ] Config/schema/FormState opt-in contract is covered.
- [ ] EvolutionStore candidate/promotion/version/history contract is covered.
- [ ] Task completion produces exactly one review per completion revision and never changes Task outcome.
- [ ] Bridge submission accepts matching reviews and preserves independent proposals.
- [ ] Reject/Approve/current-session/next-session behavior maps to the acceptance scenarios.
- [ ] Disabled prompt bytes and PI-001's fixed oracle remain unchanged.
- [ ] Agent Studio protocol, localized UI and lifecycle actions are covered.
- [ ] Runtime-switch and standard skill/script use are proven by dogfood.

**Verify:** `npm run typecheck`

**Verify:** `npm run test:invariants`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npm exec -- vite-node scripts/dogfood-agent-evolution.mts`

**Human dogfood:**

1. From the primary checkout, point the Dev Host to
   `/home/goat/.cache/tachyon/worktrees/b349073a/change/agent-evolution` and confirm `point-status`.
2. F5 the Extension Development Host and create a declared agent with Agent Evolution enabled.
3. Complete one managed Task and inspect the generated learning and skill proposals in Agent Studio.
4. Reject one proposal and confirm no later startup receives it.
5. Approve one standard Agent Skill containing `scripts/`; confirm the current session is unchanged.
6. Start a fresh session, use the approved helper script, change the declared runtime and prove the
   same Tachyon profile/catalog is delivered.

## Visual QA

- [ ] Evidence: `.tachyon/evidence/421-agent-evolution/` contains real Agent Studio screenshots for
  empty, pending learning, pending skill, approved and narrow-width states.
- [ ] Verdict: recorded in `notes.md`, including any layout/copy fixes made after inspection.

## Cookbook

**Cookbook:** yes
