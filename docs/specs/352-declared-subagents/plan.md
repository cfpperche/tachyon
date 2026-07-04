# 352 — declared-subagents — plan

_Drafted 2026-07-04 (post-dueto). The ONE principle: `subagents:` = OWNERSHIP metadata (config → derived
child-side map → roster/UI), a DIFFERENT edge from the runtime lineage `parent` (351 actor identity →
lifecycle). Never conflate. Everything below serves that separation._

## Approach

1. **loadConfig (`src/config/loadConfig.ts`)** — the core:
   - Add `subagents?: string[]` to `AgentDef`/`ManagedEntryDef` and to the `AGENT_KEYS` allowlist (BLOCKER:
     without the allowlist entry, `subagents:` fails unknown-field validation before any semantic check).
   - `parseAgentEntry` accepts `subagents:` as an array of strings on `kind: agent` entries only.
   - After ALL entries are parsed, a NORMALIZATION pass builds a derived child-side map
     `declaredOwner: Map<child, owner>` and runs validation, emitting human-actionable errors (parity with
     the existing namespace-collision error style) for: dangling ref, ref to a `kind: terminal` entry,
     multi-owner (same child listed by two parents → single-parent only), self-ref, direct cycle (a↔b),
     and deep tree (a declared child that itself declares `subagents:` → v1 is one level; rejecting deep
     chains is what makes the direct-cycle check sufficient).
   - The parsed `AgentDef` KEEPS its `subagents:` array for display + YAML round-trip; the derived
     `declaredOwner` is the ONLY thing consumers read for lookup. Expose `declaredOwner` on the config
     object (or a `declaredOwnerOf(name)` helper) — plan-level choice, lean: a field on the loaded config.
2. **AgentManager** — surface ownership WITHOUT touching lineage:
   - `list()` / the roster VM gains a `declaredOwner` field per agent, read from config's derived map.
   - `lineage`, `parentOf`, `liveDescendants`, `rehydrateFromLedger`, the 332 death-poke: UNCHANGED — they
     keep using the 351 actor `parent`. Add a test asserting a declared owner does NOT appear as a runtime
     descendant unless an actual spawn made it one.
   - Restart ordering: config parse (declaredOwner) happens before ledger rehydration; rehydrate restores
     only actor lineage and never invents ownership.
3. **YAML editor (`src/config/YamlConfigEditor.ts`)** — `upsertAgent`/`addAgent` round-trip ONLY the
   canonical parent-side `subagents:` list; the derived `declaredOwner` is never serialized; editing a
   child never synthesizes/rewrites ownership.
4. **Surface (v1 = roster/list_agents ONLY)** — the Bridge `list_agents` output and the sidebar roster show
   the declared owner. **AgentForm.ts is OUT OF SCOPE** (dismembered by spec 350 / t-4c4de4).

## Key decisions

- Ownership is DERIVED at load, not stored as a child-side `parent` (dueto blocker 2) — the runtime `parent`
  field is reserved for 351 actor identity; conflating them corrupts caller validation.
- Single-parent ownership (multi-owner = error) — keeps the derived map a clean `Map<child, owner>` and
  matches "ownership" semantics; a grouping/many-owners model was rejected as a different feature.
- One level only (deep trees rejected) — bounds v1 and makes direct-cycle detection complete.
- No spawn-time owner/actor conflict check — declaration is descriptive; owner≠actor is explicitly fine
  (the codex-spawns-claude's-reviewer case must NOT error).

## Files touched

- `src/config/loadConfig.ts` (field + AGENT_KEYS + parse + normalization/validation + derived map) — core.
- `src/config/YamlConfigEditor.ts` (round-trip the parent-side list only).
- `src/agents/AgentManager.ts` (roster `declaredOwner` surface; NO lineage change) + the list VM type.
- `src/bridge/tools.ts` (list_agents output carries declaredOwner) — descriptions only, no logic in the
  hot 341/348/351 paths.
- Sidebar roster VM/render (show owner) — small, or defer to the surface task if it risks the 350 churn.
- Tests: loadConfig validation matrix, normalization, round-trip, restart ordering, the owner≠actor
  spawn-provenance test.

## Risks & unknowns

- The 351 lineage code is freshly shipped and security-relevant — the golden rule is this spec ADDS a
  parallel ownership read and touches NONE of the actor-lineage machinery. Any temptation to route
  declaredOwner into parentOf/liveDescendants/death-poke is the bug the whole spec exists to prevent.
- Sidebar surface may brush spec-350/plugin WIP in webview — keep the roster change minimal or land it last.
- AGENT_KEYS line number is approximate (drifts); grep for the allowlist, don't trust the anchor.

## Sources consulted

spec 352 post-dueto + notes disposition (probe-48e0b09a + the 5 coordinator adjustments) · loadConfig.ts
(AgentDef, AGENT_KEYS ~348, agents Record ~286, parseAgentEntry ~525) · AgentManager.ts (lineage ~280,
parentOf ~322, liveDescendants ~331, rehydrateFromLedger) · spec 351 (actor identity, the edge to NOT touch)
· spec 215 (shared namespace) · YamlConfigEditor.ts.
