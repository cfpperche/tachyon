# 352 — declared-subagents

_Created 2026-07-04._

**Status:** shipped

**Closure:** Shipped declared `subagents:` ownership parsing/validation, derived child-side `declaredOwner`
**Verify:** `npm test -- --run test/unit/config.test.ts test/unit/agentManager.test.ts`
**Verify:** `npm run typecheck`
**Dogfood:** `npm test -- --run test/unit/config.test.ts -t "subagents"`
metadata, roster/list_agents/sidebar display, YAML round-trip, and owner≠actor regression coverage. Human
dogfood remains for the maintainer per this spec's handoff.

## Intent

The `tachyon.yml` roster is a FLAT namespace (`agents:` is `Record<string, AgentDef>`; agents and terminals
share one namespace, spec 215). Nothing declares that agent A owns a team of child agents; the parent→child
relationship exists only at RUNTIME as session-local memory (self-declared via `spawn_agent(parent:)`, an
in-memory lineage Map — not persisted, not versioned, invisible before anything runs).

This spec adds a declarative, persisted **`subagents:`** field on an agent entry, naming the child agents it
owns, so the roster carries the hierarchy instead of it only emerging at runtime. It is purely additive and
opt-in.

**CRITICAL SEMANTIC BOUNDARY (dueto blockers 1-3, the whole point of this rewrite):** `subagents:` declares
**OWNERSHIP** — a static, config-level edge — which is a DIFFERENT relationship from the runtime **lineage
parent**, the actor/caller identity spec 351 just made authoritative. They can legitimately diverge: `claude`
may declare `reviewer` as a subagent, yet `codex` may be the one that actually spawns a `reviewer` instance.
- **Declared owner** (this spec): config → derived child-side `declaredOwner` metadata → consumed ONLY by
  roster/`list_agents`/UI. Never feeds runtime lifecycle.
- **Runtime lineage parent** (spec 351/332, UNCHANGED): the Bridge-resolved spawning actor → consumed by
  `liveDescendants`, `rehydrateFromLedger`, the death-poke. Declaration NEVER overrides `spawn_agent.parent`
  and NEVER seeds lineage.

"Done" means: an entry declares `subagents:`, loadConfig parses + validates it (dangling / kind / multi-owner
/ self-ref / direct-cycle / deep-tree all fail closed with human-actionable errors), the ownership is
inspectable in the roster, and — pointedly — runtime spawn lineage keeps reporting the actual spawner, with
no owner/actor conflation anywhere.

## Semantics table (the contract, dueto finding 4)

| | Declared owner (this spec) | Runtime lineage parent (351/332, unchanged) |
|---|---|---|
| edge | config-level OWNERSHIP | instance-level ACTOR (who spawned THIS instance) |
| source | `tachyon.yml` `subagents:` → derived `declaredOwner` at load | `spawn_agent` Bridge-resolved caller (or validated explicit parent) |
| consumers | roster / `list_agents` / UI display | `liveDescendants`, `rehydrateFromLedger`, death-poke |
| lifecycle role | NONE in v1 | full (kill subtree, poke parent, worktree guard) |

## Acceptance criteria

- [x] **Scenario: declare + derive ownership**
  - **Given** `tachyon.yml` where agent `claude` has `subagents: [reviewer, tester]`, both declared
    top-level `kind: agent` entries
  - **When** loadConfig runs
  - **Then** `claude`'s parsed `AgentDef` retains `subagents: ["reviewer","tester"]` **for config display +
    YAML round-trip only**, AND load derives a child-side ownership map `declaredOwner: {reviewer: "claude",
    tester: "claude"}`; AgentManager consumes ONLY the derived map for lookup/display and NEVER uses
    `AgentDef.subagents` as a lifecycle traversal source (dueto A1/finding 2/finding 14)
- [x] **Scenario: load-time validation, all fail closed** (dueto findings 9/10/15 + locked maintainer calls)
  - **Then** loadConfig records a human-actionable error (naming the agent + the offending ref, parity with
    namespace-collision errors) for each of: **dangling** (`subagents: [ghost]`, no such entry);
    **wrong kind** (ref resolves to a `kind: terminal` entry — agents/terminals share the namespace, so this
    must be checked); **multi-owner** (two agents both list the same child — v1 ownership is single-parent);
    **self-ref** (`a` lists `a`); **direct cycle** (`a`↔`b`); **deep tree** (a declared child itself
    declares `subagents:` — v1 allows exactly ONE ownership level, and because deep chains are rejected the
    direct-reciprocal cycle check is sufficient)
- [x] **Scenario: config ownership exists without any instance** (dueto finding 5 — replaces the untestable
  old criterion 3)
  - **Given** `claude` declares `subagents: [reviewer]` and no `reviewer` instance is running
  - **Then** the derived `declaredOwner[reviewer] === "claude"` is inspectable from config alone — ownership
    is a static fact, not contingent on a spawn
- [x] **Scenario: spawn provenance stays actor, not declaration** (dueto blocker 1 / finding 6)
  - **Given** `reviewer` is declared under `claude`
  - **When** `codex` (not claude) calls `spawn_agent(reviewer)`
  - **Then** the runtime lineage parent is **codex** (the 351 Bridge-resolved caller), `declaredOwner`
    remains `claude`, and NO warning/error is emitted for the owner≠actor divergence — declaration is
    descriptive, never an allow-list or a second mismatch check
- [x] **Scenario: roster surfaces ownership (v1 surface = roster ONLY)** (dueto A3/finding 12)
  - **Then** the declared owner is visible in `list_agents`/roster output; **Agent Studio / AgentForm.ts is
    explicitly OUT OF SCOPE** (it is being dismembered by spec 350 / task t-4c4de4 — editing it here is
    throwaway)
- [x] **Optional / regression**: `subagents:` is optional; every existing `tachyon.yml` without it loads and
  behaves exactly as before
- [x] **Scenario: YAML round-trip writes only the canonical parent-side field** (dueto finding 7)
  - **Then** `upsertAgent`/`addAgent` preserve and write ONLY the parent-side `subagents:` list; the derived
    child-side `declaredOwner` is NEVER serialized; editing a parent may change its `subagents:`, but editing
    a child never synthesizes/removes/rewrites ownership unless the caller changes the parent's list
- [x] **Scenario: restart ordering** (dueto finding 13)
  - **Then** on startup, config parse builds `declaredOwner` metadata BEFORE ledger rehydration;
    `rehydrateFromLedger` restores only ACTOR lineage from the ledger and overlays `declaredOwner` from the
    current config WITHOUT mutating any runtime parent
- [x] **Implementation constraint** (dueto A4/finding 11 — a release blocker, not a nit): the `AgentDef`
  allowed-key allowlist (`AGENT_KEYS` in `loadConfig.ts`, ~line 348 — treat as approximate) MUST include
  `subagents` before the unknown-field validation runs, or a `tachyon.yml` with `subagents:` fails before
  semantic validation

## Non-goals

- **Declaration does not affect runtime lifecycle** in v1 (no death-poke/liveDescendants/worktree-guard use
  of `declaredOwner`; a later spec may add it, deliberately).
- No inline nested definitions (`subagents:` names already-declared top-level agents; keeps namespace 215).
- No auto-spawn (declaring does not start children).
- No enforcement / spawn allow-list (declaration is descriptive, not a permission gate; owner≠actor is fine).
- No deep trees (one ownership level; declared children may not declare their own).
- No change to ad-hoc `spawn_agent` contracts or to the 351 caller-parent validation.

## Open questions

_All four draft-time open questions are resolved: (1) declared links seed OWNERSHIP metadata, NOT runtime
lineage parent (dueto blockers 1-3) — runtime parent stays the 351 actor; (2) self-ref + direct cycle
rejected, and deep trees rejected outright which makes direct-cycle checking sufficient; (3) agent-kind only,
now a hard acceptance criterion; (4) roster/list_agents only in v1, AgentForm out of scope. Remaining for
plan: the exact name/shape of the derived ownership map and whether it lives on the config object or is
computed on demand._
