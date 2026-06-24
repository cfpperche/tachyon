# Spec 257 — Probe agent (a captured, headless A2A lane)

**Status:** DRAFT — to pressure-test with codex, then agree with the maintainer. · **Follows:** [spec 250](../250-tachyon-plugin-system/) (the per-runtime adapter pattern this reuses) and the Bridge A2A surface (`spawn_agent` / `wait_for_agent` / `read_output`) which this complements, not replaces. Relates to verify-gate ([spec 214](../214-tachyon-verify-gate/)) and pipelines (`src/pipeline/`), both of which gain a clean input. · **Surface:** a new Bridge primitive (`probe_agent` / a captured result reader), a per-runtime "headless capture" adapter capability, and a transient observability row. · **UI impact:** flow (a transient, collapsible probe row in the sidebar; a way to inspect a finished probe's captured result).

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

Meanwhile, **each supported runtime already ships a non-interactive mode that solves exactly this** — a headless invocation that prints a structured final message (and, optionally, a machine-readable event stream) and exits with meaningful status. Tachyon never uses it: every agent is the interactive TUI. The capability gap is not in the CLIs; it is that Tachyon has no lane that *calls them that way and captures the result*.

## Goal

A first-class **captured, headless probe** lane, additive to (never replacing) the persistent-pane lane:

- A Bridge primitive runs a chosen runtime **non-interactively**, **bounded** (timeout, optional budget, restricted permissions by default), and returns a **structured result** — the model's clean final message, an exit/result classification (success vs an explicit error result such as budget exhaustion), optional captured events, a cost figure when the runtime reports one, and a run id.
- The result is **handed back to the caller directly** (bounded-synchronous), with an async-with-`notify` escape hatch for probes that may outlive a single Bridge call.
- The probe is **observable, not invisible**: it surfaces as a transient, collapsible row in the sidebar while running and leaves an inspectable captured result after it exits — strictly better than a detached background subprocess.
- Per-runtime specifics live in **adapters**, reusing the pattern already established for MCP registration ([`src/registration/adapters.ts`](../../../src/registration/adapters.ts)), plugin materialization (`src/plugins/adapters/`), and session resume (`src/resume/adapters.ts`). A runtime with no usable non-interactive mode is **honestly skipped/refused**, never faked.

Downstream, the same captured result becomes the clean input that makes **AI pipeline steps** and **verify/judge** robust — but those are phase 2; the MVP is the duet primitive.

## Prior art (CLI non-interactive modes — exact flags pinned at plan time)

Each runtime offers a documented headless mode that emits a structured final message and a meaningful exit status. The adapter encapsulates the exact invocation; the spec records the **shape**, and planning verifies the precise flags against each CLI's current docs (the CLIs move fast — do not freeze flags here).

| Runtime | Non-interactive entry | Clean final message | Machine-readable stream | Bound / cost | Error signalling |
|---|---|---|---|---|---|
| **claude** | print/headless mode (`-p`) | JSON output format carrying the final result | streaming JSON event format | budget cap flag; cost reported in the result | a structured error *result* (e.g. budget reached) distinct from a process crash |
| **codex** | `exec` subcommand | last-message captured to a file | JSON event log (`--json`) | wall-clock via the caller; sandbox flag | non-zero exit + last-message content |

The takeaway: **the capture mechanics differ per runtime (a result-JSON field vs a last-message file), but the contract is uniform** — run bounded, hand back a clean final message + a success/error classification. So the probe gets a **neutral result shape** populated by a per-runtime adapter — the same "common-denominator, format-differs" thesis the plugin capabilities (250/251/254) are built on.

> A critical robustness lesson the adapter MUST encode: a runtime can **exit non-zero with a structured error result that lives in stdout/last-message** (budget exhausted, refusal, max-turns) — that is a *result*, not a silent death. The adapter surfaces `isError` + a `resultSubtype` and lifts the error text into `lastMessage`, so a probe that hit its budget never reads back to the caller as an empty success.

## Proposed decisions (to pressure-test with codex, then agree with the maintainer)

- **D1 — Two lanes, additive.** Keep `spawn_agent` (persistent pane, watch/intervene) exactly as is. Add a **probe** lane for bounded captured work. A probe is *ephemeral by definition*: it runs to completion and yields a value; it is not a teammate. Neither lane is deprecated by the other.
- **D2 — New Bridge primitive `probe_agent`.** Distinct tool rather than a `mode:` flag on `spawn_agent`, because the *return contract* differs fundamentally (a structured result vs "the agent started"). Inputs: `runtime`, `prompt`/brief, optional `model`, `timeoutSec`, `budget`, `permission/sandbox`, `cwd`, `worktree?`, `resume?`. Output: the neutral result shape (D4).
- **D3 — Per-runtime "headless capture" adapter capability.** Each runtime adapter declares: the non-interactive invocation, how to read the clean final message, how to read the event stream, and how to classify an error result. Reuses the established adapter seam; a runtime lacking a usable mode is refused with a clear reason (honest, fail-closed).
- **D4 — Neutral structured result.** `{ lastMessage, exitCode, isError, resultSubtype, costUsd?, events?, runId }`. Never a raw pane scrape. `isError`/`resultSubtype` make budget/refusal/timeout first-class (see the prior-art robustness note).
- **D5 — Bounded & least-privilege by default.** A probe defaults to the most restrictive permission/sandbox that still lets it read the repo, plus an explicit timeout; write/edit and broader sandbox are opt-in. A budget cap is honored when the runtime supports one.
- **D6 — Observable, not hidden.** A running probe is a transient, collapsible sidebar row; a finished probe leaves an inspectable captured result (activity-ledger record + readable by `runId`). This is the deliberate improvement over a detached subprocess: bounded work is still *seen*.
- **D7 — Composable (phase 2).** The captured `lastMessage`/result becomes a consumable value for pipeline/runbook AI nodes and for `verify_agent`/judge flows — turning "ask a model and branch on the answer" into a real, non-scrape primitive.
- **D8 — Cross-runtime duet is the headline use.** An agent of runtime A calls `probe_agent` for runtime B (and vice-versa) and gets a clean captured second opinion, inside Tachyon, visible as a transient row. The literal duet, made native and observable.

## Open questions

- **OQ1 — Sync vs async default.** Bounded-synchronous (hold the Bridge call until the probe exits, capped) is the cleanest caller ergonomics, but an MCP client imposes its own call timeout (cf. `wait_for_agent`'s 240s ceiling). **Lean:** synchronous up to a cap, auto-fallback to async (`notify` on done + `read_probe_result(runId)`) beyond it. Pressure-test the cap and the fallback hand-off.
- **OQ2 — Execution substrate.** Tachyon's engine is tmux-centric. Does a probe run (a) headless inside a managed tmux pane, capturing via the runtime's own output file rather than scraping, or (b) as a fully engine-managed subprocess outside tmux? **Lean:** (a) — stay on the tmux substrate for lifecycle/observability uniformity, but capture from the structured output, not the pane. Verify tmux doesn't corrupt a captured non-TTY stream.
- **OQ3 — Where the captured result lives.** Returned inline only, or persisted to a run record re-readable by `runId`? **Lean:** persist a run record (provenance) AND return inline; `read_probe_result(runId)` for the async path and post-hoc inspection.
- **OQ4 — Worktree isolation.** `spawn_agent` supports `worktree`. Probes are usually read-only; a write probe might want isolation. **Lean:** optional, off by default.
- **OQ5 — Permission/sandbox default per runtime.** claude permission-mode vs codex sandbox have different vocabularies. **Lean:** a neutral "read-only repo" default mapped per runtime to its most restrictive mode that still reads files; opt-in escalation.
- **OQ6 — Continuation / multi-turn duets.** Support `resume` by session id so a duet can be continued (the runtimes expose this). **Lean:** yes, pass-through resume; verify each runtime's non-interactive resume semantics (note the known claude headless session-id minting caveat — confirm before relying on it).
- **OQ7 — Pipeline consumption shape (phase 2).** How a pipeline node exposes a probe's `lastMessage` as a downstream variable / branch condition. Deferred to the phase-2 design once the primitive lands.
- **OQ8 — Delegation contract reuse.** `spawn_agent` enforces a task/context/constraints/deliverable brief (spec 246). Should `probe_agent` reuse it, or is a bounded probe exempt? **Lean:** reuse a lighter form — a probe still benefits from an explicit task, but `done_when`/`deliverable` is implicitly "the captured answer".

## Non-goals

- Replacing or deprecating the persistent-pane agent lane (`spawn_agent`). This is additive.
- A general background-job runner. A probe is a **bounded AI turn with captured output**, not arbitrary async infrastructure.
- Re-implementing any external harness's bridge scripts. The capability is **engine-native**, built on Tachyon's own runtime adapters.
