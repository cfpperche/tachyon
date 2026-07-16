# ADR — Token economy boundary (fleet host vs runtime tooling)

> **Status:** draft / living — open for discussion and evolution.  
> **Not ratified.** Decisions below are *proposed* working agreements (thread + review); promote
> to ratified only when the maintainer locks them (same style as the CodexBar vendor ADR).  
> **Reviews:** [token-economy-boundary.review-claude.md](./token-economy-boundary.review-claude.md)
> (2026-07-15; verdict: needs edits — folded below).  
> **Related:** [dogfood-product-boundary.md](./dogfood-product-boundary.md),  
> [product-invariant-testing.md](./product-invariant-testing.md) (PI-001; ship-facing locks),  
> [research/codexbar-headless-vendor-spike.md](../research/codexbar-headless-vendor-spike.md)  
> (vendor strategy precedent: reference/oracle, not shipped dependency).

| Field | Value |
|---|---|
| ID | `ADR-token-economy` (working name) |
| Opened | 2026-07-15 |
| Last evolved | 2026-07-15 (fold claude review) |
| Owners | product / architecture (maintainer + ongoing discussion) |
| Trigger | Thread on Claude Code token plugins (Caveman, CodeBurn, Morph, rtk) vs Tachyon as multi-runtime fleet host |

---

## 1. Context

### 1.1 Product identity

Tachyon’s shipped identity is **several agents, one editor, native terminals** (README). In this
ADR’s **working shorthand only**, we call that host an **ADE** (agent fleet environment) —
naming for product language remains **open (Q6)**; §1.1 does not pre-answer marketing.

What the product actually is:

- several AI CLIs side by side (Claude Code, Codex, Gemini, OpenCode, Grok, …)
- orchestration via the local **MCP Bridge**
- **100% local**: no cloud component, no telemetry, **no token proxying**
- users spend **their own provider subscriptions**; Tachyon does not resell or intermediate model tokens

The expensive unit is not “one Claude session.” It is:

```text
N agents × turns × tool payloads × cross-agent reads × retries
(+ which runtime/quota each task was allocated to)
```

### 1.2 External technique class (the thread)

A class of tools optimizes tokens **inside a single coding agent**:

| Tool (examples) | Idea | Typical scope |
|---|---|---|
| rtk | Filter/compress shell/CLI output before it becomes model context | Multi-CLI optional; shell proxy |
| CodeBurn | Local usage/cost observability across many coding tools | Multi-tool dashboard |
| Morph (Fast Apply / WarpGrep / Compact) | Partial edits, focused search, history compact | MCP / API; often paid |
| Caveman-style concision | Reduce prose / compress what enters context | Skill / prompt / plugin |

These techniques are **runtime-agnostic in principle**. Their install shapes (Claude plugin marketplace, hooks, MCP) are not.

### 1.3 Question this ADR answers

1. Are these techniques **valid for Tachyon’s purpose**?
2. As a multi-runtime fleet host, can Tachyon save tokens **per agent** and **across the fleet**?
3. Should we **vendor** those plugins, **build our own**, or something else?

### 1.4 Lever magnitude (optional framing)

Claude’s review offered an alternate cut by **magnitude**, not only ownership. Useful as a check
on D4 — not a second product thesis:

| Magnitude | Lever | Who owns it |
|---|---|---|
| Largest | **Don’t redo work** — durable state outside any context (pins, handoff, worktrees, verify, reanchor) | Fleet host |
| Large | **Do the work on the right quota** — task→runtime routing across subscriptions | Fleet host (spawn-time choice) |
| Smaller | **Shrink what crosses the wire** — payload discipline, curated tails, truncation, prose | Host (Bridge half) + edge tools |

All four thread tools primarily attack the **smallest** lever inside a single agent. That makes
“don’t vendor lever-3 tools into core” a **consequence of magnitude**, not only packaging taste.
The one lever-3 piece with a *safety* dimension (not just savings) is **fail-visible** Bridge
truncation (Q2). Cost observability is **measurement**, not a lever → RuntimeOps / D8.

---

## 2. Decision summary (working)

Strength values while draft: use **Proposed (thread)** / **Proposed** / **Open**. Reserve
**Strong** / **Ratified** for after maintainer lock (§10). Do not read this table as settled policy.

| # | Working decision | Strength |
|---|---|---|
| D1 | Techniques are valid **when interpreted as context engineering for a multi-agent fleet**, not as “ship Claude Code plugins.” | Proposed (thread) |
| D2 | Tachyon as fleet host owns **fleet-level** token economy: Bridge payloads, coordination, durable state outside LLM context, lifecycle, and **task→runtime/quota allocation** (which CLI does the work). | Proposed (thread; allocation added after review) |
| D3 | Per-agent shell noise / prose / editor search are **edge concerns**: optional external tools or user MCP — not product identity. | Proposed (thread) |
| D4 | **Do not vendor** rtk, CodeBurn, Morph, Caveman (or equivalents) into the VSIX/core path. Rationale includes packaging *and* **verification integrity** (lossy filters on evidence paths — §5). | Proposed (thread; integrity rationale folded) |
| D5 | **Build first-party** only what is fleet-host semantics (host/Bridge/fleet). May implement *ideas* (truncate, structured tails) without importing their codebases; any first-party truncation must be **fail-visible**. | Proposed (thread; fail-visible after review) |
| D6 | Optional integration follows the **external-tools** pattern: detect, consent, install-in-terminal, never block core activation. | Proposed |
| D7 | Same vendor posture as CodexBar spike: upstream may be **reference/oracle**, not shipped runtime dependency. | Proposed (by analogy) |
| D8 | Local multi-CLI **cost scan** dashboards remain a **separate capability** with privacy/perf boundary (aligned with RuntimeOps “quota first; cost deferred”). | Open / linked |

---

## 3. Two-layer model

```text
┌──────────────────────────────────────────┐
│  Fleet host / Tachyon (fleet policy)     │
│  Bridge · commands · roles · handoff     │
│  wait · pins · lifecycle · verify        │
│  task→runtime routing                    │
└──────────────────┬───────────────────────┘
                   │ forms envelope + coordination + allocation
     ┌─────────────┼─────────────┐
     ▼             ▼             ▼
  Agent A       Agent B       Agent C
  (own CLI, own provider quota, own context)
```

Column **Shipped in product today?** means *capability exists in the product*, not *this repo’s
dogfood fleet exercises it* (see Q7).

### 3.1 Per agent (host shapes the envelope)

What each runtime *sees* and *is allowed to do cheaply*:

| Lever | Effect | Shipped in product today? |
|---|---|---|
| `commands:` + `run_command` → structured result (happy path often `{passed, exitCode, durationMs, tail}` — see tool/README schema, not this ADR as oracle) | Avoid dumping full test/lint logs into context | Yes |
| Short `instructions` / role templates | Smaller startup contract | Yes |
| `reanchor_agent` + role file after compaction | Avoid full re-exploration after CLI compact | Yes (manual always; auto opt-in via `settings.anchor.auto`, default false; detection claude + codex only) |
| Worktree + `verify` | Fewer failed retries / confused context | Yes |
| Optional rtk / concision skills on the CLI | Shell + prose hygiene | Edge (not core) |

### 3.2 Fleet (only the host can own)

| Lever | Effect | Shipped in product today? |
|---|---|---|
| **Task→runtime / quota routing** (choose which CLI/subscription runs a task class) | Often the largest per-task cost decision; only a multi-runtime host can express it | Yes (spawn-time choice; policy is human/coordinator judgment today) |
| `wait_for_agent` instead of poll + large `read_output` | Cuts cross-agent context burn | Yes (documented) |
| Default `read_output` = visible pane | Payload-size discipline | Yes |
| Pins / project handoff / artifacts on disk | Shared memory **outside** any one context window | Yes |
| Narrow workers + kill on idle | Dead history costs zero future tokens | Yes (lifecycle) |
| Pipelines / runbooks | Orchestration as host graph, not prompt prose | Yes (shipped); budget signals open → Q5 |
| Attention / notify | Fewer “idle waiting” turns | Yes |

**Cost intuition** (illustrative only — not a dimensional model; context grows per turn):

```text
without host discipline:
  cost ≈ Σ (context_i × turns_i) + Σ (read_output_ij × size)
       + misallocation (expensive model on cheap work)

with host discipline:
  cost ≈ Σ (curated_context_i × turns_i)
       + Σ (compact handoff artifacts)
       + near-zero polling
       + work on the right quota
```

### 3.3 What “saving tokens” means for Tachyon

Honest definition (compatible with **no token proxying** — a **pre-existing README product
invariant**, not invented by this ADR):

> Token economy for the fleet host = **not putting junk into context**, **not reprocessing the
> same state across agents**, and **not running work on an unnecessarily expensive quota**.  
> It is **not** intercepting provider traffic or compressing tokens on the wire to the model.

The Bridge process is free; the **calling agent’s** provider quota pays for tool results, schemas, and call overhead. The main Bridge lever is **payload size**, not call count (already README: *What Bridge calls cost*).

---

## 4. Ownership table (build vs vendor vs edge)

**Test for ownership:**

> Does this only make sense because there is a **fleet / Bridge / VS Code host**?  
> → **first-party codebase.**  
> Would this still be useful for **one CLI alone**, outside Tachyon?  
> → **do not vendor; optional integrate or document.**

| Capability | Owner | Ship in core? | Notes |
|---|---|---|---|
| Bridge payload policy (`read_output`, structured `run_command`) | First-party | Yes | Core host; truncation must be fail-visible if added |
| Wait / lifecycle / lineage / pipelines / runbooks | First-party | Yes | Fleet coordination |
| Task→runtime routing (spawn the right CLI) | First-party surface; policy judgment | Yes (choice); policy open | Allocation lever |
| Roles, reanchor, continuity, pins, handoff | First-party | Yes | State outside LLM context |
| RuntimeOps quota / fleet health (selective native) | First-party | Yes (scoped) | CodexBar = oracle only |
| Generic shell output compression (git/test/lint) | Edge (e.g. rtk) or thin first-party truncate on **our** paths | No vendor of rtk | Prefer curated commands first; never silent lossy evidence |
| Multi-tool cost dashboard | Edge (e.g. CodeBurn) or future first-party with privacy lock | No vendor | Cost scan deferred in RuntimeOps research |
| Fast Apply / WarpGrep-class edit-search | User runtime / MCP (e.g. Morph) | No | Not host identity |
| Prose concision (“caveman”) | Role / project guidance / user skill | Text only | No binary |

---

## 5. Rejected alternatives

| Alternative | Why reject (for now) |
|---|---|
| **Vendor rtk into VSIX / Bridge hot path** | Packaging: second binary + release matrix; shell-filter semantics are not host core. **Integrity:** any lossy compressor between agent and evidence is a tamper surface — can hide the failing line and turn a red run into a green-looking tail. Inspiration OK; import of product path not OK. |
| **Any lossy filter on the evidence path (vendored or first-party) without explicit truncation markers** | Verification integrity: gates, `run_command` tails, and verify depend on honest output; silent compression can hide failures. Same class as “documented intent is a hope” ([dogfood-product-boundary.md](./dogfood-product-boundary.md)). |
| **Vendor CodeBurn as Tachyon’s usage UI** | Overlaps RuntimeOps direction; privacy/path surface; product would own their model of “tools.” Optional recommend only. |
| **Depend on Morph (or any paid edit/search SaaS) in core** | Conflicts with local-first and no mandatory cloud; runtimes already have partial edit tools. |
| **Ship Caveman (or equivalent) as a first-party plugin marketplace identity** | Single-runtime culture; marginal/uncertain savings; roles already cover “be brief.” |
| **Become a token proxy / context middleware in front of models** | Explicit product anti-goal (“no token proxying”) — **already README**, not draft-only. |
| **Rewrite a full rtk+CodeBurn+Morph clone in-tree before host levers** | Scope trap; delays moat work (fleet protocol + allocation). |

---

## 6. Alignment with existing product surfaces

Extend these; do not invent a parallel “token killer” product line. Detail lives in §3 tables and README.

- Bridge: targeted `read_output`, `wait_for_agent`, `run_command` / `run_runbook`; README *What Bridge calls cost*  
- Multi-runtime spawn (task→quota routing as human/coordinator choice)  
- Roles / instructions / `reanchor_agent` / `.tachyon/roles/`  
- Pins, project handoff, verify gates, worktrees, pipelines  
- Activity / compaction markers; RuntimeOps research (quota-first; cost deferred)  
- Bridge redaction of secrets on diagnostics: `src/bridge/redact.ts` (partial; not a token compressor)

---

## 7. Optional edge integration pattern (proposed)

If we expose rtk (or similar) at all:

1. **Never** required for Tachyon activation or Bridge auth.  
2. Prefer **curated `commands:`** that already return short tails.  
3. If integrated: **external-tool** UX (detect PATH, present/missing, consent install) — same class as ffmpeg/whisper for plugins.  
4. Document user-side opt-in for Codex/Claude/Grok agents; do not claim universal hook support.  
5. No automatic rewrite of every agent shell without explicit fleet policy (open question — see Q1).  
6. Default-on injection of tools into agent environments is the class governed by **PI-001** / dogfood-product-boundary (project guidance is explicit project input, not product policy) — biases Q1 toward opt-in.

Morph / Caveman: documentation and user MCP/skills only unless a future ADR revisits.

---

## 8. Open questions (discuss and evolve)

Use this section as the living backlog. When a question is resolved, move the answer into §2/§4 and leave a one-line trail in §9.

| ID | Question | Options / notes | Status |
|---|---|---|---|
| Q1 | Should fleet policy ever **recommend or inject** rtk (or equivalent) into spawned agent environments by default? | off by default / opt-in yml / dogfood-only. **Default-on would cross PI-001 / dogfood-product-boundary** and needs a forcing function — biases to opt-in. | Open |
| Q2 | How far should **first-party Bridge truncation** go for hostile or huge `read_output` panes? | max bytes; redact (already partial — `src/bridge/redact.ts`); structured summary tool. **Must be fail-visible:** truncated output explicitly marks what was dropped (bytes/lines); never silent elision. | Open |
| Q3 | Is multi-CLI **cost** observability in-product a goal for vN, or permanently “use CodeBurn”? | link RuntimeOps ADR | Open |
| Q4 | Extend the existing README section *What Bridge calls cost* into a broader **fleet playbook**, or keep the rest architecture-only? | extend README / architecture-only / Studio tips (README already has the Bridge bucket story) | Open |
| Q5 | Pipelines / sub-agents: any **hard budget** signals (max children, max `read_output` bytes per parent turn)? | policy vs soft guidance in primer (pipelines/runbooks themselves are shipped) | Open |
| Q6 | Naming: keep “ADE” in product language, or only in architecture docs? | marketing vs internal; §1.1 uses working shorthand only | Open |
| Q7 | Dogfood: should *this* repo’s `tachyon.yml` demonstrate curated cheap `commands:` as the canonical pattern? | yes / later. **Currently absent** from this repo’s `tachyon.yml` (agents + settings only) — adopting is also dogfood proof for §3.1’s first row. | Open |
| Q8 | Relationship to project guidance / skills: any first-party “be brief / prefer run_command” primer line? | primer.ts / role templates | Open |
| Q9 | What **evidence** accompanies ratifying a token-economy lever? | dogfood before/after on a real task; payload-size fixture on Bridge results; or accept “reasoned, not measured” explicitly. Non-trivial under no telemetry + cost scans deferred (D8). | Open |

_Add rows freely. Do not delete resolved IDs — mark Status = resolved and point to the decision._

---

## 9. Evolution log

| Date | Change |
|---|---|
| 2026-07-15 | Draft opened from product conversation: thread techniques validity; two-layer model; vendor-vs-build hybrid; rejected alternatives; open questions. Status = draft / living, not ratified. |
| 2026-07-15 | Folded [claude review](./token-economy-boundary.review-claude.md): authority wording (Proposed not Strong/sticky); verification-integrity rationale for D4/Q2; ADE as working shorthand (Q6 not pre-answered); task→runtime routing in D2/§3.2; pipelines/runbooks shipped; Q4/Q7 reframed; Q9 evidence standard; PI-001 on Q1; reanchor nuance; lever-magnitude framing §1.4; typo/schema/formula/links nits. |

---

## 10. How to evolve this ADR

1. **Discuss** → capture in §8 (open questions) or a short note under a new `### Discussion: …` if needed.  
2. **Decide** → update §2 table (strength → Strong / Ratified **only after maintainer lock**) and §4 ownership if needed.  
3. **Ratify** → set Status at top to `ratified`, date + owner, and add a forcing function if the decision is ship-facing (test, schema, or packaging lock) per [dogfood-product-boundary.md](./dogfood-product-boundary.md) and [product-invariant-testing.md](./product-invariant-testing.md). Prefer an evidence path for economy claims (Q9).  
4. **Implement** → only after ownership is clear; prefer extending Bridge/commands/roles/allocation guidance over new product lines.  
5. **Do not** treat blog/plugin hype as ratification. External tools may change; this boundary should stay stable.

---

## 11. One-line policy (proposed)

> **Authority:** *no token proxy* is already a **README-level product invariant**. Everything else in
> this block is **proposed with this ADR** until ratified — do not cite as settled product law.

```text
Fleet-host semantics → first-party, test-locked when ship-facing; no third-party binary on the hot path
Shell noise          → curated commands first; optional external compressor at the edge
Usage analytics      → first-party only for fleet surfaces we own; else optional local tool
Evidence path        → never silent lossy filters; truncation must be fail-visible
Never                → token proxy (README invariant); paid SaaS in core; single-runtime plugin pack as product identity
```
