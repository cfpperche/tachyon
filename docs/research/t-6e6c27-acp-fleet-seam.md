# ACP session versus fleet agent: where the seam actually is

_Task `t-6e6c27`, measured from the production tree on 2026-08-12. This is a source map, not a v2
design. No ACP process was needed: `t-2aabc0` already measured process ownership and protocol
capabilities; this pass counts the Tachyon paths that would have to consume a second live transport._

## Verdict first

**There is no live-agent seam in `AgentManager`.** Its public constructor takes the concrete
`TmuxService` (`src/agents/AgentManager.ts:557-559`), its canonical identity conversion is
`agent name -> tmux session name` (`:1077-1083`), and its live inventory is made by enumerating tmux
sessions and decoding their names (`:1541-1549`). The roster then unions that inventory with config
and ledger names (`:1752-1769`). This is the point that decides the answer: adding an ACP
implementation is not enough, because there is no interface for it to implement.

**But tmux is not sewn into every mechanism.** Identity and durable state are already addressed by
agent name. Board claims, worktree records, the durable doorbell trail, queued-notice metadata, and
continuity storage do not require a pane. The most useful existing seam is `AttentionMonitorIO`
(`src/attention/AttentionMonitor.ts:96-102`): the monitor consumes injected `runningAgents`, capture
and CPU functions rather than importing tmux. Production closes that abstraction back over tmux in
one adapter block (`src/workspace/Workspace.ts:1341-1353`). An ACP-backed implementation could feed
structured prompt start/finish and permission state there; the monitor itself is not the place where
tmux must be removed.

So the measured answer is: **the durable half is already abstract enough; the live half is not.** A
v2 that remains a real fleet agent needs a new live-agent transport/lifecycle boundary and then must
route the pane-specific sites below through it. A standalone chat process can be built more cheaply,
but it would repeat v1's central limitation and would not be a fleet agent.

## Counting rule

A “site” below is a distinct production decision or transport call in the requested mechanism, not
every textual occurrence of `tmux`, and not tests/comments. Alternative branches at one decision are
counted separately when they invoke separate transports (for example the hardened and legacy submit
paths). Counts intentionally overlap between rows: `notify_agent` is both communication and the
delivery edge of the doorbell. They must therefore **not** be summed into a repository-wide total.
The citations name the complete counted sets.

`P` means pane/tmux-specific. `A` means already agent-name/data addressed. The result is **36 P site
memberships across the nine requested mechanism rows**; because four communication/delivery sites
belong to more than one row, that is deliberately a mechanism workload number, not “36 independent
places in the repository.”

## Mechanism-by-mechanism map

| mechanism | counted sites | what it addresses today | pane or merely addressable agent? | what an ACP fleet session lacks |
|---|---:|---|---|---|
| roster + `list_agents` | **3 P, 2 A** | Concrete manager dependency (**P**, `AgentManager.ts:557-559`); name-to-session conversion (**P**, `:1077-1083`); tmux inventory/decode (**P**, `:1541-1549`); config/ledger/name union and row projection (**A**, `:1752-1803`); Bridge enrichment by manager row + attention (**A**, `src/bridge/tools/fleet.ts:919-940`). | Presence is name-addressed after inventory, but “running” means a decoded tmux pane. | A live-instance registry able to contribute an ACP child/session and state without manufacturing a tmux session name. The existing row projection can remain. |
| `AttentionMonitor` | **4 P at its production adapter, 1 A seam** | The monitor's I/O interface is injected (**A**, `AttentionMonitor.ts:96-102`). Workspace supplies running agents, normal capture, ANSI capture, and pane-subtree CPU (**4 P**, `Workspace.ts:1343-1351`). The monitor calls only that interface (`AttentionMonitor.ts:428-438,905-921`). | Monitor: addressable source. Current adapter: pane. | A second monitor source driven by ACP request/update lifecycle. ACP has no composer collision, ANSI screen, or meaningful pane CPU; those fields need explicit “not applicable”/protocol-derived semantics rather than fake captures. |
| `notify_agent` + `write_input` | **12 P, 2 A** | `write_input` resolves a tmux session/liveness once and has **7** transport call sites across bootstrap, raw type, hardened submit and fallback (`communication-io.ts:117-143,167-181`). `notify_agent` has one tmux liveness probe (`:252-268`). Common Workspace delivery has a fresh composer probe and queue policy (**2 A**, `Workspace.ts:4238-4257`) but its final liveness + submit are **2 P** (`:4438-4449`). | Governance, addressing and queue decision are by agent name; actual delivery is pane typing. | An addressable `send` operation. For ACP it should invoke the session prompt/input channel and use protocol busy state; `submit=false` and arbitrary terminal keystrokes have no ACP equivalent and must be reported unsupported, not emulated. |
| `read_output` + pane capture | **5 P, 1 A fallback** | Live/dead-pane selection and two captures are **3 P** (`communication-io.ts:30-43`). Manager postmortem capture and pipe attachment are **2 P** (`AgentManager.ts:3770-3797`). Durable transcript lookup is file/name-addressed (**A**, `communication-io.ts:46-68`). | Live output is intrinsically a pane snapshot; only stopped fallback is abstract data. | An ACP event/transcript projection with an explicit capability/source label. It cannot honestly claim to be “what a human looking at the terminal sees”; it is structured conversation output. |
| `kill_agent` / dismiss | **4 P, 2 A** | Bridge governance and worktree cascade are name/record addressed (**A**, `fleet.ts:365-390`); dismiss row cleanup is name/ledger addressed (**A**, `:418-452`). Core kill checks and kills one tmux session (**2 P**, `AgentManager.ts:3495-3507`). Graceful stop also reads/sends to the pane before the hard kill (**2 P decision groups**, `:3608-3724`). | Policy is agent-addressed; process authority is tmux-session authority. | A lifecycle port that owns the ACP child handle and cancel/close semantics, plus a common “instance gone” result for the existing cleanup cascade. |
| worktree link | **2 P adjuncts, 4 A** | The worktree and ownership are ledger records keyed by agent name (**A**: `AgentManager.ts:3491-3493`; Bridge cascade `fleet.ts:379-388,439-452`). Spawn claims are applied independently of launch transport (**A**, `fleet.ts:160-173,263-269`). The live-occupancy refresh asks the tmux-backed running roster and optionally pane PID (**2 P**, `AgentManager.ts:2331-2343,2368-2378`). | The link itself only needs an addressable agent; two safety observations assume a pane process. | Record the ACP child PID/handle as occupancy evidence and include ACP instances in common liveness. Git/worktree creation and ledger shape need not become ACP-specific. |
| board task claim | **0 P, 2 A** | Claim is decided from task + target name, then applied to the task store before launch (`fleet.ts:160-173,263-269`). | Addressable agent only. | Nothing transport-specific. The ACP instance must use the same fleet name/Bridge identity so task ownership does not split. |
| doorbell + queued notice | **3 P, 5 A** | Durable witness append/read is name-keyed JSONL (**A**, `src/bridge/doorbell.ts:35-48,73-107`). Queue metadata/policy is name-keyed (**A**, `Workspace.ts:4238-4257,4434-4435`). Delivery reuses notify's tmux preflight (**1 P**, `communication-io.ts:252-268`) and Workspace liveness/submit (**2 P**, `Workspace.ts:4438-4449`). | Witness and queue need only an addressable name; waking the target requires pane delivery today. | Preserve the existing durable witness/queue and replace only the final delivery port. ACP busy/idle can make flushing more exact than screen polling. |
| continuity | **3 P, 5 A** | Get/set/status are pure name + store operations (**A**, `coordination-continuity.ts:17-49,51-100,103-130`). Workspace badge/body are store reads (**A**, `Workspace.ts:3968-3997`). UI reinjection has tmux liveness plus two submit sites (**3 P**, `Workspace.ts:4462-4515`). | Storage, freshness and Bridge API require only an addressable agent. Automatic/manual injection assumes a pane composer. | Keep the store and APIs. Deliver the recovery pointer through an ACP prompt/context facility when supported; otherwise surface that reinjection is unavailable. Do not infer protocol support ACP does not advertise. |

## Can one agent have both a pane and an ACP session?

**The runtimes do not impose mutual exclusion.** `t-2aabc0` measured ACP as a client-owned child
process and the native terminal as a tmux-owned process. Those two processes can exist concurrently,
and ACP can even list/load sessions written by the TUI (`docs/research/t-2aabc0-acp-viability.md:298-326`).
Nothing in ACP says that starting its child consumes a runtime-wide singleton.

**Tachyon's current agent identity does impose exclusivity.** One name maps to exactly one tmux
session (`AgentManager.ts:1081-1083`), one ledger row, one attention state and one worktree ownership
record. All live actions resolve that name to the pane. Starting an unrelated ACP child alongside it
would create two live conversations behind one name with no routing rule: `read_output`, `notify`,
Stop, readiness and continuity would still operate on only the pane. Calling that “the same agent with
two views” would be false.

Therefore the honest answer to the owner's UI choice is:

- **At runtime/process level:** both can coexist.
- **As one Tachyon fleet identity today:** no; terminal versus chat is exclusive because of our
  one-name/one-tmux-instance design, not because of ACP or the six runtimes.
- **Switching views on the same ongoing conversation:** not established. Shared native session stores
  prove load/replay for measured runtimes, not safe simultaneous control or universal handoff (and
  `pi-acp` lacks resume/fork). Until that is separately measured, creation-time transport choice is
  the honest v2 scope. Keeping both processes under one row would be a larger product decision.

## Honest cost of each path

These are engineering bands, not schedules; they separate the work that the source count actually
shows.

| path | cost band | why |
|---|---|---|
| Standalone ACP chat beside the fleet (v1 shape) | **small: roughly 3–6 focused production modules** | ACP client/process + webview/session persistence. It does not touch the 36 mechanism memberships, but it also does not satisfy “continues working with Tachyon mechanisms.” |
| Fleet agent chooses **terminal or ACP at creation** | **medium/large: roughly 8–12 production modules plus mechanism tests** | Introduce a live-instance boundary above concrete `TmuxService`; implement ACP lifecycle/output/input; adapt roster, Attention, communication, stop and continuity delivery. Durable board/worktree/doorbell/continuity stores are reusable. This is the smallest path that answers the owner's requirement honestly. |
| One fleet identity owns **pane and ACP simultaneously**, switchable at runtime | **large and ambiguous: 12–18+ modules, plus a new identity/routing contract** | It includes the previous path, then must define which instance receives input, which output is canonical, how stop/resume/continuity affect each, and whether two processes share one worktree safely. The source has no representation for this today, and ACP session-store interoperability does not answer simultaneous ownership. Do not choose this merely because the OS can run both processes. |

## Bottom line for the owner's decision

We **do** have the technical capacity, but not by putting a chat renderer over the current fleet
process. The reusable seam is the name-keyed durable half and, locally, `AttentionMonitorIO`; the
missing seam is a common live-instance transport above tmux. Creation-time exclusivity is the smaller
measured path. Simultaneous chat + terminal under one fleet name is not a runtime limitation, but it
is a materially larger identity and routing problem. Which path v2 should take remains the owner's
decision; this measurement does not choose or design it.
