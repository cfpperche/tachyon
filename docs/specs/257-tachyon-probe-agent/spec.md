# Spec 257 — Probe agent (a captured, headless A2A lane)

**Status:** shipped
**Closure:** Released as 0.40.0; commit `6af22817` records both reviews folded and live validation of claude→codex and claude→claude probes.

> **Origin.** Tachyon has exactly **one** way to run an agent: a real CLI driving its interactive TUI inside a tmux pane, observed by *scraping the pane*. That lane is the product's identity — you watch your agents, intervene, reanchor. But a large class of agent-to-agent work is **not** a persistent visible teammate: it is a bounded question — "review this diff", "is this claim true", "give a second-model opinion" — whose value is a **clean, captured answer handed back to the caller**, not a pane to babysit. Today the only way to get that answer is `spawn_agent` → `wait_for_agent(idle)` → `read_output`, which returns a **scrape of terminal chrome**, asynchronously, with no structured result, no exit semantics, and no provenance. This spec adds the missing second lane.

## Problem

The Bridge's A2A surface is built entirely around the **persistent-pane** model:

- `spawn_agent` starts a CLI in a tmux pane and returns immediately (the agent is now *running*, not *done*).
- `wait_for_agent` polls a coarse lifecycle state (`idle` / `needs-input` / `dead`) — there is no server→agent push, so the caller pulls.
- `read_output` returns **the visible pane** (or N lines of scrollback): raw TUI text — spinners, box-drawing, prompt chrome — not the model's final message.

This is correct for a teammate you watch. It is the **wrong shape** for a bounded probe, and it makes three things fragile:

1. **Duets** — an agent (or the model orchestrating the workspace) asking a second runtime for a critique gets back a terminal scrape it must parse, over multiple poll turns, instead of a clean final answer.
2. **AI steps in pipelines/runbooks** — `src/pipeline/loadPipeline.ts` already supports a `cmd:` one-shot node (`exit` / `exit_then_verify`), but that captures an **exit code from a shell command**, not the **structured result of an AI turn**. A pipeline step whose job is "ask a model and branch on the answer" has no clean value to branch on.
3. **Verify / judge** — `verify_agent` and any LLM-as-judge pattern want a structured verdict; a pane scrape is a poor substrate for a decision.

**The real shape of the missing primitive.** The naïve framing — "just capture the model's clean final message" — is wrong, and the probe review made that the headline correction: the primitive is **process lifecycle + a normalized failure taxonomy + caller policy + artifact provenance**. A probe that only models "happy answer + exit code" leaks exactly where implementation breaks: a runtime exits non-zero with an *error result in its output* (budget, refusal, max-turns) that is NOT a crash; a Tachyon kill-timeout is NOT a model refusal; real CLIs pollute stdout with login/update/MCP-startup noise even when the answer file is clean; one agent making *another* runtime spend budget / read files / ingest injected content is a new attack surface. The decisions below are built around that taxonomy, not around the happy path.

## Goal

A first-class **captured, headless probe** lane, additive to (never replacing) the persistent-pane lane:

- A bounded headless run of a chosen runtime that returns a **stable envelope** — `{ runId, status, result? }` — on **every** call, never a sometimes-result/sometimes-id shape. `result`, when present, carries a **Tachyon-owned termination taxonomy** (not a runtime-specific subtype) plus the clean final message and cost.
- The run is one **kind** of a single internal `AgentRun` resource shared with the pane lane (same runId, storage, cancellation, observability) — so the two lanes don't fork the engine.
- The probe is **observable from the run ledger**: a transient row renders from ledger state; the captured result is inspectable by `runId` after exit. The ledger is the source of truth, not the UI.
- The caller frames the probe with a **structured brief + an output contract**, selectable by **archetype** — so the right framing (e.g. an adversarial-review's anti-bias guard) and a forcing output schema come from the chosen archetype, not from the caller remembering to hand-write them.
- Per-runtime specifics live in **adapters**, reusing the pattern established for MCP registration ([`src/registration/adapters.ts`](../../../src/registration/adapters.ts)), plugin materialization (`src/plugins/adapters/`), and session resume (`src/resume/adapters.ts`). A runtime with no usable non-interactive mode is **honestly refused**, never faked.

Downstream, the same captured result becomes the clean input that makes **AI pipeline steps** and **verify/judge** robust — phase 2; the MVP is the A2A/duet primitive.

## Prior art (CLI non-interactive modes — capability-probed, not flag-frozen)

Each runtime offers a documented headless mode that emits a structured final message and a meaningful exit status. The adapter encapsulates the exact invocation; the spec records the **shape**, and the adapter **discovers capability + runs a compatibility check** at runtime (recording binary + adapter + schema versions) — because "pin the flags at plan time" does not survive a CLI upgrade that changes JSON fields, exit codes, or sandbox defaults.

| Runtime | Non-interactive entry | Clean final message | Machine-readable stream | Bound / cost | Native error signalling |
|---|---|---|---|---|---|
| **claude** | print/headless mode (`-p`) | JSON output format carrying the final result | streaming JSON event format | budget cap flag; cost reported in the result | a structured error *result* (e.g. budget reached) distinct from a process crash |
| **codex** | `exec` subcommand | last-message captured to a file | JSON event log (`--json`) | wall-clock via the caller; sandbox flag | non-zero exit + last-message content |

> **The capture mechanics differ per runtime; the *normalized result* does not.** Each adapter maps its runtime's native signalling into Tachyon's own termination taxonomy (D4). The neutral layer never carries a runtime-shaped field like a Claude `subtype` — those live under `native`. And the adapter reads **Tachyon-owned artifact files** the runtime writes (the result file, the event log), not the raw stdout/stderr channels, which carry login warnings, update notices, MCP-startup logs, and node warnings even on success.

## Proposed decisions (probe-reviewed)

- **D1 — Two lanes, ONE internal run model.** `spawn_agent` (persistent pane) and the probe are two `kind`s of a single internal `AgentRun` resource: `kind: pane | probe`, always minting a `runId`, sharing storage, cancellation, and ledger observability. The probe is the **bounded, captured** kind; the pane is the **persistent, watched** kind. Neither is deprecated. *(This dissolves the original "separate primitive vs mode flag" false binary: unify the internals, then decide the surface separately — D2.)*
- **D2 — A thin `probe_agent` Bridge tool, a façade over the shared run.** The MCP surface is a **distinct tool** (not a `mode:` flag on `spawn_agent`) because the **return contract genuinely differs** — `spawn_agent` returns "started", `probe_agent` returns a result envelope. But it is a thin façade over the shared `AgentRun`, never a parallel implementation.
- **D3 — One stable result envelope on every call.** Every `probe_agent` call returns `{ runId, status, result? }`, `status ∈ {completed, running, failed}`, `result` present iff `completed`/`failed` with a captured outcome. The caller chooses `wait: sync | async` **explicitly**; a sync call may still time out into `status: running` + a `runId` to poll — but the **shape is always the same**, never a surprising "sometimes a result, sometimes an id." *(Resolves the original leaky auto-fallback.)*
- **D4 — A Tachyon-owned termination taxonomy.** `result` carries a normalized `terminationReason ∈ { ok, model_error, refused, budget, timeout, killed_signal, process_error, parse_error, empty_output }`, a nullable `exitCode`, an optional `signal`, `timedOut`, the clean `lastMessage`, `costUsd?`, and a `native` bag for runtime-specific fields (e.g. a Claude result `subtype`). **No runtime-shaped field at the neutral layer.** A Tachyon kill-timeout, a process crash, a signal kill, an adapter parse failure, an auth failure, a model refusal, and a budget result are **distinct reasons**, never collapsed into one boolean.
- **D5 — Per-runtime adapter capability with discovery + compat probe.** Each adapter declares: the non-interactive invocation, how to read the Tachyon-owned result/event artifacts, and how to map native signalling → the D4 taxonomy. **Capability discovery + a compatibility check + recorded binary/adapter/schema versions are acceptance gates**, not a "pin flags later" footnote. A runtime that diverges (no clean result file, no usable exit semantics) is refused with a clear reason.
- **D6 — Engine-managed subprocess execution; tmux is an optional debug mirror.** A probe runs as an **engine-managed subprocess** with ledger-backed observability, NOT headless-inside-a-tmux-pane (which adds tmux's TTY/buffering/signal quirks while the pane is not the source of truth). tmux may *optionally* mirror a running probe for live inspection, but it is never the execution substrate.
- **D7 — Structured brief + output contract, selectable by archetype.** A probe takes `task / context / constraints` + an **output contract**; it ships with **archetypes** that carry the framing AND a forcing output schema: `adversarial-review` (the anti-bias "disagree, find what's wrong" guard + a findings schema with severity/target/fix), `factual-verify` (an anti-fabrication "cite, separate verified from unverified" guard + a claims schema). Freeform is an **escape hatch**, not the default. *(The anti-bias guard becomes a property of the archetype — not something the caller must remember to write. Start with two archetypes; add more by demand, never a speculative catalog.)*
- **D8 — Least-privilege default + a caller-authorization model.** The probe defaults to the most restrictive per-runtime sandbox that still reads the repo (escalation opt-in). **Plus** a Tachyon-side check: a probe lets one agent spend *another* runtime's budget, read files, invoke tools, and ingest injected content — so the design carries caller authorization, budget ownership, an allowed-runtime policy, and a per-probe capability declaration. Cross-runtime A2A is a real attack surface, treated as one.
- **D9 — Observable from the ledger; payload-size disciplined.** Ship the run **ledger + `read_probe_result(runId)` first**; the sidebar row and inspector render FROM that state (UI is never the proof of lifecycle correctness). Large artifacts (`events`, oversized `lastMessage`) are stored by path/id with truncation flags; the inline envelope returns a summary — an unbounded event stream must never be able to overflow an MCP payload and take down the Bridge.
- **D10 — Scope: two runtimes, duet-first. (RATIFIED)** MVP ships **both** claude + codex adapters (the cross-runtime duet is the headline value — a single-runtime MVP proves capture but not the thesis); it **defers** UI polish and budget-polish, NOT the second adapter; it **cuts resume** (→ a future stateful `probe_session`). Primary consumer = the **A2A/duet caller**; pipelines + verify/judge are phase-2 consumers. *(Maintainer-ratified: two-runtime scope + duet-first ordering both confirmed.)*

## Resolved questions (maintainer-ratified)

- **OQ1 — Sync cap + async handoff → RESOLVED.** `wait: sync` is the default; it holds up to a cap (default **120s**, configurable, hard ceiling **~240s** to match `wait_for_agent`'s MCP-safe limit). On cap → `status: running` + `runId` (the D3 envelope is unchanged — never a surprise shape). `read_probe_result(runId, wait?)` polls/blocks to completion and emits `notify` on done for the async path.
- **OQ2 — Retention / redaction / access → RESOLVED.** A per-run dir under `.tachyon/` runtime-state (**gitignored**, off the public surface), keyed by `runId`. **Bounded retention** (time AND count cap — e.g. 7 days / 200 runs, prune oldest); per-artifact size cap + truncation flag (with D9). **No secret redaction in v1** — artifacts are sensitive-by-default and read is **workspace-scoped**. Deferred: redaction, per-caller ACL.
- **OQ3 — Lifecycle edges → RESOLVED.** **In MVP:** cancellation; timeout-kill (D4); orphan reaping on Bridge restart (an incomplete run → `failed` + kill the stray pid, mirroring tmux pane reconciliation); a **concurrency cap** (reject-beyond-cap with a clear status). **Deferred (explicit):** idempotency/dedup, **auto-retry — a non-goal (double budget-spend risk; the caller re-issues)**, full queueing. Client disconnect needs no special handling: the `runId`/async model recovers it for free.
- **OQ4 — Isolation default → RESOLVED.** Isolation is **capability-tied, not blanket.** The read-only/no-write default (D8) gets **no worktree** (nothing to isolate; cache writes land outside the repo). A probe that opts into write/mutation gets an **isolated worktree by default**.
- **OQ5 — Output-contract form → RESOLVED.** Contracts are **machine schemas with a prose field inside.** Each archetype defines a result schema (`adversarial-review` → `{ findings: [{title, severity, target, problem, fix}], mostImportant }`; `factual-verify` → `{ claims: [{claim, verdict, confidence, evidence}] }`) and retains the prose `lastMessage`. Freeform = prose only. Non-compliant model output → `parse_error` (D4). This makes phase-2 pipeline/verify consumption free.
- **OQ6 — Sandbox strength in v1 → RESOLVED.** v1 leans on **runtime-native sandbox flags** (claude permission-mode / codex sandbox) mapped from a neutral least-privilege default (D8) + the D8 caller-authorization. A **Tachyon-side process-enforcement layer** (network / home-dir / credential-helper / out-of-repo writes) is **deferred**; the honest v1 limit is "the probe's sandbox is only as strong as the runtime's own."

## Non-goals

- Replacing or deprecating the persistent-pane lane (`spawn_agent`). This is additive.
- A **stateful multi-turn session** runner. Resume/continuation is cut from MVP (→ a separate `probe_session` design with explicit state, retention, and reproducibility).
- A **general policy/sandbox framework** in v1. The enforcement layer (OQ6) is a question, not a v1 deliverable; v1 carries the least-privilege default + the caller-authorization model (D8), not a full framework.
- A general background-job runner. A probe is a **bounded AI turn with a captured, classified result**, not arbitrary async infrastructure.
- Re-implementing any external harness's bridge scripts. The capability is **engine-native**, built on Tachyon's own runtime adapters.
- **Deferred to post-v1 by ratified decision** (named so the plan doesn't silently scope them in): secret redaction of captured artifacts, per-caller artifact ACL, idempotency / **auto-retry** (double budget-spend risk), full concurrency queueing, and a Tachyon-side process-sandbox enforcement layer.
