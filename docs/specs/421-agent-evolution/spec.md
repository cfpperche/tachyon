# 421 — Tachyon Agent Evolution

_Created 2026-07-21._

**Status:** shipped-partial

**Closure:** Implementation, independent publication review, recovery hardening, full verification and
live-runtime dogfood are complete. Maintainer publication remains a separate explicit step.

## Intent

Tachyon agents can keep a stable identity (`SOUL.md`) and human-authored operating instructions, but
they do not have a Tachyon-owned way to learn from completed work. Useful corrections and procedures
remain trapped in one transcript, depend on runtime-specific memory features, or must be copied by
hand. Changing from Claude to Codex, Hermes, Grok, Pi, OpenCode, Antigravity or another runtime can
therefore discard what the Tachyon agent learned.

This feature adds optional **Agent Evolution** to a declared Tachyon agent. At the end of each managed
task execution, Tachyon runs one review of the task and may produce a proposal for a concise learned
fact or an Agent Skill. The proposal is visible in Agent Studio and has no effect until the human
approves it. Approved learning becomes available only to the agent's next session.

The state and lifecycle belong to Tachyon. Runtimes execute the agent and consume the same approved
context and skills; no runtime-specific memory system is the source of truth. Soul, role and Persistent
Instructions remain human-authored and are never rewritten by evolution.

Affected Product Invariants: **PI-001 — promise unchanged**. Adding the learned-context layer must not
change Project Guidance opt-in, provenance, ordering or bytes. The fixed oracle and its strength remain
unchanged, and implementation requires independent equivalence review.

## Ratified product decisions

- Evolution is opt-in per declared agent through `selfEvolution.enabled: true` and disabled by default.
- One evolution analysis runs after each task execution reaches a Tachyon-observed completion boundary.
- Analysis creates reviewable proposals; it never promotes learning by itself.
- Proposals are inspected and approved or rejected in Agent Studio.
- Soul, role and Persistent Instructions are never evolution targets.
- Approved learning and skills activate only in the next session, never in the current conversation.
- Skills use the open Agent Skills directory format and may contain `scripts/`, `references/` and
  `assets/` alongside the required `SKILL.md`.
- Evolution state belongs to the Tachyon agent and survives a change of runtime.

## Vocabulary and ownership

| Concept | Meaning | Owner |
|---|---|---|
| Soul | Stable identity, voice, values and posture | Human |
| Role | Reusable work contract | Human |
| Persistent Instructions | Stable operating specialization | Human |
| Current task | Objective being executed now | Human/Tachyon task contract |
| Evolution Profile | Approved learnings, Agent Skills, candidates and version metadata for one agent | Tachyon |
| Learned Context | Short approved facts, preferences and corrections | Tachyon after human approval |
| Agent Skill | Reusable procedure in the open Agent Skills format, optionally including helper scripts/tools | Tachyon after human approval |
| Runtime | Replaceable executor that receives the agent's active Tachyon context | Runtime adapter |

Evolution does not replace Soul. An agent may use Soul, Agent Evolution, both, or neither.

## Configuration contract

```yaml
agents:
  reviewer:
    cmd: codex
    selfEvolution:
      enabled: true
```

`selfEvolution` is accepted only on declared agents. V1 accepts the closed shape `{ enabled: boolean }`.
Field absence and `enabled: false` are equivalent disabled states. A disabled agent performs no
evolution analysis, receives no learned-context layer, receives no evolved skills, and retains the
existing startup behavior.

Changing `cmd` changes only the executor. It does not rename, migrate, recreate or disable the
Evolution Profile. Disabling the option makes existing evolution data inactive without deleting it;
data removal is a separate explicit action.

## Evolution Profile

The canonical state is rooted in the coordinating workspace, alongside the existing Soul profile:

```text
.tachyon/agents/<agent>/evolution/
├── LEARNINGS.md
├── profile.json
├── skills/
│   └── <skill>/
│       ├── SKILL.md
│       ├── scripts/       # optional helper tools
│       ├── references/    # optional
│       └── assets/        # optional
├── candidates/
├── reviews/
└── history/
```

- `LEARNINGS.md` contains only the currently approved short Learned Context.
- `skills/` contains only approved Agent Skills. A skill is a complete directory, not only a prompt.
- `candidates/` contains pending or rejected proposals and their source task, reason and proposed diff.
- `reviews/` contains one durable result per completed-task revision, including delivery/submission state.
- `profile.json` identifies the profile and active version; `history/` preserves prior promoted versions.
- Runtime-native copies are disposable projections. They never become the canonical profile.
- The profile is local to one Tachyon agent. Sharing or publishing a skill is outside this V1.

## Task-end evolution cycle

1. A managed task execution reaches its existing Tachyon completion boundary with an observable
   outcome. A pane becoming idle without a task completion signal is not enough.
2. Tachyon requests one structured evolution review using that execution's task, activity and result.
3. The review returns no proposal or a small set of independent Learned Context and Agent Skill
   proposals. It may propose a new skill or a focused update to an existing skill.
4. Tachyon stores the proposal with its source task, reason and file/content diff.
5. Agent Studio shows the proposal to the human.
6. Rejection leaves the active profile unchanged. Approval creates a new active profile version.
7. The running session remains unchanged. The new version is offered at the next fresh session.

The review protocol is owned by Tachyon and is the same for every runtime. A runtime adapter may use
its own model invocation mechanics, but it must return the same logical proposal contract. Failure to
review is visible and does not turn an unreviewed candidate into active learning or undo the completed
task.

## Startup brief and skill delivery

For an enabled agent with approved learning, the logical startup order is:

```text
Tachyon primer
Project Guidance
Soul, when enabled
Role
Persistent Instructions
Approved Learned Context
Available approved Agent Skills
Bridge guidance
Current task
Before-finishing gate
```

Only the active approved snapshot is delivered. Pending/rejected candidates and raw task history are
not prompt layers. The snapshot is frozen for the session: approval during a running conversation does
not change resume, rebind, native fork or re-anchor content.

Learned Context is included as a labeled startup layer. Skills remain standard Agent Skills bundles;
Tachyon makes the approved catalog and relevant bundles available through the runtime adapter. An
adapter may materialize bundles into a runtime's native skill directory or expose their canonical
Tachyon location, but the logical contents and active version remain runtime-neutral.

## Agent Studio experience

Agent Studio provides:

- a clearly labeled **Agent Evolution** opt-in while creating or editing a declared agent;
- the current enabled/disabled state and active profile version;
- a proposal list scoped to that agent;
- proposal type, source task, reason and full content/file diff;
- **Approve** and **Reject** actions;
- a clear indication that approval applies only to the next session;
- the active Learned Context and approved Agent Skills for inspection.

The Soul editor and Persistent Instructions fields remain separate and are not presented as evolution
outputs.

## Acceptance criteria

- [x] **Scenario: disabled agents retain existing behavior**
  - **Given** a declared agent with no `selfEvolution` field or `enabled: false`
  - **When** it completes work, starts, resumes, restarts or changes runtime
  - **Then** no evolution review runs, no evolution proposal or active artifact is created, no learned
    layer or evolved skill is delivered, and existing startup composition remains compatible
- [x] **Scenario: configuration round-trips as an agent-only opt-in**
  - **Given** a declared agent with `selfEvolution.enabled: true`
  - **When** configuration is parsed, shown and saved through Agent Studio
  - **Then** the enabled state round-trips through YAML and the closed schema, while terminals reject
    the field and invalid shapes follow the existing whole-config rejection behavior
- [x] **Scenario: task completion produces one review with independent proposals**
  - **Given** an enabled agent finishes a managed task execution with a Tachyon-observed outcome
  - **When** the completion boundary is recorded
  - **Then** Tachyon runs exactly one evolution review for that execution and records either no useful
    learning or individually reviewable proposals linked to the source task and result
  - **And** idle panes, resume/rebind and the evolution review itself do not recursively trigger reviews
- [x] **Scenario: a Learned Context proposal waits for human review**
  - **Given** the evolution review identifies a reusable fact, preference or correction
  - **When** it creates a Learned Context proposal
  - **Then** Agent Studio shows its source, reason and exact proposed content, while the active
    `LEARNINGS.md` and current session remain unchanged
- [x] **Scenario: an Agent Skill proposal is a standard skill bundle**
  - **Given** the evolution review identifies a reusable procedure or improvement to an existing skill
  - **When** it creates the proposal
  - **Then** the proposal contains a valid Agent Skills directory with required `SKILL.md` and may add
    or update helper `scripts/`, `references/` and `assets/`
  - **And** Tachyon does not invent a competing skill format or reduce the proposal to prompt text
- [x] **Scenario: rejection never changes the active profile**
  - **Given** a pending learning or skill proposal
  - **When** the human rejects it in Agent Studio
  - **Then** it is recorded as rejected and is absent from future Learned Context and skill catalogs
- [x] **Scenario: approval activates only in the next session**
  - **Given** an active session and a pending proposal
  - **When** the human approves the proposal
  - **Then** Tachyon creates a new active Evolution Profile version but does not inject it into the
    running session, resume, rebind, native fork or re-anchor
  - **And** the next fresh session records and receives exactly that approved version
- [x] **Scenario: evolution cannot rewrite human-authored layers**
  - **Given** any task history or evolution proposal
  - **When** the proposal is generated, approved or delivered
  - **Then** `SOUL.md`, role, Persistent Instructions, Project Guidance and the current task remain
    byte-for-byte outside the proposal and are not modified by the evolution lifecycle
- [x] **Scenario: runtime changes preserve the Tachyon agent's learning**
  - **Given** one enabled agent with approved Learned Context and Agent Skills
  - **When** its runtime changes among supported agent runtimes
  - **Then** the same Tachyon Evolution Profile remains canonical and the new runtime receives the same
    logical approved snapshot and skill bundles without importing runtime-native memory as authority
- [x] **Scenario: Agent Studio separates identity, instructions and learning**
  - **Given** an agent that uses Soul, Persistent Instructions and Agent Evolution
  - **When** the human opens Agent Studio
  - **Then** identity, operating instructions, active learning and pending proposals are visibly distinct,
    and review actions state that accepted changes begin in the next session
- [x] **Scenario: Project Guidance invariant remains unchanged**
  - **Given** configured and unconfigured consumer workspaces with Agent Evolution on or off
  - **When** startup briefs are composed across supported adapters
  - **Then** PI-001's fixed oracle remains true: configured sources are lossless, labelled and ordered,
    while unconfigured consumers receive none
- [x] Every currently supported agent runtime uses the same Tachyon-owned profile and proposal contract;
  runtime-specific mechanisms are adapters or projections only.
- [x] Focused config, store, lifecycle, prompt-composition, Agent Studio and multi-runtime adapter tests,
  PI-001, typecheck and configured full verification pass.
- [x] Representative dogfood proves proposal, rejection, approval-next-session and runtime-switch behavior;
  Agent Studio visual evidence records the proposal review flow.

## Non-goals

- Rewriting Soul, role, Persistent Instructions, Project Guidance, current task, system prompts or
  Tachyon/runtime source code through evolution.
- Training, fine-tuning or otherwise changing model weights.
- Automatic promotion without human review.
- Treating Hermes Agent or any other runtime's native self-improvement feature as the Tachyon product.
- A runtime-specific Evolution Profile or separate behavior contract for Hermes, Claude, Codex or
  another executor.
- Sharing, publishing or automatically synchronizing learning between different Tachyon agents.
- A marketplace or global registry for evolved skills.
- Continuous GEPA-style optimization, benchmark search or autonomous branch/PR mutation.
- Generating proposals from ordinary idle state when Tachyon has no managed task completion boundary.
- Replacing the existing user-declared harness skills; evolved skills form a separate agent-local catalog.

## Research basis

- [Agent Skills specification](https://agentskills.io/specification) and
  [scripts guidance](https://agentskills.io/skill-creation/using-scripts) define the skill bundle used here.
- Nous Research Hermes memory/skills and `hermes-agent-self-evolution` are prior art only, not runtime
  dependencies or product architecture.
- Detailed viability research and current codebase gaps are recorded in
  `.tachyon/reports/tachyon-self-evolution-viability-gaps-2026-07-21.md`.

## Open questions

None at the product-contract level. The internal service boundaries, normalized review payload,
transaction format, adapter mechanics and verification fixtures must be grounded in the current code
and recorded in `plan.md` before implementation.
