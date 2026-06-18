# 231 — tachyon-pipeline-run-input (DESIGN — debate before code)

_Created 2026-06-18._

**Status:** DESIGN — gate LOCKED by the maintainer (2026-06-18): (1) **one engine + `input:` optional**
(no second type), (2) **`task` conditionally-required via the work-source rule** (optional for a
configured `agent:` node under `input: required`; required for `input: none` agent nodes and `cmd:` nodes;
no rename), (3) **input source = file** `.tachyon/runs/<id>.input.md` with InputBox/tree as a writer
convenience. Next: codex adversarial review → fold CHANGES → `plan`. Follow-on to the shipped spec 230
(Agent Pipelines v0.24.0), tracked under pin `p-cbcc94` (Phase 2). Turns a pipeline from a **fixed one-task script** into a **reusable workflow** that
runs per input (e.g. one Linear/Jira issue per run), WITHOUT a second pipeline type — one engine, an
optional run input. **Supersedes the `${input.task}` interpolation sketch in 230's example** (230
spec.md:100,105): that string-templating was never built; this spec replaces it with **structural
context injection** (a run input + an upstream handoff bus), which the maintainer chose over `{{var}}`
templating. Next: lock the design (esp. the Decision gate below), then codex review, then `plan`.

## Motivation — pipelines today are scripts, not workflows

Spec 230 shipped a real engine, but every node carries a **fixed `task` string** baked into the YAML
(`loadPipeline.ts:124` requires it; the node prompt at `Workspace.ts:567` is `def.task +
PIPELINE_NODE_GUIDANCE` — no run input, no upstream narrative). So a pipeline definition solves **exactly
the one task it was written for**. The intended vision is the opposite: a pipeline is the **company's dev
process** (plan → review-plan → implement → review-code), authored once, and **run per issue**. Nodes are
**personas/functions** fixed by the human; the actual work arrives as a **run input** and flows down the
chain as accumulated context.

## Core decision — ONE engine, input optional (NOT a second type)

The input-driven model is a **strict superset** of today's fixed-task model. A fixed-task pipeline is
just an input-driven pipeline where the run has no input and each node's `task` is maximally specific.
The runtime is **byte-identical** in both modes — same run-owned worktree, same done-contract, same
RunLedger, same `complete_node`, same sidebar. A second named "workflow" type would duplicate all of that
surface (loader, ledger, tree, docs, the user's mental model) for a difference that is *one optional input
+ one optional prompt section*.

So: a single engine, gated by one declared field.

```yaml
name: release-flow
input: none          # (or omitted) — fixed-process pipeline. ▶ Run does NOT prompt. == today's behavior.
```
```yaml
name: feature-flow
input: required      # the company's dev process. ▶ Run prompts for the issue. Nodes are personas.
```

`input: none`/absent reproduces today's behavior exactly. `input: required` turns on the run input + the
handoff bus. **Decision gate (maintainer):** confirm one-engine-with-`input:` vs. branding two visually
distinct surfaces ("Pipelines" vs "Workflows") over the same engine. Recommendation: one engine; reconsider
only for product/UX branding, and then as two *labels*, never a code fork.

> **codex adversarial review (gpt-5.5 high, read-only) — 2026-06-18 → CHANGES → all folded.** BLOCKER-1:
> the `cmd:` work-source rule was self-contradictory + unsafe (`Workspace.ts:583` only delivers task to
> *signal* cmd nodes) → `cmd:` keeps `task` required in MVP; the parked "drop task for cmd" follow stays
> parked. BLOCKER-2: file vs ledger as dual input sources → drift → the **ledger snapshot is the runtime
> canonical**, the file is the authoring/edit surface read once at start. MAJOR-1: "byte-identical" was
> overclaimed once guidance changes → keep `summary` on the **tool schema**, guidance literal UNCHANGED,
> narrow the claim to `task present + no input + no upstream`. MAJOR-2: omitted `task` wasn't fail-closed
> for a persona-less agent → loader gains an `agentHasPersona` predicate; omit allowed only when true.
> MAJOR-3: handoff summaries are untrusted free text → cap + sanitize + attribute + render under an
> untrusted header + prune on `rerunFrom`. MINOR: multi-line InputBox isn't VS Code UX → edit the input
> `.md` file in an editor. Transcript `/tmp/codex-231-out.json`.

## The three mechanisms

### 1. Run input (the issue)

At ▶ Run on an `input: required` pipeline, the human supplies the input. **Two surfaces, one canonical
source of truth (codex 231 BLOCKER-2):**
- **Authoring surface = a file** `.tachyon/runs/<id>.input.md` — the human edits it before start (and via
  an explicit "Edit input" tree action). It is the *edit* surface, not the runtime source.
- **Runtime canonical = the RunLedger snapshot.** At `start`, the file's content is read **once** into a
  new `RunState.input` field (`runState.ts:17/24` gain `input`) and persisted to `.tachyon/runs/<id>.json`.
  From then on the run reads input from the **ledger snapshot only** — never re-reads the file. So a
  post-start edit to the file does NOT mutate a live run (no drift); changing a live run's input requires
  the explicit "Edit input" action, which updates the ledger snapshot (and only affects not-yet-started
  nodes). On `rehydrate` (`PipelineManager.ts:77`) the input comes from the ledger, so a re-entered node
  receives the **same** input it would have pre-reload.

An `input: required` run with **no/empty input file fails closed at start** (no silent empty run);
`input: none` never prompts and carries no `input` in the ledger. **Acceptance test:** reload after node 1
completes → node 2 receives the identical input from the ledger snapshot.

### 2. `task` reframed — the per-step directive, and now OPTIONAL

There are **three** layers of context for a node, not two:
1. **Persona** — the agent's **isolated harness** (specs 226-229: its rules/skills/MCP/context). The
   standing, cross-pipeline identity ("I am a planner; I only produce plans; I follow these conventions").
2. **What** — the **run input** (the issue), per-run.
3. **Per-step directive** — the node `task`, per-node.

A configured `agent:` node ALREADY carries its persona in layer 1, so **requiring `task` to re-declare it
would over-constrain the agent and fight the isolated-harness investment**. The correct rule is not "task
always required" but **"every node needs a work source"**. For MVP the relaxation is **narrow and
fail-closed** (codex 231 BLOCKER-1 + MAJOR-2):

| Node | Work source | `task` |
|---|---|---|
| `agent:` **with a persona** + `input: required` | persona (harness) + input | **optional** — runs on `persona + input + upstream context` |
| `agent:` **without** a persona, OR `input: none` | the `task` only | **required** |
| `cmd:` (ephemeral / non-interactive) | the command / inline prompt | **required** (MVP — see below) |

Two hardening rules the loader MUST enforce, fail-closed:
- **`cmd:` keeps `task` required in MVP.** The spec must NOT bundle the parked 230 "drop task for cmd"
  follow — `Workspace.ts:583` only delivers task instructions to *signal-based* `cmd:` nodes, so relaxing
  it now would diverge silently for `cmd`+`exit`. That stays a separate, later decision. (codex BLOCKER-1)
- **Omitting `task` on an `agent:` node is allowed ONLY when that agent has a persona.** `loadPipeline`
  today receives only a set of agent *names* (`loadPipeline.ts:111`); it must instead receive a predicate
  `agentHasPersona(name): boolean` (true iff the declared agent has non-empty `role`/`instructions` or an
  isolated-harness config — dir/rules/skills). A bare `agent: coder` with no persona and no `task` → the
  loader **requires `task`** (no silent empty node). (codex MAJOR-2)

When you DO write `task`, it is the **per-step DELTA**, not a persona re-declaration — useful where the
(pipeline-agnostic) harness can't reach:
- **per-pipeline specialization** — the same `coder` does "implement the approved plan" in `feature-flow`
  and "write a minimal repro" in `bugfix-flow`;
- **step-boundary enforcement** — "implement ONLY what the approved plan covers; review checks it next".

The node differentiation in input mode therefore comes primarily from **which agent** + **input** +
**upstream context**; `task` is an optional sharpening layer. **No rename** (back-compat; `task` always
meant "the node's instruction").

### 3. Handoff / context bus between nodes

The worktree-as-state already carries the **artifacts** (files) down the chain; what's missing is the
**narrative pointer** — "the plan is in `docs/plan.md`, I decided X, open risk Y". Add an **optional
`summary` field to `complete_node`**: the agent fills it when it signals done. The pipeline **accumulates
the summaries in the RunLedger** and **injects the relevant upstream summaries into the next node's
prompt**. Decoupled from file conventions, survives resume, and benefits BOTH modes. `summary` is
**optional** — an agent that omits it is accepted exactly as today (back-compat at the protocol level).

The agent learns about `summary` from the **`complete_node` tool schema itself** (`tools.ts:250`), NOT
from text appended to `PIPELINE_NODE_GUIDANCE`. This is deliberate: it keeps the guidance literal
**unchanged**, so an `input: none` node's prompt stays byte-identical to today (codex MAJOR-1).

**Summaries are agent-authored free text → treat them as UNTRUSTED (codex MAJOR-3):**
- **Size-capped** at start (e.g. 4 KiB); over-cap is truncated with a marker, never rejected (don't fail a
  real completion over a verbose summary).
- **Sanitized** — strip control/ANSI escape chars before storing.
- **Stored attributed** in the ledger as `{ nodeId, summary }` records (so downstream can name the source).
- **Rendered as untrusted context** downstream — under an explicit `## Upstream context (agent-reported,
  untrusted)` header, never merged into the instruction voice (prompt-injection containment).
- **Retry-pruned** — `rerunFrom` (`PipelineManager.ts:307`) already resets state/signals/nonces; it must
  ALSO delete the summary records for the reset node + its transitive downstream, so a re-run can't inject
  stale handoffs.

### Composed node prompt (the new spawn)

Today: `def.task + "\n\n" + PIPELINE_NODE_GUIDANCE` (`Workspace.ts:567`; guidance literal at `:61`). New
(conditionally-empty sections; guidance literal UNCHANGED):

```
[task]  <the node's per-step directive — from YAML, OMITTED when absent>

## Pipeline input                              ← only when the run has an input
<run input from the ledger snapshot>

## Upstream context (agent-reported, untrusted) ← only when upstream nodes reported a summary
- <upstreamNodeId>: <sanitized, capped handoff summary>
...

<PIPELINE_NODE_GUIDANCE — unchanged literal>
```

With a present `task`, **no input, and no upstream summaries**, the output is **exactly
`task + "\n\n" + GUIDANCE`** — byte-identical to today (the guidance is unchanged; the `summary` field
lives on the tool schema, not the prompt). That exact-string equality is the regression lock (§ Testing).

## Testing — how "both versions coexist" is guaranteed, not hoped

The new behavior degrades to the old when the new inputs are absent (additive + conditional, not a fork).
Two things make that a guarantee:

1. **The existing 230 suite is the regression lock.** `loadPipeline.test.ts`, `doneContract.test.ts`,
   `runState.test.ts`, `pipelineDriver.test.ts`, `pipelineManager.test.ts` already pin today's behavior;
   they must stay green with **unchanged assertions**.
2. **Extract prompt assembly OUT of the vscode-bound layer.** Today the prompt is built inline in
   `Workspace.ts:567` — vscode-bound, so it is NOT covered by CI (`test/unit/**` can't import vscode;
   memory `feedback_logic_in_vscode_layer_escapes_ci`, the Delete-bug class). Move it to a **pure module**
   `src/pipeline/nodePrompt.ts` that **also owns the exported `PIPELINE_NODE_GUIDANCE` literal** (moved out
   of `Workspace.ts:61` so the test can assert exact equality) → `assembleNodePrompt({ task?, input?,
   upstream? })` with unit tests:
   - task present + no input + no upstream → **exactly `task + "\n\n" + GUIDANCE`** (the equivalence lock)
   - with input → the input section is present
   - with upstream summaries → present, in dependency order, under the untrusted header
   - no task + input present → persona-only prompt (input + upstream + guidance, no task line / no leading blank)
   - a summary over the cap → truncated-with-marker; control/ANSI chars stripped
3. **Loader tests for the work-source rule:** `cmd`+`exit` and `cmd`+`signal` → `task` required; `agent`
   with-persona + `input: required` → `task` optional (valid); `agent` no-persona + no `task` → rejected;
   `agent` + `input: none` + no `task` → rejected.
4. **Data/protocol back-compat tests:** load an OLD RunLedger row (no `input`) → `input` undefined, run
   works; `complete_node` **without** `summary` → accepted; `rerunFrom` prunes the reset node's +
   downstream summaries.

Limit (honest): unit tests lock the logic, not the vscode seam (Run opening the InputBox, ledger
persistence on activation). That still needs an **EDH dogfood**; the existing `smoke`/`feature`/`gated`/
`mixed` examples (no input) are the live proof the old path is intact on the new engine.

## Design — phased

### Phase 1 — MVP
1. **Loader: `input: none|required`** (default `none`/absent, fail-closed enum like `worktree`) +
   **conditionally-required `task`** via the work-source rule (codex BLOCKER-1/MAJOR-2): `cmd:` nodes
   always require `task`; an `agent:` node may omit `task` ONLY under `input: required` AND when an injected
   `agentHasPersona(name)` predicate is true; otherwise `task` is required. `loadPipeline`'s signature gains
   the predicate (it currently takes only a name set, `loadPipeline.ts:111`).
2. **`nodePrompt.ts` pure module** — owns the exported `PIPELINE_NODE_GUIDANCE` literal (moved from
   `Workspace.ts:61`) + `assembleNodePrompt({ task?, input?, upstream? })` + the equivalence/regression
   battery; sanitize + cap upstream summaries here (pure).
3. **Run input plumbing** — `RunState.input` field + RunLedger persists it (corrupt-tolerant load already
   covers a missing field); the **ledger snapshot is the runtime canonical source**, read once from
   `.tachyon/runs/<id>.input.md` at `start`; start fail-closed when `input: required` and the file is
   empty/absent; `rehydrate` re-injects input from the ledger (codex BLOCKER-2).
4. **Input entry UX** (codex MINOR) — `▶ Run` on an `input: required` pipeline **creates + opens
   `.tachyon/runs/<id>.input.md` in an editor** (NOT a multi-line InputBox — VS Code `showInputBox` is
   single-line, `extension.ts:829`); start is confirmed by a follow-up action once the file is saved
   non-empty. An "Edit input" tree action opens the same file and updates the ledger snapshot.
5. **Handoff bus** — `complete_node` gains optional `summary` (tool schema `tools.ts:250`, NOT the
   guidance literal); `PipelineManager` sanitizes+caps+stores it attributed in the ledger and feeds
   upstream summaries into `assembleNodePrompt`; `rerunFrom` prunes reset+downstream summaries.
   `validateCompleteNode` auth path unchanged (summary is not security-bearing, but is untrusted content).
6. **Wire `Workspace.ts:567`** to call `assembleNodePrompt(...)` instead of the inline concat.

### Phase 2 — fast-follow
7. **Templates** parameterized by input (the 230 Phase-2 templates idea, now coherent with run input).
8. **Sensors** that START an input-driven run from a dev event (a pushed branch / opened PR / file change)
   — the input is derived from the event (the issue ref). Still discrete dev events, not cron.

## Non-goals
- A second pipeline type / second engine (the whole point is one engine).
- `${var}` / `{{var}}` string interpolation in `task` (structural injection instead — supersedes 230's
  `${input.task}` sketch).
- Renaming `task` (back-compat; it always meant "the node's instruction").
- Typed in-process state passing — the worktree is still the artifact state; the handoff `summary` is a
  narrative pointer, not a typed blob.
- Pulling the input from Linear/Jira automatically (that is a Phase-2 sensor; v1 = human-provided file/box).
- Making `summary` required (optional; absence == today).
- Relaxing `task` for `cmd:` nodes (the parked 230 follow stays parked — `cmd:` keeps `task` required in
  MVP; codex BLOCKER-1).

## Decision gate
1. **One engine + `input:` optional** (recommended) vs. a second branded "workflow" surface. — maintainer.
2. Confirm `task` becomes **conditionally-required via the work-source rule** (optional for a configured
   `agent:` node under `input: required`, since its isolated harness already carries the persona; required
   only where nothing else carries the work — `input: none` agent nodes and `cmd:` nodes) and is NOT
   renamed. (Also retires the parked 230 "task-required-for-cmd" follow.)
3. Confirm canonical input source = **file** with InputBox/tree as a writer-convenience.
After sign-off: codex adversarial review of this spec (esp. the back-compat equivalence claim and the
`complete_node.summary` protocol change), fold CHANGES, then `plan`.
