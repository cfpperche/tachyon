# Spec 246 — Spawn-contract gate (structured handoff on agent-initiated child spawns)

**Status:** IMPLEMENTED + codex-reviewed 2026-06-22 (BLOCK → 3 items folded: launcher-aware `resolveBinary` so a gated AI spawn also RECEIVES its brief [#1]; `env -u` no longer a false-negative [#3]; `contractSkipReason` persisted [#2]). 972 unit tests + tsc main/webview green. · **Date:** 2026-06-22 · **Follows:** spec 245 (project handoff), 236 (Bridge tools), 216 (Bridge guidance / role composition) · **Surface:** `src/bridge/tools.ts` (`spawn_agent` schema + handler), `src/roles/templates.ts` (contract→brief composition), `src/agents/AgentManager.ts` (persist structured contract; optional `contractChecked` guard) · **Review:** codex design debate DONE (NEEDS-REVISION 5 items → folded below) · **UI impact:** none (Bridge/MCP + spawn composition only)

> **Origin:** second concrete step of the "migrate Agent0's harness into Tachyon, minimal pollution" thesis (after spec 245). The migrated mechanism is Agent0's **`delegation-gate`** — a `PreToolUse` hook that blocks an `Agent`/`Task` dispatch unless it carries a 5-field handoff (TASK / CONTEXT / CONSTRAINTS / DELIVERABLE-or-DONE_WHEN). Codex dueto (2026-06-22) picked this over secrets-preflight/validator because it is the clean **runtime-neutral** unit: Tachyon validates the spawn *request* at an orchestration chokepoint it already owns, so it gates a claude **and** a codex/gemini/opencode child identically — unlike an injected claude `--settings` hook, which would be claude-only (a half-migration). Classification = **adapt**.

## Problem

When a Tachyon agent delegates work to a **child** agent via the Bridge `spawn_agent` tool, nothing requires the parent to hand the child a scoped brief. The child is born with at most an **optional**, free-form `instructions` string (`bridge/tools.ts` `spawn_agent`: `name` required, everything else — `cmd`/`cwd`/`instructions`/`parent`/`worktree` — optional). A parent can spawn a child with no task, no constraints, no definition of done, so the child invents its own framing — the exact failure Agent0's `delegation-gate` prevents. Tachyon has role templates, continuity, and project handoff, but **no spawn-time contract**: all of those are voluntary or post-spawn.

Grounding (verified, incl. codex debate corrections):
- **The Bridge `spawn_agent` tool IS the agent-facing delegation surface** (`src/bridge/tools.ts:137`). Any call through it is an agent-initiated child spawn. Its handler calls `AgentManager.spawn(name, …)`.
- **`parent` is NOT a reliable delegation signal** — it's optional + self-declared (the tool only says "ALWAYS pass parent" in prose, `bridge/tools.ts:141,156`). Gating on `parent` is a trivial false-negative bypass (omit it → skip the gate). Gate the *tool*, not the field.
- **Lifecycle re-spawns do NOT pass through `spawn_agent`:** `restart`/`resume` spawn tmux directly (`AgentManager.ts:788,821,943,1004`), and `fork` records no parent (`AgentManager.ts:1186,1196`; test `agentManager.test.ts:925`). So gating the `spawn_agent` handler has **no** restart/resume/fork false-positive — the feared chokepoint race does not exist.
- **Pipeline nodes already carry a contract:** `NodeDef.task` validated at parse time (`loadPipeline.ts:137`), composed via `assembleNodePrompt` (`nodePrompt.ts`). `propose_schedule(spawn)` is inert until human approval (`bridge/tools.ts:799,819`) → becomes human-owned config.
- **Single runtime-neutral chokepoint downstream:** every spawn funnels through `AgentManager.spawn` with no per-runtime branch (adapter only injects a resume id pre-spawn). Enforcement above it (the Bridge handler) is runtime-neutral by construction.

## Goal

Require a Bridge-initiated **AI-agent** child spawn to carry a structured handoff before the child is created, and **deliver that handoff to the child as its opening brief**. The contract IS the child's brief (not a toll-booth) — filling it has direct downstream value, the anti-rubber-stamping lever Agent0's prose-only check lacks. Enforced at the Bridge handler, runtime-neutral, repo-clean.

## Decisions (locked — maintainer-ratified + codex debate 2026-06-22)

- **D1 — Scope = every Bridge `spawn_agent` call for an AI agent; NOT keyed on `parent`.** The Bridge tool is the delegation surface; gate the tool. `parent` stays lineage-only. **Out of scope:** human Studio spawns (not via Bridge), pipeline-node spawns (parse-time `task`), `propose_schedule(spawn)` (human-approved → config). *(codex B/D)*
- **D2 — Enforce IN the `spawn_agent` handler (block→retry). No lineage-keyed chokepoint assert.** Lifecycle re-spawns bypass `spawn_agent`, so there's nothing to defend at the chokepoint. If a manager guard is ever added, it keys on an explicit `opts.contractChecked` flag set by the handler — never on `parent`/lineage. *(codex A)*
- **D3 — Contract = 4 required slots (full Agent0 parity), composed into the brief.** Require `task` + `context` + `constraints` + exactly one of `deliverable` / `done_when`. Composition order: **role template → structured contract → optional free-form `instructions` → Bridge guidance**, via a dedicated bounded `composeSpawnContractBrief(contract, instructions)` fed once through the existing `composeInstructions()` + `withBridgeGuidance()`. Per-field caps + a total cap — the contract must NOT silently bypass the existing 2000-char `instructions` cap. *(codex C/F — context/constraints are REQUIRED; optional would drop the core parity value)*
- **D4 — Runtime-neutral by construction.** Enforced at the Bridge handler, never an injected claude hook → a codex/gemini/opencode child is gated identically. (The reason this beat secrets-preflight/governance-gate.)
- **D5 — Anti-gaming validator (concrete).** Normalize (trim + collapse whitespace); reject empty; reject untouched placeholders (`<…>`, `{{…}}`); reject case-insensitive junk `{asdf, qwer, tbd, todo, n/a, none, null, placeholder, dummy, test, xxx}`; each required slot ≥ 8 chars AND (≥ 2 alphanumeric tokens OR a path/code marker `/ . : - _`). Passes `Fix lint.` / `tests pass` / `src/foo.ts` / `read-only`; blocks junk. Table tests for pass/fail. *(codex E)*
- **D6 — Escape hatch = `skip_contract_reason` (string, ≥ 10 chars), NON-silent.** Mirrors Agent0's line-start `# OVERRIDE: <reason ≥10>`; recorded to lineage/ledger, never skips audit. *(codex F)*
- **D7 — Non-AI / terminal children are EXEMPT.** A `kind: terminal` / non-`agent` child can't receive delivered instructions (test `agentManager.test.ts:239`); the gate applies to AI-agent spawns only. A `task`-only requirement for terminal spawns is explicitly deferred. *(codex B, missing-decision)*
- **D8 — Persist the accepted contract as STRUCTURED metadata** on the agent's ledger/lineage record, not only flattened into `instructions` — so it's queryable for audit + the future verify increment. *(codex missing-decision)*

## Non-goals

- Gating human Studio spawns, pipeline-node spawns, or approved schedule-proposal spawns (D1).
- A full contract on non-AI/terminal children (D7).
- Injected-hook / per-runtime-hook enforcement (defeats runtime-neutrality).
- **The verify side** — did-the-child-deliver (Agent0's `delegation-verify` @ `SubagentStop`). Tachyon has no `SubagentStop` (children are CLI processes in tmux panes), so this is a separate, harder mechanism (completion detection + delivery judging). Deferred to a future increment, possibly reusing the spec-214 verify-gate. *(maintainer-ratified, decision 6)*

## Risks

- **R1 — rubber-stamping** (parent fills junk to pass). Mitigation: D3 (contract = the child's real brief) + D5 (substance validator).
- **R2 — friction on legitimate quick spawns.** Mitigation: D6 override + D7 terminal exemption.
- **R3 — bypass by omitting `parent`.** Closed by D1: the gate keys on the *tool*, not the field.
- **R4 — brief composition overflow / duplication** vs role+guidance. Mitigation: D3 bounded `composeSpawnContractBrief` + total cap + single pass through existing composers.

## Acceptance

- [ ] A Bridge `spawn_agent` for an AI agent with a missing/placeholder slot is REJECTED with a structured error naming the offending slot(s); the parent retries with substantive values and succeeds.
- [ ] All 4 slots required (task/context/constraints/deliverable-XOR-done_when); the D5 validator rejects junk and passes terse-but-real values (table tests).
- [ ] The accepted contract is composed into the child's opening brief in order role→contract→instructions→guidance, within the total cap.
- [ ] The contract is persisted as structured metadata on the agent's record (D8).
- [ ] Lifecycle non-regression: restart / resume / fork are NOT re-gated; pipeline-node and approved-schedule spawns are NOT gated (tests).
- [ ] Runtime-neutral: a non-claude (e.g. codex) AI child via the Bridge is gated identically, no injected hook.
- [ ] Terminal/non-AI child spawns are exempt (D7).
- [ ] `skip_contract_reason` (≥ 10 chars) bypasses the gate and is recorded non-silently (D6).
