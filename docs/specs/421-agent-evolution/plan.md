# 421 — Tachyon Agent Evolution — plan

_Drafted from `spec.md` on 2026-07-21. Architecture draft for maintainer review; no product code has
started._

## Approach

Add one Tachyon-owned evolution loop around the existing declared-agent, Task, Bridge, startup-brief
and Agent Studio seams. The selected runtime does the reflective reasoning in a final turn of the same
agent session; Tachyon owns when that turn is requested, the proposal protocol, all persisted state,
human review, promotion and next-session delivery.

The implementation is split into five sequential slices in the dedicated
`tachyon/change/agent-evolution` worktree. Each slice is independently testable and reviewable, while
the feature remains inert unless `selfEvolution.enabled` is true.

### 1. Configuration and canonical Evolution Profile

Extend `ManagedEntryDef` with the closed shape:

```ts
selfEvolution?: { enabled: boolean };
```

Thread it through `AGENT_KEYS`, parser validation, JSON Schema, `FormState`, Agent Studio YAML
round-trip and runtime capability checks. Terminals reject the field. Absence and `enabled:false`
remain the same disabled state; Agent Studio writes only the opt-in `enabled:true` form.

Create a new `src/evolution/` domain rather than adding memory fields to Soul:

- `domain.ts` owns profile/review/candidate/version types and pure state transitions;
- `EvolutionStore.ts` owns `.tachyon/agents/<agent>/evolution/`, profile versions, candidates,
  `LEARNINGS.md`, skill bundles and history;
- `skillBundle.ts` validates a candidate bundle using the existing
  `src/plugins/skill.ts` Agent Skills frontmatter parser and a closed relative-file inventory;
- `startupSnapshot.ts` resolves one immutable active snapshot for a fresh session.

Learned Context proposals are individual entries. On approval, the host renders the deterministic
`LEARNINGS.md`; one proposal cannot replace the whole file. Skill proposals are complete standard
skill directories and declare whether they create or update one skill. Approval checks the expected
digest of only that skill, so unrelated proposals from the same task remain independently reviewable.

`profile.json` records the stable profile id, agent owner, schema version and active version.
Candidates record their review/task source, reason, proposed operation and status. `history/` records
the prior target for each promoted version, while active data stays in `LEARNINGS.md` and `skills/`.

### 2. One task-end review through the current runtime

Add a post-write Task mutation observation seam so every real `TaskStore.update` path sees the same
`before → after` transition. The observer never changes Task success/failure. `EvolutionCoordinator`
reacts only when:

- the status actually transitions to `done`;
- the task has an assignee matching a declared agent;
- that agent has `selfEvolution.enabled:true`;
- this exact completion revision has not already created a review.

Reopening and completing the task again creates a new completion revision. Moving to `landed`, an idle
pane, resume/rebind, or the evolution turn itself does not trigger analysis.

For an eligible completion, the coordinator creates a durable review record containing the task id,
assignee, completion revision, current session/activity anchor and an initially `pending` state. It then
uses Workspace's existing queued `deliverNotice` path to send a short fixed prompt to the same agent.
The prompt points at the completed Task/review id and asks the agent to call a new agent-authenticated
Bridge tool, `submit_evolution_review`.

The agent already holds the execution context in its transcript. The review may submit zero or more
small independent proposals in one call:

- Learned Context entry: concise content plus reason;
- Agent Skill create/update: reason plus a complete file inventory containing required `SKILL.md` and
  optional `scripts/`, `references/` and `assets/`.

An empty submission records “reviewed, no proposal”. The Bridge resolves the caller identity and
accepts only the matching pending review id. The store makes submission idempotent. If the session is
gone or delivery/submission fails, the review records a visible failure and Task completion stays done;
V1 does not launch a hidden secondary model or retry in another runtime.

### 3. Human promotion and next-session activation

Evolution review is a product-specific proposal workflow, not a generic Approval request. The existing
Approvals payload cannot show a learning diff or multi-file skill bundle, so reuse its human-owned
resolution pattern but keep evolution records and actions in `EvolutionStore`.

Agent Studio asks the host for a bounded profile summary and pending proposal list. Proposal detail is
loaded on demand and includes source Task, reason and exact text/file diff. **Approve** and **Reject**
carry the candidate id plus observed active version/target digest so a stale Studio view receives a
conflict instead of silently applying an old proposal.

Approval applies one candidate, increments the active profile version and refreshes Studio. Rejection
only changes candidate status. Neither action injects text into a running pane.

At a fresh spawn or deliberate restart, `AgentManager` resolves `startupSnapshot` once before command
composition and records its version/digest in `SessionLedger`. Resume, rebind, native fork and
re-anchor reuse the recorded session snapshot and never resolve a newer active version. This makes
“next session” literal rather than dependent on when Agent Studio was clicked.

### 4. Learned Context and standard skills in every runtime

Extend `AgentPromptLayers`, `AgentPromptManifest`, startup-brief inventory and ledger metadata with one
optional Evolution snapshot. Keep the current legacy serializer when both Soul and Evolution are
absent. An Evolution-enabled prompt uses the canonical labeled order:

```text
Soul (optional) → role → Persistent Instructions → Learned Context/Skill catalog
→ Bridge guidance → current task
```

This branch is opt-in; existing disabled prompts remain byte-compatible. PI-001's Project Guidance
input remains outside this renderer and its fixed oracle is unchanged.

The startup layer contains:

- the approved `LEARNINGS.md` body;
- each approved skill's standard `name`, `description`, digest and canonical `SKILL.md` path;
- a short instruction to read the relevant standard bundle and use its helper scripts through the
  runtime's existing tools.

V1 does not invent a skill runner or copy evolved skills into workspace-global `.claude/skills` or
`.agents/skills` directories. All runtimes receive the same catalog with canonical Tachyon paths.
Native runtime materialization can be added later as a disposable optimization without changing the
profile contract. User-declared harness skills remain separate; a name collision blocks promotion of
the evolved skill rather than replacing the human-declared bundle.

### 5. Agent Studio, lifecycle and closure

Add an **Agent Evolution** section separate from Identity and Persistent Instructions:

- opt-in toggle and “applies next session” explanation;
- enabled/disabled state, active version and last review outcome;
- pending proposals with source/reason/diff;
- Approve and Reject;
- active Learned Context and Agent Skills for inspection.

The toggle is available while creating an agent. Profile/proposal operations require a saved agent,
matching the existing Soul lifecycle. New visible strings are projected through host-localized labels
rather than adding more unlocalized protocol text to the webview.

Agent rename moves the Evolution Profile with the existing agent lifecycle. Explicit agent forget/delete
adds the evolution directory to `FORGET_AGENT_FOOTPRINTS`. Disabling retains but deactivates the profile.
Changing `cmd` does nothing to profile ownership.

Finish with focused tests, PI-001 equivalence, a deterministic headless dogfood that completes a Task,
submits/rejects/approves proposals and switches runtime, and installed Agent Studio visual dogfood from
this worktree.

## Key decisions

- **Use the current agent runtime for the review turn** — it already has the completed work in context and
  works across integrations; rejected a separate reflector service/provider because it adds configuration,
  cost and runtime-specific invocation before the product loop is validated.
- **Trigger only on a real `Task` transition to `done`** — it is the existing observable completion
  boundary; rejected idle detection and final-answer heuristics because they do not identify a completed task.
- **Submit proposals through one Bridge tool** — Tachyon receives the same typed result from every runtime;
  rejected direct agent writes into the active profile because they would bypass the Agent Studio review flow.
- **Keep evolution separate from Soul and generic Approvals** — Soul remains human identity and the generic
  approval record cannot represent a multi-file diff.
- **Use the open Agent Skills bundle unchanged** — reuse `parseSkillFrontmatter`; rejected a Tachyon-only
  skill schema, runner or prompt-only reduction.
- **Expose canonical skill paths in V1** — one runtime-neutral delivery mechanism serves every adapter;
  rejected immediate native-home projections because they multiply runtime-specific copy/conflict behavior
  without changing what the agent can use.
- **Pin the Evolution snapshot per session in the ledger** — approval has a precise activation boundary;
  rejected resolving active state during re-anchor because it would mutate the current conversation.
- **Store candidates as target-scoped operations** — unrelated proposals can be approved independently;
  rejected full-profile replacement proposals because one useful fact should not rewrite every prior learning.
- **Human-declared harness skills win name collisions** — evolution cannot silently replace explicit config.
- **Sequential commits in one isolated worktree** — the slices share config, Workspace, AgentManager and
  Agent Studio contracts; separate commits retain reviewability without parallel API drift.

## Delivery slices

1. **Foundation:** configuration, domain types, Agent Skills validation and EvolutionStore.
2. **Review loop:** Task completion observation, review prompt/record and Bridge submission tool.
3. **Activation:** proposal promotion plus session-frozen Learned Context/skill catalog delivery.
4. **Studio:** opt-in, proposal review and active-profile inspection.
5. **Lifecycle and proof:** rename/forget/disable, runtime parity, PI-001, dogfood, visual evidence and docs.

Do not begin a later slice while an earlier slice's focused tests are red. Keep each slice in its own
commit on `tachyon/change/agent-evolution` so review can reason about one behavior boundary at a time.

## Files touched

| Area | Paths | Purpose |
|---|---|---|
| Evolution domain | `src/evolution/domain.ts`, `EvolutionStore.ts`, `skillBundle.ts`, `startupSnapshot.ts`, `EvolutionCoordinator.ts` | Canonical state, review lifecycle, promotion and frozen session snapshot |
| Config | `src/config/loadConfig.ts`, `src/config/tachyon.schema.json` | Parse/validate the agent-only closed opt-in |
| Agent Studio form | `src/webview/formLogic.ts`, `src/webview/agent-studio-shell/domain.ts`, `App.tsx`, CSS | Round-trip toggle and render the separate evolution section |
| Agent Studio host | `src/webview/AgentStudioAdapter.ts`, `AgentStudioPanel.ts`, `agent-studio-shell/messages.ts`, `types.ts`, `src/shell/WorkspacePresentation.ts` | Typed list/detail/approve/reject protocol |
| Task boundary | `src/tasks/TaskStore.ts`, `src/workspace/Workspace.ts` | Observe committed `done` transitions and queue one review |
| Bridge | `src/bridge/tools.ts` | Agent-authenticated `submit_evolution_review` |
| Prompt/session | `src/agents/promptLayers.ts`, `AgentManager.ts`, `startupBrief.ts`, `src/resume/SessionLedger.ts` | Deliver and record the active Evolution snapshot only at a new session boundary |
| Lifecycle | `src/agents/forgetAgent.ts`, `src/workspace/Workspace.ts` | Rename/disable/forget behavior |
| Localization | `package.nls.json`, `package.nls.pt-br.json` and host label projection | New human-visible Agent Studio copy |
| Focused tests | `test/unit/evolutionStore.test.ts`, `evolutionCoordinator.test.ts`, `evolutionPromptLayers.test.ts`, existing config/Agent Studio/AgentManager suites | Contract and regression coverage |
| Product invariant | `test/product-invariants/PI-001-project-guidance-ownership.test.ts` only if mechanical evidence must change | Independent equivalence proof; no oracle change |
| Dogfood/docs | `scripts/dogfood-agent-evolution.mts`, `docs/specs/421-agent-evolution/cookbook.md`, spec notes/evidence | Representative end-to-end proof and operator path |

Exact test filenames may fold into an existing suite when that preserves a clearer ownership boundary;
production module responsibilities above are the architectural contract.

## Risks & unknowns

- A human can mark a Task done after the assigned session is gone. The review must become visibly failed,
  not silently disappear or cause Task completion to fail.
- `composeAgentPrompt` has a byte-pinned legacy branch for agents without Soul. Evolution must add a new
  opt-in branch without altering disabled bytes.
- Re-anchor currently re-resolves Soul. Evolution must deliberately use the ledger's session snapshot,
  otherwise approval would leak into the current conversation.
- A Task can be reopened and completed again. The completion revision/idempotency key must distinguish a
  new execution from duplicate delivery of the same mutation.
- Proposal summaries and skill bundles can be larger than one webview message. Load bounded lists first
  and candidate detail on demand instead of posting the entire profile with every form refresh.
- Two Agent Studio windows can review the same proposal. Active-version/target-digest expectations make
  one result authoritative and the other refresh.
- Runtime-native skill discovery differs. The canonical-path catalog is the V1 parity mechanism; dogfood
  must prove agents can read and use the same bundle after a runtime switch.
- User-declared and evolved skills can share a name. Promotion must show the collision and leave both
  existing sources unchanged.

## Post-review corrective architecture

Independent review at `1271c60a` disproved three successful-path assumptions. The correction is part
of this spec rather than a new product feature:

1. **Recoverable promotion.** Approval must create a durable promotion intent before changing active
   bytes. The host-authorized active head is committed last. Reload resolves an interrupted intent by
   rolling back to the old authorized state or completing the exact already-authorized state; startup
   never composes a mixed version.
2. **Host-verifiable activation.** The current active profile digest is authenticated with the existing
   machine-local authority key and a SecretStorage freshness head, domain-separated for Agent
   Evolution. Startup fails closed when workspace profile bytes do not match that human-authorized
   head. Direct workspace writes remain data, never approval authority.
3. **Review reconciliation.** A completion revision is reconstructible from the committed Task. On
   reload, Tachyon scans eligible `done` Tasks and idempotently creates/delivers any missing review;
   creation failure is surfaced and retried without reverting Task completion.
4. **Runtime-use proof.** Dogfood must distinguish host-side script execution from a fresh runtime
   reading `SKILL.md` and invoking the helper through its normal tool boundary after a runtime switch.

The trust boundary is the existing Tachyon runtime boundary: direct workspace writes are untrusted,
while the explicitly selected runtime is the agent executor and is not treated as a hostile same-UID
process. Session-pinned skill copies live in host storage, are content-addressed and are byte-checked
when resolved. Protecting files from an arbitrary process running as the Tachyon OS user would require
an OS sandbox or separate identity and is outside this runtime-neutral feature.

The corrective work is tracked by `t-24ffb7`, `t-67ece9`, `t-0b7aa6` and `t-5f212f`. PI-001 remains
unchanged: the correction does not alter Project Guidance ownership, provenance, ordering or bytes.

### Second corrective review

The follow-up review found four remaining gaps. Production startup must use Workspace's
authority-configured EvolutionStore rather than constructing an unprotected store. Snapshot assembly
must authenticate the exact captured learning and skill bytes, not merely re-read current state after
capture. Forget and rename must mutate the host-custodied identity alongside workspace lifecycle so
deleted and renamed names remain reusable without stale heads. Finally, every completion marker needs
a persisted unique nonce so repeated completions never depend on wall-clock uniqueness.

The implementation keeps these corrections within the existing boundaries: AgentManager receives a
Workspace-owned snapshot resolver; EvolutionStore owns one captured-and-authorized startup read;
AuthorityHeadPort gains optional lifecycle CAS operations used by Evolution only; and TaskStore persists
the coordinator-minted revision marker before its asynchronous observer runs.

## Visual impact

Agent Studio gains a distinct Agent Evolution section and proposal review cards/diffs. The main visual
risks are confusing Evolution with Identity/Persistent Instructions, hiding the next-session boundary,
and rendering multi-file skills as an unreadable wall of text. Use the real Dev Host from this worktree;
capture empty, pending-learning, pending-skill and approved states plus narrow-width behavior. Record
screenshot paths and a verdict in `notes.md`.

## Verification and dogfood strategy

- Characterize disabled prompt/config behavior before changing shared seams.
- Focused Vitest after each slice: config, store, task-end idempotency, Bridge caller/review matching,
  promotion, session freezing, skill catalog parity and Agent Studio protocol.
- Run `npm run test:invariants` whenever prompt composition changes; PI-001 promise/oracle stay unchanged
  and require independent equivalence review.
- Run configured typecheck and full verification before every landing.
- Headless dogfood uses a temporary workspace and two fake runtime adapter identities to prove:
  Task `done` → review → proposal → reject/approve → unchanged current session → next-session
  snapshot → runtime switch with the same profile.
- Human dogfood uses the Dev Host pointed at this worktree and an actual declared agent to inspect the
  opt-in/review flow and use one approved helper script from a standard Agent Skill.

## Sources consulted

- `docs/specs/421-agent-evolution/spec.md` and
  `.tachyon/reports/tachyon-self-evolution-viability-gaps-2026-07-21.md`
- `docs/specs/377-agent-soul-identity/spec.md`, `docs/specs/411-startup-brief-semantics/spec.md`
- `docs/architecture/product-invariant-testing.md` and PI-001 registry metadata
- `src/config/loadConfig.ts`, `src/config/tachyon.schema.json`, `src/config/YamlConfigEditor.ts`
- `src/tasks/TaskStore.ts`, `src/tasks/taskNotificationPolicy.ts`, `src/workspace/Workspace.ts`
- `src/activity/types.ts`, `src/activity/logStore.ts`, `src/resume/SessionLedger.ts`
- `src/agents/promptLayers.ts`, `src/agents/AgentManager.ts`, `src/agents/runtimePromptAdapters.ts`
- `src/plugins/skill.ts`, `src/harness/HarnessManager.ts`
- `src/webview/formLogic.ts`, `src/webview/AgentStudioAdapter.ts`, `src/webview/AgentStudioPanel.ts`,
  `src/webview/agent-studio-shell/*`, `src/shell/WorkspacePresentation.ts`
- Agent Skills open specification: <https://agentskills.io/specification>
