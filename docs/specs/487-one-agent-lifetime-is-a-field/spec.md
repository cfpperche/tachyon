# 487 — one-agent-lifetime-is-a-field

_Created 2026-08-03._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**Relates to:** SDD 482 (one Agent Instance infrastructure) — this finishes what that started.
SDD 486 cut its capability phases into this spec rather than build them against the split.

## Intent

The maintainer asked why there are two kinds of agent instead of one that is configurable by purpose,
and observed that the duality produces work on top of work. Measured before answering, the finding is
narrower and more actionable than the question assumed: **the instance model is already unified. The
capability model is not, and the product language still says "species".**

`agentInstancePolicy.ts` already treats the relevant facts as independent, orthogonal fields, and
says so in its own comments:

- `isTemporaryInstance` reads `lifetime`;
- `mayRestartInstance` reads `resumePolicy` — independent, and the file names the case that proves
  it: *"a FORK is `temporary` AND `restartable`, so the answer here says nothing about whether it may
  be started again… never infer one from the other"*;
- `hasLifecycleHooks` is **read, never derived**, and the reason given is exactly the maintainer's
  instinct in reverse: *"It would be derivable from `lifetime` today… but 'sound today' is exactly
  what `declared` was, and re-deriving it would rebuild the same trap one field over."*

And promotion already exists: a Temporary agent can become Saved, which means lifetime is already
**mutable** — the one thing a species can never be. So there is already one Agent with fields.

What is still two:

1. **Capability.** A Saved agent gets skills through profile grants (`agentSkillAuthorization.ts`:
   authorize → select → deliver); a Temporary gets them through the delegated toolkit
   (`AgentManager.ts:1215-1275`). One question — *what does this agent have access to?* — answered by
   two mechanisms with different authors, different moments and different failure modes. This is where
   2026-08-03's work-on-work came from: `t-09be02` (the profile inspector exists only for canonical
   agents), `t-84c678` (the grant enum omits Grok, but the toolkit already admits it), and SDD 486
   having to describe two delivery paths for one act.
2. **Language.** "Saved Agent" and "Temporary Agent" read as kinds. Fifty-eight branch points name
   `lifetime`, and sampled, nearly all of them are lifetime CONSEQUENCES — `canDismiss = temporary &&
   !running` is "an ephemeral thing that stopped can be removed". Those are fine. The naming is what
   teaches a reader there are two species when the code already says otherwise.

**Done** means: one Agent whose lifetime, restartability and capability source are fields a creator
sets; one path that answers "what does this agent have"; and no product surface that presents the two
as different kinds of thing.

### The authority boundary that must survive, and why it is the hard part

Today the split enforces a real rule **by construction**: a Temporary agent cannot hold a profile,
therefore cannot hold grants, therefore **cannot mint an agent with more authority than itself**.
Nothing states that invariant — the structure makes it unrepresentable.

Unifying converts a structural guarantee into a declared one, and this repository has repeatedly
found declared guarantees unenforced: triage that calls itself a "human decision" any agent can make
(`t-f33480`), a refusal that names a `confirmDirty` parameter no tool accepts (`t-eb25ba`), an
`editorHome` field that names the host and was twice read as the destination (`t-198615`). Structural
beats declared, every time, and this spec is proposing to give one up.

So the boundary is not a detail to preserve — it is the deliverable. It must come back as something
mechanical (a test that fails the build, a type that cannot express the escalation) before the
structure that currently enforces it is dissolved. **Enforcement lands before unification, in that
order**, the same sequence SDD 485 used when it put the conformance contract ahead of the migration.

## Acceptance criteria

- [ ] **Scenario: an agent cannot grant what it does not hold**
  - **Given** an agent with a capability set
  - **When** it creates or spawns another agent naming a capability outside that set
  - **Then** the attempt is refused, naming the capability — mechanically, not by review
- [ ] **Scenario: one path answers "what does this agent have"**
  - **Given** any agent, whatever its lifetime
  - **When** its capabilities are resolved
  - **Then** the same code answers, and the answer names its source (granted / inherited / declared)
- [ ] **Scenario: lifetime is a field a creator sets**
  - **Given** a human creating an agent, or an agent spawning one
  - **When** the creator states the lifetime
  - **Then** that is the only thing that decides durability — nothing else is inferred from it, and
    `resumePolicy` stays independent (a fork is temporary AND restartable)
- [ ] **Scenario: promotion is not a conversion**
  - **Given** a temporary agent that a human promotes
  - **When** it becomes durable
  - **Then** the change is to a field, not a re-creation, and its running instance keeps the hooks it
    launched with (`hasLifecycleHooks` stays read, never derived)
- [ ] Grok holds capability grants on the same terms as claude/codex/pi — `t-84c678`, answered here
      against the unified model rather than against the split one
- [ ] No product surface calls these different kinds of agent; the sidebar, Agent Studio and the
      Bridge tool descriptions describe one Agent with fields
- [ ] The 58 `lifetime` branch points are audited: each either reads a genuine lifetime consequence
      or is removed. A count going up is a finding, not a failure

## Non-goals

- **Not merging Probe.** A probe is a bounded headless invocation with no pane and no lifetime; it is
  a different thing, not a lifetime of the same thing. SDD 482 already drew that line.
- **Not merging terminals.** A terminal is not an agent — it holds no capabilities and answers no
  brief. Maintainer, 2026-08-03, correcting this coordinator's own sloppy grouping.
- **Not changing what a capability IS.** `agentSkillAuthorization.ts`'s authorize → select → deliver
  model is the target shape, not the thing under revision.
- **Not a rename for its own sake.** Language changes only where the current word teaches something
  false.

## Open questions

- **What replaces the structural authority boundary?** The candidates are a type that cannot express
  escalation, a build-failing test over the grant path, or a runtime refusal. The first is strongest
  and the least likely to be reachable; measure before choosing.
- **Does "inherited from parent" stay a distinct source, or become a grant the parent holds?** Today
  a Temporary child's toolkit is captured at spawn from what the parent can see. Under one model that
  could be expressed as the parent granting a subset it holds — which is stricter, and might refuse
  delegations that work today. Measure the delta before deciding.
- **Which of the 58 branch points are consequences and which are species residue?** Sampled, not
  audited. The audit is cheap and belongs in the plan's first phase, because it sizes everything else.
