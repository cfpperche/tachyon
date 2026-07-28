# SDD 480 — Execution Graph

**Status:** **CLOSED** (2026-07-28). All five phases delivered, dogfooded against real operating-system
objects, and verified. The closure evidence — what was proven and on what — is in `plan.md` § Closure.
Phase 1 was ratified by the human on 2026-07-27 and the contract below is what shipped.

**Tasks:** `t-5e6822` (spec) → `t-28da05` (identity + ledger) → `t-2f69de` (projection) →
`t-559857` (canvas + table) → `t-d2bb2f` (dogfood + closure).
**Prerequisite findings:** `t-05097f`, `t-41f496`, `t-6ebdc8`, `t-9598cc`.
**Open follow-ups, none blocking:** `t-ca9579` (no runtime supplies a turn-id alias yet),
`t-7ba92a` (the live engine predates the wiring, so the section reads `no-telemetry` until it
restarts), `t-441b0f` (host does not yet supply `detailFor`), `t-d5066b` (settled: plugin/external
tool is not a seam), `t-62cc44` (move the control-byte guard earlier in the verify pipeline).

**What the closing dogfood actually measured**, because it is the one claim everything else rests on:
a child process whose launcher had exited was reparented to **systemd (PPID 2270)** — its parent
pointer now a lie about its origin — and it was STILL attributable, because `/proc/<pid>/environ`
carried the id it was born holding. PPID is a fact about now; the carried id is a fact about origin.

---

## 1. What this is for

An operator watching a fleet cannot currently answer three ordinary questions:

- what is this agent actually running right now, and what did that come from?
- when a turn ended, did anything survive it?
- who owns this process — and is that ownership *proven* or guessed?

The Execution Graph answers them from record, per agent: session → turn → tool call → execution,
across local processes, tmux sessions, systemd units, internal operations and MCP calls.

## 2. The one rule everything else follows

**Attribution is either proven or declared unproven. It is never inferred silently.**

This is not a stylistic preference; it is what the measurements below force. Two of them:

- **PID/PPID does not identify anything.** Measured 2026-07-27 (`t-41f496`): 73 `gsettings monitor`
  processes, every one with PPID 2270 (`systemd --user`), reparented because their launcher died.
  Attribution by PPID would have said "these belong to systemd". On a machine running a fleet,
  `orphaned` is not an edge case — it was 61% of one resource ceiling.
- **A live process is not a working agent.** Measured 2026-07-27 (`t-0d689f`): the Bridge reported
  `attention: idle` while the UI drew the same green it uses for agents producing output. Liveness
  and activity are different facts and must stay different fields.

The precedent for the rule already exists in this repository: SDD 477 (`authRequired`) treats the
absence of a measured signal as a *declaration* that the runtime cannot be classified, rather than
as licence to guess. This spec adopts the same discipline.

## 3. Inventory of existing seams (measured, not assumed)

### 3.1 Where executions are born

| Seam | File | What it creates | Correlation available today |
|---|---|---|---|
| Agent spawn / restart / resume / fork | `src/agents/AgentManager.ts` | tmux session, runtime process | agent name, session name, worktree, ledger row |
| Engine daemon | `src/engine-service/engineSupervisor.ts` | systemd unit, control socket | `engineWorkspaceKey` → unit + socket + state dir |
| Bridge one-shot command | `src/bridge/tools.ts` (`run_command`) | tmux session `tachyon-cmd-<hash>-<name>` | caller identity, command name |
| Governed host action | `src/bridge/tools.ts` (`run_host_action`) | host process | `caller: CallerSnapshot` — already resolved, never a tool param |
| Control-mode anchor | `src/tmux/ControlModeClient.ts` | `tachyon-ctl-<wsHash>` | wsHash, socket |
| Turn submission | `src/agents/agentInputService.ts` | a `Turn` (§7.1) | agent, session; runtime turn id as alias only |

Five seams, not six. An earlier draft of this table listed **`src/plugins/externalTool.ts` /
`toolPlatform.ts`** as a sixth, creating "browser, desktop, screen processes". It does not, and
§3.1.1 records why — the row was removed rather than left to promise something the graph cannot
deliver.

#### 3.1.1 Why plugin / external tool is NOT a seam (t-d5066b)

Measured while wiring the other five, and recorded here because the table read plausibly enough that
two people could believe it twice.

`externalTool.ts` starts nothing. Its own header says *"no privileged exec here"*: it RESOLVES a
trusted absolute path and shape-checks install argv, and its only `execFileSync` calls are detection
probes (`command -v`). Its sole caller in the entire source tree is `src/externalResolverEntry.ts`,
the entry for the standalone `_tachyon-external` shim — which runs as a separate, short-lived process
launched by the plugin's own CLI, not inside the extension host. The browser, desktop and screen
processes are then started by that plugin CLI, outside Tachyon entirely. Tachyon hands over a path
and leaves. (The `user_browser_*` Bridge tools are not a back door either: they delegate to the
companion extension and spawn nothing.)

So there is no child of ours to hand an environment to, and no in-process sink for the shim to reach.

**Three options were considered. The decision is (a).**

- **(a) — out of scope, chosen.** Tachyon does not originate these executions, so the graph does not
  contain them. That is a real boundary, and stating it is better than a row that implies coverage.
- **(b) — have the shim write to the ledger directly. REJECTED, and the reason is measured, not
  aesthetic.** The shim can derive the ledger path (`engineStorageRoot` is a pure function of the
  workspace root), so this looks feasible — but `EngineEventJournal` is **single-writer by
  construction**. `append` computes `seq` from its own in-memory tail, so a shim writing beside a live
  engine daemon produces duplicate sequence numbers, and the next open throws
  `engine event journal sequence is not contiguous`. The whole journal becomes unreadable. Option (b)
  would corrupt the graph it was meant to extend. `test/unit/executionLedgerSingleWriter.test.ts`
  pins that invariant so this cannot be re-attempted by accident.
- **(c) — have plugins carry `TACHYON_EXECUTION_ID` into the processes they launch.** The only option
  that would actually capture those processes, because only the plugin is present at the spawn. It is
  a change to the plugin contract, not to this infrastructure, and belongs to whoever owns that
  contract. Recorded as the path forward if these processes are ever wanted in the graph.

##### Recording the RESOLUTION instead of the process — also rejected

The tempting middle path: don't claim the process, but record "plugin X resolved tool Y" as an
`unproven` `InternalOperation`. It was evaluated on its own merits and rejected, and the deciding
reason is structural rather than a matter of taste.

**The shim cannot say whose resolution it was.** `runExternalResolver(argv, { workspaceRoot })`
receives exactly `<plugin> <name>` — there is no agent, no session, no turn, and no tool call in
scope, because the plugin CLI invoked it directly and nothing upstream passed an identity down.

So such a record would be **unattributable and orphaned in both directions**: no parent, because the
agent reached the plugin through its own runtime rather than through a Bridge call, so there is no
`InternalOperation` above it to attach to; and no child, because the process it leads to is not ours.
It would be a node hanging in the graph, credited to nobody, adjacent to nothing.

That is worse than the gap it fills. §5 rules out a graph that draws a confident wrong parent; a node
that implies coverage of browser/desktop/screen while connecting to neither the agent that caused it
nor the process it produced is the same failure wearing an `unproven` label. And it would still need
new machinery to write at all — a spool the engine ingests — since the ledger is single-writer.

"A plugin asked for a path" is not an execution. A graph that admits its edge is more trustworthy than
one padded with near-misses.

### 3.2 What already correlates

- **`engineWorkspaceKey`** (`engineSupervisor.ts`) is the single identity from which the control
  socket, state dir and systemd unit all derive. `t-05097f` extended it to carry tmux isolation, and
  that shape — *one identity, not three places that each remember what it means* — is the shape
  `SystemdUnit` needs. Do not re-derive unit names by hand: `t-05097f` found a second derivation in
  `extension.ts` doing exactly that, and `t-6ebdc8` found the same anti-pattern in the sidebar.
- **tmux sessions need the socket, not just the name.** `resolveSocketName(env)` exists precisely
  because two servers can hold identically-named sessions — that ambiguity is what confused the
  editor gate for an entire investigation. `TmuxSession` carries `{ socket, session }` or it carries
  nothing trustworthy.
- **`externalTool` already ships a `confidence` field.** The graph should adopt that vocabulary
  rather than invent a parallel one.

### 3.3 What to reuse instead of building

| Need | Existing primitive |
|---|---|
| Append-only event log | `EngineEventJournal` (`src/engine-service/eventJournal.ts`) — `schemaVersion`, `append(kind, payload, at)`, `0o600` |
| Secret redaction | `redactSecrets` (`src/bridge/redact.ts`) |
| Control-character safety | `containsUnsafeFramingCharacter` (`src/config/framingSafety.ts`) |
| Per-entity journal shape | `TaskJournalStore`, `SessionLedger`, `RunLedger` |

### 3.4 Measured gaps

1. **No turn or tool-call identity exists.** `episodeKey` (AttentionMonitor) changes on pane output
   and is the closest thing, but it is a UI-refresh token, not a turn id. `turnId` and `toolCallId`
   have to be introduced.
2. **No execution id crosses the Bridge.** `run_command` and `run_host_action` know their caller but
   emit nothing an observer can later join on.
3. **Nothing records exit.** `AgentManager` knows about dead panes; no seam writes an `exit` event
   with code and time to a durable log.
4. **Sharing is unrepresentable.** A daemon serving two workspaces is, today, either "owned" by
   whichever asked last or invisible.

## 4. Contract

### 4.1 Identity

Five ids, propagated, never re-derived: `agentId`, `sessionId`, `turnId`, `toolCallId`, `executionId`.

`executionId` is minted by Tachyon **at the moment of spawn, before the child exists**, and carried
into the child's environment. This is what survives reparenting: the process may lose its parent, but
it cannot lose an id it was born holding. Where a runtime forbids environment injection, the
execution is recorded `unproven` rather than guessed.

### 4.2 Nodes and edges

Nodes: `Agent`, `Session`, `Turn`, `ToolCall`, `Process`, `TmuxSession`, `SystemdUnit`, `McpCall`,
`InternalOperation`.

Edges: `spawned`, `invoked`, `attached`, `reparented`, `reused`/`shared`, `completed`, `outlived`.

`shared` is not a weaker `spawned`. A shared daemon has an edge to **every** agent using it and is
owned exclusively by none — the graph must be able to say "this is not yours alone".

### 4.3 State and provenance

States: `running`, `waiting-input`, `completed`, `failed`, `killed`, `orphaned`, `shared`, `unproven`.

Every state carries *how it was established*: `measured` (observed by Tachyon), `declared` (asserted
by a runtime that Tachyon trusts for this fact), or `unproven`. A consumer may never treat `unproven`
as any other state — including for aggregate counts, where silently dropping unproven rows would make
a partial graph look complete.

### 4.4 Boundaries stated, not faked

A remote MCP call produces one `McpCall` node whose boundary is explicit. Tachyon does **not**
fabricate the processes on the far side. "We cannot see past here" is a fact worth rendering; an
invented subtree is a lie that costs an operator a debugging session.

### 4.5 Safety

- Command, args and env pass `redactSecrets` **before** persistence, never after. Prefer a digest
  over a raw value wherever the value's identity matters more than its content — `t-9598cc` recorded
  digests even in a temporary diagnostic, and that was the right call.
- The ledger is bounded from V1, not later. This machine has already produced `ENOSPC` on a shared
  7.9 GB `/tmp` mid-suite and exhausted a 128-instance inotify ceiling. An unbounded per-agent
  append-only log on this host is a known failure, not a hypothetical one.
- V1 is **read-only**. No kill-subtree, no cleanup action. Any destructive affordance arrives later
  and through governed approval.

## 5. Phases and their gates

| Phase | Deliverable | Gate |
|---|---|---|
| 1 | This spec + inventory | **Ratification.** No code. |
| 2 | Schema, ledger, id propagation | Sanitization and lifecycle tests; no UI until provenance is trustworthy |
| 3 | Per-agent projection / read API | shared, orphaned and unproven all representable |
| 4 | Canvas + accessible table | Real data plus heavy fixtures; loading/empty/error states |
| 5 | Dogfood | Reparented processes, tmux, systemd, MCP, cleanup; parity matrix if a runtime-visible contract moves |

Phase 2 is deliberately gated on provenance rather than on schedule: a graph that renders a confident
wrong parent is worse than no graph, because it will be believed.

## 6. Ratified decisions (human, 2026-07-27)

The three questions this spec opened are answered. They are recorded here as decisions, not as
options, because later phases depend on them.

### 7.1 Turn identity — Tachyon mints it

`turnId` is minted by **Tachyon at input submission**. A runtime that exposes its own turn id
contributes that id as **evidence or alias**, never as authority.

This is the only answer consistent with §2. A runtime-owned id is unavailable for runtimes that do
not expose one, differs in meaning between those that do, and cannot be minted before the turn
exists — so building on it would make turn identity a per-runtime accident. Minting our own makes
`turnId` exist for every runtime on the same terms, and reduces native ids to what they actually
are: corroboration. The parity matrix records which runtimes supply an alias.

### 7.2 Retention — bytes first, age second

The **primary limit is bytes per agent**; age-based cleanup is a complement, not the main control.

Bytes is the limit that actually failed on this host — `ENOSPC` on a shared 7.9 GB `/tmp` took down a
whole suite mid-run. An age policy alone cannot bound a burst, and an event-count policy prices every
event the same when a redacted argv and a one-line exit differ by orders of magnitude. Age still
earns its place: it retires quiet agents that would otherwise hold their share indefinitely.

### 7.3 InternalOperation — every Bridge call

**Every Bridge tool call becomes an `InternalOperation`**, carrying sanitized metadata. Process-level
detail is attached **only where it is observable and proven**; where it is not, the operation stands
alone rather than growing an invented subtree.

This is the honest reading of "everything an agent executes": a Bridge call that mutates a task or
writes a handoff *is* execution, and omitting it would leave the graph confidently incomplete. It is
also the decision that meets the volume ceiling first, which is why §7.2 binds bytes rather than
counts — the two answers were chosen together.

## 7. Explicitly out of scope for V1

- **eBPF.** Optional enrichment later; never a V1 requirement. Everything above is achievable with
  correlation Tachyon already controls plus host observation it already performs.
- Destructive actions of any kind, including kill-subtree.
- Cross-host execution beyond stating the MCP boundary.
