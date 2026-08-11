# 230 — tachyon-agent-pipelines (DESIGN — debate before code)

_Created 2026-06-17._

**Status:** shipped
**Closure:** Shipped as v0.24.0; the checked task closure records the built, reviewed, and dogfooded pipeline v1.
**Status detail:** SHIPPED v0.24.0 (2026-06-18) — pipeline v1 built, codex-reviewed across rounds, dogfooded in
the EDH, documented, and published. Pin `p-3fb275` CLOSED on this v1; Phase 2 (sensors / visual Studio /
Tier B / per-node staleness / parallel / explicit pause) → follow-pin `p-cbcc94`. See tasks.md `Closure`.
The original design + review record is preserved below. (Was: DESIGN — codex review 2026-06-17,
CHANGES with 2 BLOCKER + 3 MAJOR + 1 MINOR, all folded.) Fresh spec, from zero. **Spec 222 (agent-DAG) is abandoned, NOT reopened** — its
`needs:`/`after-verify:` sketch and its PARK record are superseded by this design and are not a
dependency. This spec stands on its own thesis. Next: lock the revised design, then `plan`.

## codex design review — 2026-06-17 → CHANGES → all folded
The review's core finding: Tachyon's primitives today are **agent-scoped**; this spec assumed
**run-scoped** worktrees and authenticated completion that don't exist yet. Folded:
- **B1 (BLOCKER)** — `done: verify` is not a complete protocol: the spec-214 verify gate is **advisory/
  manual, not auto-blocking** (`214 spec:51`, `Workspace.ts:641`), and there is no trigger to verify an
  interactive agent without idle/signal. FIX: the default is now **`signal_then_verify`** (agent signals
  via `complete_node` → Tachyon runs verify → accept only on `{passed:true, stale:false}`); commands use
  **`exit`** (optionally `exit_then_verify`); every node carries a **`timeout`/`maxDuration`** and
  **fails closed** on exit-without-required-signal. Idle is still never a done signal. See § Done-contract.
- **B2 (BLOCKER)** — pipeline-owned worktree collides with the agent-owned model: worktree paths are
  `<base>/<wsHash>/<agent>` and `ensure()` is keyed by agent (`WorktreeManager.ts:70,223`), and the
  worktree is persisted on the agent ledger row (`AgentManager.ts:475`). FIX: add **run-scoped worktree
  allocation + a per-node spawn-cwd override** (a node's agent is spawned with the pipeline run's
  worktree as cwd, not its own agent-keyed path). This is the single biggest implementation risk — it
  needs a new allocation path, not a config tweak. See § Data flow.
- **M1 (MAJOR)** — `complete_node` can't trust caller identity: the Bridge is stateless per POST and all
  agents share the one workspace token (`Bridge.ts:22,117`, `token.ts:6`). FIX: inject a **per-node
  nonce/capability** into the node agent's env; `complete_node` validates `runId/nodeId/nonce` + live
  session + rejects duplicates + rejects stale runs.
- **M2 (MAJOR)** — durability duplicates/conflicts with `.tachyon/sessions.json`: activation already
  plans resume from session-ledger rows (`Workspace.ts:851`, `planResume.ts:35`), so pipeline nodes
  would be double-resumed. FIX: **one owner of pipeline-node sessions** — suppress generic autostart/
  resume for pipeline-owned nodes and reconcile live/dead/resumable state before re-entering.
- **M3 (MAJOR)** — retry-in-place is under-specified for mutable worktrees (they can be removed/reset:
  `WorktreeManager.ts:447`, `SessionLedger.ts:118`). FIX: retry **preflights** worktree existence /
  branch / HEAD / dirty / upstream outputs, and otherwise requires an explicit reset or a new run.
- **MINOR** — fork/sub-worktree starts from committed HEAD and does NOT carry uncommitted dirty work
  (`WorktreeManager.ts:376`, `AgentManager.ts:121`). FIX: Phase-1 parallel nodes are **read-only
  analysis only**; writable fan-out + merge/fan-in is Phase 2.

## Thesis — why this is different from a "workflow engine"

Tachyon is for **software development**: work arrives as **bounded tasks** ("implement feature X", "fix
bug Y", "migrate Z") that have a beginning and an **end**. That is the opposite of what Mastra and
LangGraph are built for — **continuous, long-running, in-process application workflows** that stay up
reacting to events and pass a typed state object between fine-grained function steps.

So Tachyon's unit is a **one-shot pipeline**: it takes one task, runs an ordered/DAG sequence of
**agent task-nodes** that transform a git worktree, gates progress on **verify**, **completes**, and
frees you to run the next one. Pipelines **terminate** — they do not loop forever.

Two consequences fall out of "one-shot + software dev", and they are the spine of this spec:

1. **"Done" stops being a heuristic.** A one-shot node finishes on a *real* signal — process exit,
   verify-gate green, or an explicit done-signal — never on interactive-idle (the heuristic that sank
   spec 222's Q1). See § Done-contract.
2. **The state that flows between nodes is the code on disk** (the worktree/branch), not a typed JSON
   blob (Mastra). This resolves the substrate mismatch with Mastra/LangGraph and the one-agent-per-
   worktree tension (222 Q4) — the worktree belongs to the **pipeline**, not to a loose agent.

### Why NOT embed/mirror Mastra or LangGraph (from the prior study)
Both orchestrate in-process steps sharing typed state, persisting snapshots to libsql/postgres. Tachyon
nodes are whole CLI agents in tmux panes — coarse OS processes with private context windows. Embedding
either = a heavy framework wrapping a thin shell-out, with snapshots that capture `{exitCode}` and miss
the agent's real work. We **borrow the authoring model** (graph; conditional edge = gate; human
interrupt = approval gate; checkpoint = run ledger) and run it on Tachyon's own process+tmux+worktree
runtime — which is exactly what those frameworks do not have.

## Intent

Let a user compose the agents they already configure (the per-task-type workers in `tachyon.yml`) into
a **declarative, one-shot pipeline** that Tachyon orchestrates end-to-end: start order from completion/
gate signals, a worktree that flows down the chain, a durable run that survives a VS Code restart, and
human-approval gates where wanted — instead of the human hand-sequencing a multi-step task by hand
through the Bridge.

## Core model (nouns)

- **Pipeline** — a named declarative DAG of nodes, defined in `.tachyon/pipelines/<name>.yml` (kept out
  of `tachyon.yml` so the agent config stays lean). Acyclic; validated at load.
- **Node** — one **one-shot task**: an agent-ref (or a command/runbook) + an input task-prompt + a
  **done-contract** + an optional **gate**. A node runs, completes on its done signal, and never
  re-fires within a run.
- **Edge** — a dependency `A -> B`: B becomes runnable when A is `done` AND B's gate passes. Fan-in
  (`B needs [A, C]`) waits for all.
- **Gate** — a predicate evaluated before a node advances: `exit:0` | `verify` (spec-214 gate green) |
  `approve` (human). Failure holds downstream **visibly blocked** with the upstream reason.
- **Run** — one execution instance: a run id, per-node status (`pending|running|blocked|done|failed|
  awaiting-approval`), and the owned worktree. Persisted to `.tachyon/runs/<id>.json`.

### Example `.tachyon/pipelines/feature.yml`
```yaml
name: feature
worktree: own            # the pipeline owns one worktree that flows down the chain (default)
nodes:
  research:
    agent: researcher          # references an agent defined in tachyon.yml
    task: "Research approaches for: ${input.task}"
    done: signal               # research writes notes (no code) → bare signal, no verify
    timeout: 20m
  implement:
    agent: coder
    task: "Implement, using research/ notes: ${input.task}"
    needs: [research]
    done: signal_then_verify   # agent signals → Tachyon runs verify → accept iff passed & not stale
    timeout: 45m
  review:
    agent: reviewer
    task: "Review the diff on this branch"
    needs: [implement]
    gate: approve              # human approves before the pipeline completes
```

## Done-contract — THE central decision (revised per codex B1)

The spec-214 verify gate is **advisory/manual today, not auto-blocking**, and there is no way to verify
an interactive agent without an explicit trigger — so verify alone is NOT a completion protocol. An
interactive node therefore needs a two-beat contract: **the agent signals, THEN Tachyon verifies.**
Each node declares `done:`:

- **`done: signal_then_verify`** *(default for agent nodes)* — the agent calls **`complete_node`** when
  it believes it's finished → Tachyon runs the verify gate on the run worktree → the node is accepted
  **only on `{passed:true, stale:false}`** (stale = empty/no-op diff against the upstream baseline);
  red or stale → `failed`/`blocked`, not done.
- **`done: exit`** — for **non-interactive** nodes (`cmd: codex exec …`, `sh`, a runbook): exit `0` =
  done, non-zero = failed. A real OS signal. (`done: exit_then_verify` also runs verify after a 0 exit.)
- **`done: signal`** — bare signal with no verify, for nodes where verify doesn't apply (e.g. a
  research/analysis node that writes notes, not code).

Every node carries a **`timeout` / `maxDuration`**; on timeout the node `fail`s closed. A node that
**exits without its required signal also fails closed** (never silently "done"). **Interactive-idle is
NEVER a done signal** (the 222 Q1 line). The verify run used here is an **on-demand, blocking** invocation
the pipeline owns — distinct from the sidebar's advisory verify badge.

## Data flow & worktree ownership (resolves 222 Q4)

The artifact passed between nodes is the **code in the worktree/branch**, not typed state.
- **Default (`worktree: own`):** the pipeline run allocates ONE worktree at start; each node runs in it
  **in sequence**, so a downstream node sees upstream work. The worktree belongs to the *pipeline run*,
  not an agent.
- **codex B2 — this needs a new run-scoped path, NOT a config tweak.** Today worktrees are agent-keyed
  (`WorktreeManager` paths `<base>/<wsHash>/<agent>`, `ensure()` keyed by agent, `worktree` persisted on
  the agent ledger row). MVP must add **run-scoped worktree allocation + a per-node spawn-cwd override**:
  a node's agent is spawned with the *run's* worktree as cwd instead of its own agent-keyed checkout.
  This is the **single biggest implementation risk** and the first thing `plan` must de-risk (a spike).
- **Parallel nodes** that write the same tree are unsafe, AND today's fork/sub-worktree starts from
  **committed HEAD and does not carry uncommitted dirty work** (codex MINOR). MVP rule: parallel sibling
  nodes are **read-only/analysis only**. Writable fan-out (own sub-worktree per node) + merge/fan-in is
  **Phase 2** — auto-merging divergent worktrees is out of MVP entirely.

## Hard design questions (the 222 set, re-answered for one-shot)

1. **Done-detection** — solved by the done-contract above; no idle. *(Was the 222 BLOCKER.)*
2. **Failure** — node fails (non-zero exit / verify red / stale diff / human reject / timeout) →
   downstream `blocked` with the reason; run = `failed`. No auto-retry, no silent wedge. Manual
   **retry-node** (preflighted — see Q5).
3. **Cycles / validation** — reject unknown refs / self-deps / cycles at config-load (loadConfig +
   schema). Fan-in waits for all upstream.
4. **Worktree** — the pipeline RUN owns the worktree (flows down) via a new run-scoped allocation +
   spawn-cwd override (codex B2). Parallel = read-only in MVP; writable sub-worktrees + merge are Phase
   2. *(Was a 222 tension; now resolved by run-ownership.)*
5. **Re-runs / idempotency** — each invocation is a **new run** (new id, new worktree). **Retry-node**
   re-runs one node in place but **preflights** the worktree (exists / right branch / HEAD / dirty) and
   upstream outputs first (codex M3); if the state moved, it requires an explicit reset or a new run. No
   auto-refire of the graph; resume RESTORES a run, never re-evaluates it. **Durability owner (codex
   M2):** pipeline-owned node sessions have ONE owner — generic autostart/resume is suppressed for them
   and live/dead/resumable state is reconciled before re-entering any node.
6. **Overlap** — N/A. This is a first-class **Tachyon** capability built on its own runtime; it does
   not compete with anything outside the product. (Sensors, Phase 2, are Tachyon's by merit.)
7. **Scope creep** — contained by: one-shot only, no continuous/always-on workflows, no typed in-process
   state, no visual drag-drop builder (authoring stays YAML), no embedded framework. See Non-goals.

## Design — phased (all phases in THIS spec, in sequence)

### Phase 1 — MVP (the core that makes a pipeline exist)
0. **Spike (de-risk first)** — run-scoped worktree allocation + per-node spawn-cwd override (codex B2);
   prove a node-agent can be spawned into the run's worktree, not its agent-keyed path.
1. **Pipeline definition** — `.tachyon/pipelines/<name>.yml` loader + schema; DAG validation (acyclic,
   refs resolve to known agents/commands) at load.
2. **One-shot node + done-contract** — spawn an agent/command with the task prompt; detect done via
   `signal_then_verify | exit | exit_then_verify | signal`; **`timeout`/`maxDuration`** per node;
   fail-closed on exit-without-signal and on timeout; an **on-demand blocking verify** the pipeline owns
   that returns `{passed, stale}`.
3. **Authenticated `complete_node` Bridge tool** — per-node **nonce/capability** injected into the node
   agent's env; validates `runId/nodeId/nonce` + live session, rejects duplicates + stale runs (codex M1).
4. **Edges + gates** — dependency ordering + fan-in (wait-for-all); gate predicates
   `exit:0 | verify | approve`; fail-closed blocked-downstream semantics with the upstream reason.
5. **Worktree flow** — the run-scoped worktree (item 0) flows down the chain; teardown on completion/
   dismiss; parallel nodes read-only in MVP.
6. **Run ledger + durability (single owner)** — `.tachyon/runs/<id>.json` with per-node status; resume
   after a VS Code restart re-enters the first incomplete node; **suppress generic autostart/resume for
   pipeline-owned nodes** and reconcile state before re-entry (codex M2). **Retry-node preflights**
   worktree + upstream outputs (codex M3).
7. **Human gate** — `gate: approve` pauses the run (`awaiting-approval`), surfaced with an Approve/Reject
   action in the sidebar. (The honest analog of Mastra suspend/resume — no opaque snapshot.)
8. **Pipeline as a first-class sidebar item** — a run shows as a tree node with per-node child states
   (pending/running/blocked/done/failed/awaiting-approval) and run controls **▶ start / ⏹ cancel /
   ↻ retry-node**.

### Phase 2 — fast-follow (after the MVP proves value)
9. **Pipeline templates** — reusable pipeline definitions (e.g. feature / bugfix: research → implement →
   verify → review → PR), parameterized by `${input.task}`. Ties into the fleet-templates backlog idea.
10. **Studio visualization** — visualize the pipeline as a graph with live run state + step traces read
    from the run ledger (Mastra/XYFlow-style). **Authoring stays YAML**; the Studio shows and runs, it is
    NOT a drag-drop generator. Extends the existing Agent Studio webview.
11. **Sensors (dev-scoped)** — discrete dev-event triggers that START a pipeline: a file/glob change, a
    git event (branch pushed / PR opened), a command completing. NOT cron/continuous monitoring. A
    Tachyon-native capability evaluated on its own merit.

## Non-goals (contain scope)
- Not a continuous / always-on workflow engine (that is Mastra/LangGraph territory; not software dev).
- Not typed in-process state passing — the worktree IS the state.
- Not a visual drag-and-drop builder that generates pipelines (even Mastra authors in code; the Studio
  visualizes + runs).
- Not embedding Mastra or LangGraph.
- Not cron/long-running schedulers as the primary trigger (Phase-2 sensors are discrete dev events).
- Not interactive-idle as a completion signal — ever.
- Not auto-merging divergent parallel worktrees in MVP.

## Naming
**Pipelines** (feature surface: "Agent Pipelines") — describes the one-shot, deterministic, task-scoped
nature better than "Workflow". The visual layer lives inside the existing **Agent Studio**, not a
separate "Workflow Studio".

## Decision gate
After codex review: either (a) lock Phase-1 scope + the done-contract default and proceed to `plan`/
implementation, or (b) fold codex's CHANGES (esp. on the done-contract, worktree-flow, and parallel/
fan-in semantics) and re-review. The done-contract default (`verify` for agents, `exit` for commands,
`signal` as escape) is the single most important thing for codex to attack.
