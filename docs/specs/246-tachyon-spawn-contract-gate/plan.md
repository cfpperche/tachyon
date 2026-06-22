# Plan — Spec 246 spawn-contract gate

## Approach

Add a pure contract module, gate the Bridge `spawn_agent` handler with it, compose the accepted contract into the child's brief, and persist it as structured metadata. No new injection channel — the Bridge tool is the chokepoint (runtime-neutral).

**v1 scope refinement (implementation decision):** the gate fires only on an **ad-hoc AI-agent spawn** — `cmd` present AND `inferKind(cmd) === "agent"`. Rationale: this is the genuine "delegate a fresh task to a new CLI" case (Agent0's `Task`-dispatch analog), and `inferKind(cmd)` classifies it with no config lookup. **Out of v1:** invoking a *declared* agent by name (it already carries human-authored intent/role in `tachyon.yml`; the spawner may still pass `instructions`) and `kind: terminal` children (can't act on a handoff — D7). This is a clean, low-friction subset of locked D1; widening to declared-agent invocation is a documented follow-up if demand appears.

## Files

### New
- `src/bridge/spawnContract.ts` — pure. `SpawnContract` type; `validateSpawnContract(c)` → `{ ok, errors[] }` (D5 normalizer + required-slot + substance/junk/placeholder checks); `composeSpawnContractBrief(contract, instructions?)` → bounded string (per-field cap + total cap); shared constants (caps, junk set, placeholder regexes).
- `test/unit/spawnContract.test.ts` — table tests for the validator (pass/fail corpus from D5) + brief composition (order, per-field truncation, total cap, optional instructions).

### Changed
- `src/bridge/tools.ts` — `spawn_agent`: extend the zod `inputSchema` with `task`/`context`/`constraints`/`deliverable`/`done_when` (optional in zod; conditional requirement enforced in the handler) + `skip_contract_reason`. Handler: when the spawn is an ad-hoc AI agent and no skip reason → run `validateSpawnContract`; on fail return a STRUCTURED `fail()` naming the offending slots (block→retry); on pass → `instructions = composeSpawnContractBrief(contract, instructions)` and pass `contract` through to `spawn`. `skip_contract_reason` (≥10 chars) bypasses + is surfaced via `deps.notify` (non-silent) + recorded. Update the tool description to teach the contract.
- `src/agents/AgentManager.ts` — `SpawnOptions` gains `contract?: SpawnContract` + `contractSkipReason?: string`; when present, record them on the ledger `def` (D8) alongside the existing record write (~522). No change to the spawn chokepoint logic (D2: no lineage-keyed assert).
- `test/unit/bridgeTools.test.ts` (or the existing bridge test) — gate behavior: reject missing/junk contract → retry succeeds; `skip_contract_reason` bypass; terminal child exempt; declared-agent (no cmd) not gated; the brief reaches `spawn` as composed instructions; contract persisted.

## Caps (D3)
- Per slot: `task`/`deliverable`/`done_when` ≤ 280 chars; `context`/`constraints` ≤ 600 chars (truncate with ellipsis in the brief, never reject for length-over).
- Total brief contract block ≤ ~1600 chars, leaving headroom under the existing 2000 `instructions` cap for role/guidance; `composeSpawnContractBrief` enforces the total.

## Non-regression (tests prove)
- restart / resume / fork do not route through `spawn_agent` → never gated.
- pipeline-node spawns (internal, parse-time `task`) and approved schedule spawns → never gated.

## Alternatives considered
- Gate at `AgentManager.spawn` chokepoint — rejected (D2): lifecycle re-spawns and pipeline/internal callers pass through it; the Bridge tool is the precise agent-facing surface.
- Gate keyed on `opts.parent` — rejected (D1/codex B): optional + self-declared → trivial bypass.
