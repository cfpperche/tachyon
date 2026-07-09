# 364 — bridge-client-rebind

_Created 2026-07-09._  
_Revised 2026-07-09 (fold: Codex design review `.tachyon/reviews/364-bridge-client-rebind-codex.md`)._  
_Revised 2026-07-09 (fold: Claude probe review `.tachyon/reviews/364-bridge-client-rebind-claude-probe.md`)._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred. -->

## Intent

Tachyon's moat includes agents that **outlive the editor**: tmux sessions survive a VS Code window
reload while the extension host, Bridge listener, and webviews come back. Spec 351 keeps per-agent
Bridge tokens valid across that boundary; spec 361 restores panels/tabs; host-action 359 reattaches
the reload transaction. **None of that rebinds the agent's in-process MCP client.**

Live dogfood (2026-07-09, Grok + Bridge): after window / `run_host_action("reloadWindow")` reload,
the Bridge host answered in ~5 ms and the agent token still authenticated, but **native MCP tool
calls from the surviving Grok process hung for minutes** (client-side session half-open). Manual
**stop → resume** cured it — new process, fresh MCP session, `withRuntimeBridge` re-injected. That
procedure is the correct remedy; today only a human (or a peer with a working MCP client) can run it.

"Done" (Phase 1) looks like: when a durable **bridge generation** advances, Tachyon marks surviving
**Tachyon-managed Bridge-wired** agents as suspect and, under the default policy, runs a governed
**graceful stop → observed dead → resume** rebind so orchestrators are not stranded on a silent MCP
hang. Detection **must not** depend on the hung agent calling a Bridge tool.

**Honest cost of default `auto`:** observed half-open clients do **not** self-heal via a successful
Bridge call. Phase 1 therefore treats generation bump as **restart-all wired survivors** (optional
short grace is a narrow escape hatch for rare healthy clients that call Bridge immediately — not the
primary recovery path). That interrupts in-flight turns; it is accepted for host-reload survival of
orchestration, not free.

---

## Product decisions (ratified)

| Decision | Choice | Tradeoff recorded |
|----------|--------|-------------------|
| Default policy on host generation bump | **`auto`** = rebind all still-suspect wired survivors after grace | Restarts the wired fleet on every reload; preserves unattended recovery after MCP hang. Alternative `notify` remains available. |
| Grace | **`graceMs: 0` default** (immediate queue after mark). Optional positive grace is an escape hatch only | Dogfood showed hung clients cannot clear within seconds; a decorative 3s grace is rejected. |
| Cold spawn as rebind fallback | **Forbidden** | Leave stopped + audit + human notify |
| Missing pre-364 `bound_generation` | Treat as **`0`** → suspect on first bump after upgrade | One-time fleet rebind of pre-364 survivors is intentional |
| Phase 2 peer tool | Authz boundary only; **no tool in Phase 1** | Avoids shipping a DoS primitive early |
| Naming | **bridge-client rebind** (MCP client health) | Distinct from Bridge HTTP bind/port |
| Multi-window same workspace | **Single Tachyon owner per workspace** for generation ownership; see §1 | No shared-counter multi-writer loop |
| 359 + rebind initiator | Pending `reloadWindow` MCP result is **lost** on rebind; inject post-resume notice | Prefer honest loss + note over fake tool completion |

---

## Core contracts

### 1. `bridge_generation` (durable, owner-scoped)

**Source of truth:** a monotonic integer persisted in host state keyed by
`(workspaceHash, bridgeOwnerId)`, where `bridgeOwnerId` is the stable id of the **owning** Tachyon
Bridge instance for that workspace (e.g. existing Bridge instance id / host_instance_id pattern from
351/359). **Not** bare workspace-only shared counter across concurrent windows.

**Single-owner rule:** only the Bridge owner that holds the live listener for that workspace may
increment the counter and run rebind. If a second Tachyon window attaches to the same workspace
without ownership, it **must not** bump the shared generation or auto-rebind agents wired to the
other owner (detect/refuse or no-op — plan picks fail-closed signal). Phase 1 assumes the normal
single-window dogfood topology; multi-owner is fail-closed, not “best effort dual rebind.”

**Semantics:**

- Starts at `1` if absent for that owner key.
- **At most one increment per listener-ready transition** within a single extension-host activation
  (activation A: Bridge becomes ready → +1 once). A later teardown-and-relisten in the **same**
  activation is a **new** listener-ready transition → may +1 again.
- Survives extension-host reload for that owner key.
- Compared against each agent’s durable **`bound_generation`** (see §2).

**Bump events (normative):**

1. Extension host / Workspace activates and this owner’s Bridge HTTP listener becomes ready
   (including after window reload).
2. **Any teardown-and-relisten** of this owner’s Bridge listener (same or different URL/port —
   crash-and-relisten on the same port counts).
3. Explicit Tachyon Bridge restart that tears down and re-listens (subset of 2).

**Non-bump events:** config hot-reload that does not restart the listener; `tools/list_changed`;
token mint/revoke without process restart; panel restore (361).

**No managed agents running:** generation still increments; empty suspect set.

### 2. Per-agent rebind state (**durable**)

**Normative durability:** `bound_generation` and Bridge-wiring evidence (`bridge_wired: true` or
equivalent) **MUST** be written into the **durable session ledger / session record** on every
successful Tachyon spawn and resume (same persistence class that already outlives reload for resume
ids). After extension-host reload, mark-suspect and predicate evaluation **read only durable
fields** — never pure in-memory maps that were wiped.

Ephemeral runtime fields (`client_state`, queue membership, `suspect_generation`) may be
reconstructed after activate from durable inputs + current generation:

- If durable `bound_generation < current G` and durable `bridge_wired` and session **running** →
  reconstruct `suspect` for G and schedule policy.
- If durable `bound_generation` **absent** (pre-364 survivors) → treat as **`0`**.

| Field | Durable? | Meaning |
|-------|----------|---------|
| `bound_generation` | **yes** (ledger) | Generation stamped at last successful Tachyon spawn/resume of this process |
| `bridge_wired` | **yes** (ledger) | Tachyon applied Bridge materialization on that spawn/resume |
| `client_state` | reconstructed | `ok` \| `suspect` \| `rebinding` \| `failed` \| `cancelled` |
| `suspect_generation` | reconstructed | Generation that caused current `suspect` |

**Transitions (Phase 1):**

```
on bridge_generation becomes G (owner):
  for each RUNNING agent A where durable bridge_wired(A)
    and durable_bound_generation(A) < G:   // absent ⇒ 0
      if A.client_state == rebinding:
        // do NOT start a second rebind; in-flight continues (see completion rule)
        record pending_recheck = true for A
      else:
        A.client_state = suspect
        A.suspect_generation = G
        enqueue rebind policy for A

on user stop of A while suspect|queued:
  remove A from rebind queue permanently for that suspect_generation
  A.client_state = cancelled   // must NOT resume

on successful Bridge tool call authenticated as agent A
  (resolved caller kind=agent, name=A, current generation G)
  while A.client_state == suspect and A.suspect_generation == G:
      A.client_state = ok
      remove A from rebind queue for G

on rebind START preflight for A (normative — all must hold):
  A still RUNNING
  A.client_state == suspect
  durable_bound_generation(A) < current G   // manual resume already stamped G ⇒ skip
  else: abort start, dequeue, do not stop/resume

on rebind start (preflight ok):
  A.client_state = rebinding
  // at most ONE in-flight rebind per agent process lifetime until completion
  // a newer G while rebinding sets pending_recheck only

on rebind success:
  stamp durable bound_generation := current bridge_generation AT RESUME TIME (not the old suspect G)
  durable bridge_wired := true
  A.client_state = ok
  if pending_recheck and bound_generation < current G: re-enter mark-suspect once
  else clear pending_recheck

on rebind failure:
  A.client_state = failed
  // agent left STOPPED; human notify; no cold spawn
```

### 3. Predicate: Tachyon Bridge-wired

An agent **is** a rebind candidate only if **all** hold:

1. Managed **agent** (not terminal-kind).
2. **Running** at evaluation time (**bump mark** and again at **rebind-start preflight**).
3. Durable **`bridge_wired`** from last Tachyon spawn/resume materialization:
   - Claude/non-harness: `withRuntimeBridge` / `materializeBridgeMcp`
   - OpenCode: `materializeBridgeMcpOpencode` or harness Bridge fold
   - Grok: `materializeBridgeMcpGrok` or harness Grok Bridge fold
   - Codex when Bridge-wired the same way
4. Self-managed / user-only MCP without Tachyon materialization → **not** wired.

Plan names the exact ledger field; the **existence** of durable stamp is required by this spec, not
deferred.

### 4. Stop → resume lifecycle (normative)

1. **Expected-rebind death class** — intentional teardown is not an unexpected crash (parent pokes /
   crash UX suppressed or classified). Plan names the hook.
2. **`stopGracefully(name)`**.
3. Wait until session **dead** or `stopTimeoutMs`.
4. If still alive: **hard stop**, wait dead (or fail rebind). Hard kill mid-turn is an accepted path
   when the hung client ignores graceful keys; resume must still resolve conversation target via
   existing ledger/ownership rules (209/212/244). If resume target is corrupt after hard kill →
   **failed** path (stopped + audit), not cold spawn.
5. **`resume(name, record)`** — same target resolution as sidebar Resume. **No cold spawn.**
6. On success: stamp durable `bound_generation = current bridge_generation` (at resume time),
   `bridge_wired = true`, `client_state = ok`; apply `pending_recheck` rule.
7. On failure: stopped, `failed`, audit + human notify.

### 5. Policy

```yaml
settings:
  bridgeClientRebind:
    onHostGenerationBump: auto   # auto | notify | off
    graceMs: 0                   # default 0; optional >0 escape hatch only
    stopTimeoutMs: 15000
    maxConcurrentRebinds: 1
    circuitFailCount: 3          # stop auto queue after N failures in one generation
```

| Value | Behavior |
|-------|----------|
| **`auto` (default)** | Enqueue rebind for every still-`suspect` wired agent; after `graceMs` (0 = immediate), run queue under fleet budget. **Effect under dogfood reality: restart-all wired survivors on each bump.** |
| `notify` | Mark/reconstruct suspect + human signal; no stop/resume until human or Phase 2 |
| `off` | No 364 mark/act on generation bumps |

**Grace clear** (only if `graceMs > 0`): authenticated **self** agent token call against current
generation removes from queue. Legacy/master/external/peer calls never clear.

**Queue removal:** leaving `suspect` for any reason (grace clear, preflight skip, user stop →
`cancelled`, success, failure) **removes** the agent from the rebind queue.

### 6. Fleet controls

- **One in-flight rebind per agent** until completion (no parallel rebind for G and G+1).
- **`maxConcurrentRebinds: 1`** fleet-wide queue (FIFO).
- **Order:** non-initiators first; **reload initiator last** if known; else stable name sort.
- **Circuit:** after `circuitFailCount` (default **3**) failures in one generation, stop draining the
  auto queue for that generation and notify human; remaining suspects stay `suspect`/`cancelled`
  without further auto attempts.
- Queued agents that clear/cancel are not restarted.

### 7. Audit

Durable append-only lifecycle log (path: plan — globalStorage or `.tachyon/`). Each attempt:

- agent, reason (`host_generation_bump` | `peer_request` | …)
- `from_generation`, `to_generation` (stamp at completion)
- phases: preflight / stop / dead / hard_kill? / resume ok|fail / final state
- error string if any

Failure → human-visible notify; success toast optional.

### 8. Interaction with 351 / 359 / 361 / list_changed

| Sibling | Interaction |
|---------|-------------|
| **351** | Valid token ≠ healthy MCP client. Resume still mints fresh agent token as today. |
| **359** | Bridge ready → reload transaction recovery as today → **then** generation bump + rebind queue. **Composition with initiator rebind:** the pending MCP `run_host_action("reloadWindow")` result held by the old process is **normatively lost** when that process is rebound. Phase 1 **must** inject a short post-resume notice into the initiator pane (same class as a system nudge / brief line — not a forged tool result) stating that the host reload completed and the Bridge client was rebound. 359 audit/outcome on the host remains the source of truth for reload success. |
| **361** | Phase 1 requires post-rebind terminal attachment to the **new** session. **Dependency:** if existing stop→resume already reopens/reattaches the managed terminal tab to the new tmux session (current Tachyon terminal open path), 364 only needs a regression test. If not, Phase 1 includes the minimal reattach fix (same module that opens agent terminals today) — owned by 364 implementation, not a silent 361 re-open. |
| **list_changed** | Never proof of client health; never substitute for rebind. |

---

## Acceptance criteria

### Phase 1 — host-driven rebind (MVP)

- [ ] **Scenario: generation bump after reload rebinds a wired survivor**
  - **Given** a Tachyon Bridge-wired agent is running with durable `bridge_wired` + `bound_generation`
  - **When** the window reloads, Bridge becomes ready, and owner `bridge_generation` increments
  - **Then** the agent is reconstructed as `suspect` and under default `auto` is stop→resume rebound
    so a Bridge tool call from the **new** process succeeds without a human stop/resume
- [ ] **Scenario: durable stamps survive reload**
  - **Given** spawn/resume wrote `bound_generation` and `bridge_wired` to the ledger
  - **When** the extension host reloads (in-memory state wiped)
  - **Then** mark-suspect and the wired predicate still evaluate correctly from durable fields
- [ ] **Scenario: pre-364 missing bound_generation**
  - **Given** a running wired agent with no `bound_generation` field
  - **When** generation bumps
  - **Then** it is treated as bound `0` and becomes suspect (upgrade rebind)
- [ ] **Scenario: bound_generation stamps current generation at resume time**
  - **Given** rebind completes successfully when current generation is G'
  - **When** the new process is up
  - **Then** durable `bound_generation == G'` and `client_state` is `ok`
- [ ] **Scenario: double bump while rebinding**
  - **Given** agent A is `rebinding` for generation G
  - **When** generation becomes G+1 before completion
  - **Then** no second concurrent rebind starts; on success A stamps G+1 (or current at resume) and
    re-evaluates suspicion at most once via `pending_recheck`
- [ ] **Scenario: resume preserves conversation target**
  - **Given** adapter-backed resume metadata (sidebar Resume rules)
  - **When** rebind runs (including after hard-kill path)
  - **Then** Tachyon calls **resume**, not cold spawn; target matches sidebar Resume rules when
    resolvable; otherwise failed/stopped without cold spawn
- [ ] **Scenario: rebind-start preflight — user stopped during queue**
  - **Given** agent A is `suspect`/queued and the user stops A before rebind starts
  - **When** the coordinator would start A’s rebind
  - **Then** preflight fails; A is **not** resumed; state `cancelled` for that generation
- [ ] **Scenario: rebind-start preflight — manual resume already healed**
  - **Given** A was suspect and a human (or sidebar) resume already stamped `bound_generation` to current G
  - **When** the coordinator reaches A in the queue
  - **Then** preflight skips; A is not stop/resumed again for G
- [ ] **Scenario: grace clear by authenticated self only** (when graceMs > 0)
  - **Given** A is suspect for G within grace
  - **When** a Bridge call is authenticated as A against G
  - **Then** A is ok and dequeued; legacy/master/external/B do not clear
- [ ] **Scenario: non-wired and non-running skipped at mark**
  - **Given** terminal-kind, stopped, or not durable-wired
  - **When** generation bumps
  - **Then** 364 does not enqueue stop/resume
- [ ] **Scenario: resume failure — no cold spawn**
  - **Given** resume unavailable or fails
  - **Then** agent stopped, `failed`, audit + notify, no cold spawn
- [ ] **Scenario: expected-death during rebind**
  - **When** rebind stops A
  - **Then** teardown is not treated as unexpected crash
- [ ] **Scenario: policy off**
  - **Given** `onHostGenerationBump: off`
  - **When** generation bumps
  - **Then** no auto stop/resume
- [ ] **Scenario: fleet serialization + circuit**
  - **Given** multiple suspects and `maxConcurrentRebinds: 1`
  - **Then** at most one rebind runs at a time; after `circuitFailCount` failures auto queue stops
    for that generation
- [ ] **Scenario: 359 initiator composition**
  - **Given** agent O called `run_host_action("reloadWindow")` and is later rebound
  - **When** rebind completes
  - **Then** no forged MCP tool result is delivered for the old call; O receives a post-resume
    notice that reload completed and the Bridge client was rebound; host-side 359 audit remains valid
- [ ] **Scenario: terminal attachment after rebind**
  - **Given** a managed terminal tab for agent A
  - **When** rebind completes
  - **Then** the tab tracks the **post-resume** session (regression against open/reattach path)
- [ ] **Scenario: audit trail**
  - **Given** a rebind attempt
  - **Then** durable audit has agent, generations, reason, phases, outcome
- [ ] Unit tests: durable stamp + reload reconstruct; absent=0; preflight user-stop and manual-heal;
      double-bump pending_recheck; stamp-at-resume-time; queue removal; circuit N=3; 359 notice hook;
      skip non-wired.
- [ ] **Dogfood / integration:** generation bump + wired rebind (headless minimum); live Grok
      post-reload “tools work again” is maintainer gate.
- [ ] **Visual QA Opt-Out (Phase 1):** no new primary UI (toast/notify optional).

### Phase 2 — peer rebind (deferred code; contract)

- [ ] Peer tool uses the same coordinator; 351-resolved caller.
- [ ] Authz default deny: **self** / **parent→child** / **explicit grant** only — matrix in plan when
      Phase 2 starts. **Not in Phase 1 ship.**
- [ ] Hung agent never relies on self-report alone (Phase 1 host path remains).

### Cross-cutting

- [ ] Naming distinguishes bridge-client rebind vs HTTP bind vs `list_changed`.
- [ ] Documented: valid 351 token ≠ healthy MCP client.
- [ ] Documented: default `auto` ≈ restart-all wired survivors on bump (grace not the recovery path).

---

## Non-goals

- Soft MCP reconnect inside a live CLI without process restart.
- Hang-duration heuristics for long business tools as rebind triggers.
- Rebinding third-party MCP servers outside `tachyon_bridge`.
- Replacing resume ownership / ledger rules — rebind **calls** resume.
- Default hard-kill without graceful attempt first.
- Zero interruption of in-flight turns on generation bump.
- Multi-window dual-owner active-active rebind (fail-closed single owner).
- Phase 2 tool in the Phase 1 ship.
- Preserving in-flight MCP tool results across rebind (including 359 initiator call).

---

## Open questions (remaining)

1. Exact durable audit file path — _plan_.
2. Exact `bridgeOwnerId` field reuse (existing instance id keys) — _plan, grounded in 351/359 code_.
3. `notify` policy UX (chip vs toast) — _plan; non-blocking_.
4. Phase 2 allow-matrix detail — _deferred_.

---

## Sources

Live dogfood 2026-07-09 · Codex review `.tachyon/reviews/364-bridge-client-rebind-codex.md` ·
Claude probe `.tachyon/reviews/364-bridge-client-rebind-claude-probe.md` · parity.md Grok Bridge ·
351 / resumeTokenProof · 359 · 361 · t-2d3580 · AgentManager stopGracefully/resume/withRuntimeBridge ·
materializeBridgeMcp* / harness Bridge fold.
