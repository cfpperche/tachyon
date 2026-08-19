# CompozyOS × Tachyon — levantamento de autonomia (loop, grafo, automação)

**Date:** 2026-08-19
**Author:** grok
**Kind:** research / decision packet. Measurement + recommendation only. No implementation.
**Trigger:** human pointed at https://x.com/pedronauck/status/2089895410307399692 (Pedro Nauck / CompozyOS: *loop + graph engineering + automations*) and asked to compare Tachyon pipelines, then to evaluate codebase + board for building something like Compozy here.
**Owner judgment at capture:** too early to build. This file exists so the context is not lost.

Sources, all read on 2026-08-19:

- Compozy: tweet, https://www.compozy.com/, https://github.com/compozy/compozy (README + PRODUCT.md). v0.3 beta; v0.2 `tasks run` pipeline is deprecated.
- Tachyon tree: `packages/engine/src/pipeline/`, `engine-service/`, `schedule/`, `tasks/`, `workspace/`, specs 206 / 222 / 230 / 231 / 325 / 382 / 480 / 491, board cards listed in §7.
- Two read-only explore passes over engine orchestration and pipeline/graph surfaces, cross-checked against the files named below.

This is not a design spec. If the product later wants Loops, write an SDD. Do not treat this file as authorization to implement.

---

## 0. One-line finding

Do **not** finish pipeline Fase 2 (`t-f05aa5`) to become Compozy. Compozy v0.3 **abandoned** their own v0.2 pipeline (`tasks run`) and executes work through **Loops** on a daemon. Tachyon already has the harder half of an agent OS (persistent engine, Board + CAS + attempts, tmux fleet, worktree/verify). What is missing is an **autonomy kernel**: Loop object, Heartbeat, lease-backed claim, event/webhook triggers, CLI as a second client. The board already holds those pieces, scattered and idle.

---

## 1. What Compozy is selling

Home and README (2026-08-19), collapsed to runtime objects:

| Promise | Object |
|---|---|
| Loop | First-class: typed guardrails, human gate, re-attempt, stop limits, durable runs. Tasks execute **through** Loops. `ClaimNextRun` + lease + heartbeat. Crash returns work to the queue. |
| Graph engineering | Composed work: Markdown tasks with frontmatter, capabilities, delegation with receipts. Not a linear YAML chain. |
| Automations | Cron + webhook + event **owned by the daemon**. Close the terminal; work continues. |
| OS | `compozy daemon start` is the truth. Web, CLI, HTTP/SSE, UDS, MCP are clients. Anything the UI can do, an agent can do. |

Also shipped around the kernel (out of Tachyon v1 scope if this is ever built): scoped Markdown memory + “dream” consolidation, `compozy-network/v0`, Slack/Discord/Telegram/… bridges, OS-shell desktop UI.

Critical precedent: **v0.3 does not revive the v0.2 `tasks run` pipeline.** They already made the mistake Tachyon would repeat by growing spec 230 into “the product”.

---

## 2. What Tachyon already has

### 2.1 Persistent engine (the daemon half)

Spec **382 shipped** (2026-07-15, `886880d1`). One engine per canonical workspace as a Linux **user** systemd unit (`tachyon-engine-<key>.service`). VS Code is a shell: reload is detach/attach. Last shell close does **not** stop the engine. Agents, Bridge, Tasks, schedules, monitors keep running; editor-only ops return `UI_UNAVAILABLE`.

| Piece | Path |
|---|---|
| Daemon entry | `packages/engine/src/engine-service/daemonMain.ts` |
| Supervisor (systemd user, Linux-only) | `packages/engine/src/engine-service/engineSupervisor.ts` |
| Headless host | `packages/engine/src/workspace/DaemonEngineHost.ts` |
| Contract | `docs/specs/382-persistent-engine-shell-boundary/spec.md` |

Limits vs Compozy’s daemon: no `Linger=yes` (dies with logout), no boot-start, no macOS launcher, started when a workspace is first opened, no public CLI/HTTP surface. Spec 235 is a **test** composition, not this service.

### 2.2 Board as shared work register

| Piece | Path | Fact |
|---|---|---|
| Task store | `packages/engine/src/tasks/TaskStore.ts` | `.tachyon/tasks/` JSON; statuses inbox/triaged/active/landed/done/dropped; in-process mutation mutex |
| Advisory pick | `packages/shared/src/tasks/nextTask.ts` | Mine first, then unassigned triaged/active; deps block unless `done`/`dropped` |
| CAS | spec 325 | `expect` on assignee/status/`updatedAt`. `next_task` is **not** a claim; the Bridge tool was **removed** |
| Spawn claim | `packages/bridge/src/spawnTaskClaim.ts` | `spawn_agent(claim_task:)` moves row to `active` + assignee in one transaction. Inbox refused |
| Attempt ledger | `packages/engine/src/tasks/TaskAttemptStore.ts` | Append-only `claimed` / `released` / `delivered` / `dropped`. **No TTL, no heartbeat, no steal** |
| Dead executor | `TaskStore.returnUnavailableAgentClaims` | Keeps `active`, **clears assignee**, journals “claimed work, nobody executing” |

This is a cooperative board, not `ClaimNextRun`.

### 2.3 Production orchestration today

Not pipelines. Coordinator + `spawn_agent` + `wait_for_agent` + Board. The DAG lives in the parent turn and dies with it. Spec 198: idle ≠ done.

### 2.4 Pipeline v1 (shipped, unused)

Spec 230 shipped as v0.24.0 (2026-06-18). Engine: `packages/engine/src/pipeline/`.

**Real:** linear one-shot chain, run-owned worktree, `complete_node` + per-node nonce, run ledger `.tachyon/runs/<id>.json`, `gate: approve`, spec 231 input/handoff, sidebar Pipelines tab, VS Code commands.

**Forbidden by the loader** (`loadPipeline.ts` ~296–308): fan-in / fan-out. Comment: *“parallel nodes are a follow pass”*. The state machine already understands diamonds (`runState.test.ts`); the loader is the gate.

**Designed, not shipped:** `done: signal_then_verify` (loader is `exit | signal` only; verify kinds were later **deleted**), `gate: verify`, sensors, templates, visual studio, per-node commit (Tier B), explicit pause.

**Theater:** `gate: exit:0` is accepted by the loader and never evaluated.

**Gone:** Pipeline Studio was spec 350 Fake 1; retired by `t-edfe12`. No `packages/webview-ui/src/webview/pipeline-studio/` source. Stale `dist/webview/pipeline-studio.js` may still be hashed in provenance.

**This repo does not dogfood it.** No `.tachyon/pipelines/`. No fixture YAML. No dogfood scenario. README “Agent Pipelines” section is gone. Examples lived in `~/tachyon-examples`.

Thesis of 230, still in force: pipelines **terminate**. Loops are a non-goal (Mastra/LangGraph territory).

### 2.5 Scheduler

`packages/engine/src/schedule/Scheduler.ts` + `Workspace.runSchedule` (~6477).

- `every:` / `at:` on the engine’s 3s tick.
- Fire action: **only** `spawn` a declared Saved Agent (start if down, else send `instructions` as a pane line). `run` / runbook keys from spec 206 were dropped; `spawn` is required.
- Pause is in-memory only.
- Agent `propose_schedule` is inert until human Inbox approval writes `tachyon.yml`.

Spec 206 says fire **only while the workspace is open** and lists “no 3am unsupervised agents” as a non-goal of daemonization. Spec 382 says schedules still fire with no shell. The **code** follows 382 (ticker lives on the engine). Capability matrix / Scheduler comment still repeat 206. Product intent (“do we want unsupervised 3am agents?”) was never re-ratified.

No webhooks. No git/PR/file sensors. No schedule → pipeline.

### 2.6 Approvals, memory, A2A

- Approvals: `.tachyon/approvals/`, pipeline `gate: approve`, schedule/Saved-Agent proposals, host-action default-deny. Resolve is a host action, not a Bridge tool.
- Memory: per-agent continuity (`.tachyon/continuity/<agent>.md`), pins, project `HANDOFF.md`, persistent instructions. Distill is explicit. No dream/consolidation loop.
- A2A: `notify_agent`, `write_input` / `read_output`, `wait_for_agent`, doorbells (`read_notices`, spec 493). No typed mailbox, no receipt protocol, no peer discovery.

### 2.7 Three graphs people keep collapsing

| Name | What it is | State |
|---|---|---|
| Pipeline DAG (230) | One-shot agent chain on a worktree | v1 linear, unused |
| Graph Engineering (`t-b1618e`) | Board waves, unlock by merge on `main` | inbox, discussion only |
| Execution Graph (SDD 480) | Process attribution (session → turn → tool → pid) | shipped 2026-07-28, **deleted** 2026-08-09 (`t-af240d`, merge `566c7e36`). 814 ledger rows, 36 proven. Do not revive (spec 500 non-goal). |

Planner (SDD 491, `t-2bba9c`) is a **fourth** thing: time axis over Board (`Plan` / `PlanEntry` / `PlanFiring`). Draft spec, zero code. Invariant already ratified: the plan does not own work; it references `t-xxxxxx`.

---

## 3. Gap matrix (Compozy pillar → Tachyon)

| Pillar | Tachyon | Verdict |
|---|---|---|
| Daemon survives the editor | Spec 382 | **Have** (Linux/WSL). Not linger/boot/macOS/CLI |
| Shared work queue | Board + CAS + attempts | **Have the register.** No lease |
| Durable sessions | tmux + SessionLedger + resume | **Have** (moat) |
| Worktree as state + verify | run/agent worktrees, verify gate, Delivery | **Have** (moat; do not replace with typed JSON) |
| Human gates | Inbox, approvals, pipeline approve, proposals | **Have** |
| Loop object | Explicit 230 non-goal | **Missing** |
| ClaimNext + lease + heartbeat | Attempts have no TTL | **Missing** |
| Event / webhook triggers | Scheduler spawn-only; heartbeat catalog is paper | **Missing** |
| Runtime-agnostic wake | `t-a48431` ratified 2026-07-29, zero code | **Missing** (designed) |
| CLI as OS client | Bridge MCP only; `t-c70fb9` **dropped** | **Missing** |
| Memory consolidation | Files + optional hooks | Partial |
| Typed A2A / Network | Pane + doorbells | Partial; out of v1 |
| Slack-class bridges | Companion mobile exists | Out of v1 |
| Visual pipeline studio | Retired fake | Do not rebuild for this |

---

## 4. What must change (theses, not just code)

Copying Compozy **on top of** Tachyon breaks contracts already taken. These have to be reopened, not routed around.

| Live thesis | Where | Why it blocks the target |
|---|---|---|
| Pipelines terminate; loops are Mastra | spec 230 | Pedro’s product *is* the loop |
| Schedules do not fire with the editor closed; no 3am agents | spec 206 | 382 already put the timer on the daemon. The **policy** is still live |
| `next_task` is advisory, not a claim | spec 325 | Compozy: idle worker pulls |
| Deps unlock on `done`/`dropped`, not merge to `main` | `nextTask.ts:69` | `t-b1618e` wants the other axis |
| Coordinator writes the DAG in the prompt | primer + practice | A Loop/daemon has to be the orchestrator |
| Fase 2 of 230 = sensors + studio + parallel | `t-f05aa5` | Wrong follow-up if the target is Compozy |
| CLI is not a product (install = VSIX) | 382 non-goal + `t-c70fb9` dropped | Compozy: same state from CLI and UI |
| Planner daemon tick is slice F | SDD 491 | If the Loop lives on the engine, time cannot wait for F |

**Do not change:**

- Board remains the authority on “this is work”. Planner already got this right. A Loop must not become a second board.
- Worktree + verify remain the state that flows. Do not swap for LangGraph-style typed blobs.

---

## 5. Tachyon-shaped architecture (if / when)

Three objects. Everything else derives.

```
Trigger (cron / typed event / later webhook)
    → Loop (durable supervisor on the existing engine)
        → Claim on the Board (attempt + lease)
            → Heartbeat wakes a Saved Agent
                → agent works in a worktree
                    → complete / fail / human gate
                        → Loop pulls next or stops
```

- **Loop** is new. Not pipeline YAML. Policy: what to pull, when to stop, what to do on red, who approves. Runs on the engine that **already exists**.
- **Board** stays the what. Loop does not hide work.
- **Heartbeat** (`t-a48431`) is the wake. Contract already ratified.
- **Trigger** extends Scheduler + the event catalog already listed on the Heartbeat card. Webhooks later.
- **Pipeline v1** stays a *one-shot recipe* (research → implement → review) a Loop may start — or freezes. It is not the product.
- **Graph** = Board deps (+ merge-gate if `t-b1618e` is ever decided) + recipes. Not XYFlow.

Out of a first version: Compozy Network, Slack/Discord, dream memory, OS-shell desktop, cloning their web UI.

Suggested order if the owner later says go (not authorized by this file):

1. Reopen 206 vs 382 (policy for unsupervised fire).
2. Implement Heartbeat (`t-a48431`) — deps `t-357879` / `t-04052d` / `t-4071e4` are already `done`.
3. Lease on the attempt ledger (TTL + heartbeat + requeue).
4. Loop v1 — one supervisor, dogfood **in this repo** (pipelines never were).
5. Event triggers from the Heartbeat catalog. File/git/PR later (rewrite `t-f05aa5` frente 1 if needed).
6. CLI — reopen `t-c70fb9` / rewrite `t-784bc8` (body is stale: it still calls the daemon a north star; 382 shipped).

---

## 6. Board already holding the pieces

Measured 2026-08-19 via `list_tasks` / `get_task`. None of these is assigned to this work.

| id | title (short) | status | Role vs this finding |
|---|---|---|---|
| `t-a48431` | Agent Heartbeat | triaged | **Right primitive.** V1 ratified 2026-07-29. Zero code. Sweep 2026-08-17: deps done, HOLD lifted, still unimplemented |
| `t-2bba9c` | SDD 491 Planner | triaged | Time axis. Spec draft. Daemon = slice F |
| `t-f05aa5` | Pipeline Fase 2 | triaged | Sensors useful; studio / parallel / Tier B are the wrong path. Sweep 2026-08-16: no frente started; loader still refuses fan-out |
| `t-b1618e` | Graph Engineering | inbox | Merge-gated waves. Discussion only. Sweep: needs rewrite (does not know 480 died or 491 exists) |
| `t-299769` | Orca study 04 orchestration | inbox | The right question: do we need a supervised layer beyond spawn/wait? Still open. Partial answer in `docs/research/orca-orchestration-task-lifecycle-land.md`. SDD 499 attempts shrank the hole |
| `t-784bc8` | Runtime API / service-layer | inbox | CLI+UI+Bridge on one contract. Body stale vs 382. Depends on `t-c70fb9` which is **dropped**. Sweep: PRECISA REESCREVER |
| `t-c70fb9` | Orca study 01 CLI | **dropped** | Second OS surface. Blocking 784bc8 as written |
| `t-feda36` | Herdr attach/CLI/headless | inbox | `tachyon attach`, remote |
| `t-a11be4` | Plugin service/daemon | triaged | Plugin lifecycle, not the autonomy kernel |
| `t-edfe12` | Retire Pipeline Studio | **done** | Fake surface gone. Do not revive |
| SDD 480 | Execution Graph | abandoned | Process graph, not work graph |

Related pins: none of the open pins name this (marketplace, gardens, metrics, etc.).

---

## 7. File index (so a later agent does not re-walk)

```
packages/engine/src/pipeline/{loadPipeline,PipelineManager,doneContract,runState,pipelineDriver,completeNode,RunLedger,nodePrompt,preflight}.ts
packages/engine/src/engine-service/{daemonMain,engineService,engineSupervisor}.ts
packages/engine/src/workspace/{Workspace.ts,DaemonEngineHost.ts}
packages/engine/src/schedule/{Scheduler.ts,ProposalStore.ts}
packages/engine/src/tasks/{TaskStore.ts,TaskAttemptStore.ts}
packages/shared/src/tasks/nextTask.ts
packages/bridge/src/spawnTaskClaim.ts
packages/bridge/src/tools/{fleet.ts,automation-schedules.ts,verification.ts,communication-waits.ts}
docs/specs/206-tachyon-schedules/
docs/specs/222-tachyon-agent-dag/          (PARKED)
docs/specs/230-tachyon-agent-pipelines/
docs/specs/231-tachyon-pipeline-run-input/
docs/specs/325-task-queue-entity/
docs/specs/382-persistent-engine-shell-boundary/
docs/specs/480-execution-graph/            (abandoned)
docs/specs/491-planner-time-axis-over-board/  (draft)
docs/research/orca-orchestration-task-lifecycle-land.md
docs/research/inbox-sweep-bloco-d.md       (t-f05aa5 / t-b1618e as of 2026-08-16; pipeline-studio note is stale after t-edfe12)
```

---

## 8. What this file is not

- Not a go-ahead to implement.
- Not a replacement for an SDD if Loop is later wanted (need actor × trigger table, crash, 3am, gate-with-no-shell).
- Not a request to reopen `t-f05aa5` as written.
- Not a request to revive SDD 480 or Pipeline Studio.

When the owner says the time has come: start from §5 and `t-a48431`, not from pipeline YAML.
