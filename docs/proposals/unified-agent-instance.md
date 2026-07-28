# Unified Agent Instance

## Problem

Tachyon currently keeps canonical and ad-hoc agents as partially distinct
concepts and technical paths, although both already share most operational
responsibilities: they start LLM runtimes, receive model/configuration, tools
and permissions, may own a task, brief, parent, or worktree, emit Activity,
Attention, and evidence, and require correct lifecycle and cleanup.

The product distinction remains useful, but the technical duplication means
that every lifecycle, authorization, isolation, telemetry, or parity fix must
be designed and proved twice. The term "ad-hoc" also hides the fact that these
processes are already governed agents; they are simply temporary.

## Proposed decision

Unify canonical and ad-hoc agents behind one agent infrastructure. They stop
being two technical species and become identity and lifetime variants of the
same `Agent Instance`.

```text
Agent Profile (optional)
        |
        v
Agent Instance
        |
        v
Runtime Session
        |
        v
Assignment / Delivery
```

### Agent Profile

A human-owned durable definition containing stable identity and configurable
policy. This is what currently supports a canonical/saved agent: name, runtime,
model, authorized native configuration, skills, MCP, hooks, memory,
presentation, and other persistent preferences.

A Profile is not a process, session, task, worktree, or active continuity.

### Saved-agent ownership

Tachyon already allows a declared agent to name other declared agents in
`subagents`. The loader derives child-side `declaredOwner` metadata and exposes
it in the roster. This is intentionally **profile/configuration ownership**, not
runtime lineage:

- both entries remain independently declared Saved Agents;
- ownership does not automatically start, stop, restart, assign work to, or
  inherit configuration into the child;
- runtime `parent` remains the actor/delegation edge;
- v1 accepts only one ownership level and rejects nested ownership trees.

The unified model must preserve this distinction explicitly. A Saved Agent may
own or organize other Saved Agent Profiles, while a running Agent Instance may
spawn a Temporary child. Profile ownership and Instance lineage are different
edges and must never be inferred from one another.

### Agent Instance

The governed operational entity representing an agent at work. Every instance
uses the same infrastructure for private runtime homes, configuration
projection, permissions, tools, lifecycle, Attention, Activity, Execution
Graph, worktrees, and cleanup.

An instance initially supports two identity/lifetime policies:

- `saved`: references a durable Agent Profile, has stable identity, and may be
  restarted or resumed according to policy;
- `temporary`: is created for a bounded delegation, creates no durable profile,
  inherits only explicitly permitted configuration, and is collected when its
  work finishes.

These policies must not create parallel implementations.

### Runtime Session

The concrete process/session of an LLM runtime. An Agent Instance may survive
restart/resume and, in the future, more than one runtime session without
confusing agent identity with a PID, tmux session, or native transcript.

### Assignment / Delivery

The work assigned to the instance: task, delivery, brief, parent/lineage,
constraints, owned paths, and done-when. It is not part of agent identity and
may change without recreating or renaming the Profile.

## Probe remains separate

```text
Probe = model invocation
Agent = governed worker
```

A Probe is a short, bounded execution used to obtain an analysis, review, or
verdict. It may reuse runtime adapters, model selection/proof, budgets,
redaction, and telemetry, but it has no operational identity, task,
continuity, worktree, parent, autonomous lifecycle, or Fleet presence.

Tachyon must neither turn a Probe into a hidden agent nor turn every model call
into an Agent Instance.

## Product language

Gradually replace the exposed terms:

- `Canonical Agent` becomes `Saved Agent`;
- `Ad-hoc Agent` becomes `Temporary Agent`;
- `Probe` remains `Probe`.

"Canonical" may remain an internal term for canonical authority/profile during
migration, but it must not designate a second species of worker.

## Expected behavior

- Saved and Temporary use the same runtime admission and lifecycle machine.
- Both receive private runtime homes, projected configuration, permissions,
  MCP, skills, hooks, and execution through the same pipeline, according to
  runtime capabilities and policy.
- Both appear as Agent Instances in Fleet, differentiated by lifetime policy,
  not by a parallel renderer or store.
- Temporary requires a structured delegation contract, a parent when
  applicable, and a termination condition; it never gains implicit
  persistence.
- Saved references a Profile and may operate without a parent.
- A Temporary instance may be explicitly promoted to Saved by creating a
  Profile from permitted fields. Promotion is never automatic and never copies
  credentials, transcripts, caches, or private native state.
- A Saved instance may create a Temporary child without duplicating
  infrastructure.
- Saved Profile ownership may organize other Saved Profiles, but it does not
  create runtime children or grant lifecycle authority by itself.
- Temporary cleanup collects temporary resources according to policy and
  preserves only governed records and evidence.
- Restart, resume, and fork explicitly name whether they act on Profile,
  Instance, or Runtime Session.
- Task ownership, Delivery lease, and worktree belong to Assignment/Instance,
  not Profile.
- Runtime processes and terminals remain infrastructure/surfaces, not agents.

## Migration and compatibility

Use an incremental migration rather than a big bang:

1. Define types and invariants for Profile, Instance, Session, and Assignment.
2. Create one internal spawn/start port for Agent Instance.
3. Adapt Temporary/ad-hoc to this port while preserving the public
   `spawn_agent` contract.
4. Adapt Saved/canonical to the same port while preserving Agent Studio,
   restart, and resume.
5. Unify Fleet, Activity, Attention, Execution Graph, cleanup, and parity
   tests.
6. Expose the new terminology and retain compatibility aliases for a defined
   period.
7. Remove duplicate paths, stores, and heuristics only after equivalence and
   dogfood proof.

The migration must not infer agent kind from command, name, tmux session, or
presence in `tachyon.yml`; identity and lifetime are declared fields.

## Parity and verification

Redesign the matrix to reduce duplication:

- one `Agent Instance infrastructure` dimension per runtime;
- `saved` and `temporary` policy variants only where behavior legitimately
  differs;
- Probe remains its own dimension;
- reuse the same lifecycle, configuration projection, authorization,
  auth-required, Attention, Activity, worktree, Execution Graph, and cleanup
  tests between Saved and Temporary;
- prove no regression for Claude, Codex, and Grok first;
- treat OpenCode, Pi, and Hermes as secondary priority;
- do not require total long-tail runtime parity to complete the architecture.

## Non-goals

- Do not unify Probe and Agent.
- Do not turn terminals or processes into agents.
- Do not make every Agent Instance persistent.
- Do not save credentials, transcripts, caches, runtime databases, or private
  homes in Agent Profile.
- Do not create a generic template language or framework beyond what is
  necessary.
- Do not rewrite all adapters simultaneously.
- Do not unnecessarily change public Bridge contracts in the first phase.

## Initial deliverable

Before implementation, produce and present for human ratification an SDD
proposal containing:

- data model and ownership for the four entities;
- lifecycle machine and identity/lifetime rules;
- mapping of current Saved/canonical and Temporary/ad-hoc paths;
- incremental plan with compatibility and rollback points;
- impact on Bridge, Fleet, Studio, Runtime Config, Execution Graph, tasks,
  deliveries, worktrees, continuity, Attention/Activity, and the parity matrix;
- the concrete list of duplicate mechanisms to remove;
- risks and required evidence for each phase.

Implementation remains blocked until the human reads and ratifies that
proposal.
