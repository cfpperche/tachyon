# 352 — declared-subagents — tasks

_Generated 2026-07-04. GOLDEN RULE at every step: `declaredOwner` (config ownership) NEVER touches the
runtime actor `parent` (351 lineage) machinery — liveDescendants/parentOf/rehydrate/death-poke stay
untouched. Commit per task, ALWAYS by pathspec. Existing config/agent tests green at every commit._

## Implementation

- [x] T1 loadConfig core: add `subagents?: string[]` to AgentDef + to the AGENT_KEYS allowlist; parse it on
  kind:agent entries; NORMALIZATION pass building `declaredOwner: Map<child,owner>`; validation errors
  (dangling / terminal-kind / multi-owner / self-ref / direct-cycle / deep-tree) in the existing error
  style; keep `subagents:` on the parsed AgentDef for display/round-trip. Tests: full validation matrix +
  the happy path + an existing tachyon.yml without subagents unchanged.
- [x] T2 AgentManager roster surface: `list()`/roster VM gains `declaredOwner` from config's derived map;
  add the negative test (declared owner is NOT a runtime descendant absent an actual spawn); restart
  ordering (config ownership before ledger rehydrate). NO change to lineage/parentOf/liveDescendants/
  rehydrateFromLedger/death-poke.
- [x] T3 YAML round-trip: upsertAgent/addAgent preserve+write only the parent-side `subagents:`; never
  serialize declaredOwner; editing a child never rewrites ownership. Tests.
- [x] T4 list_agents surface: the Bridge tool output carries declaredOwner (description + payload; no logic
  in the 341/348/351 hot paths). Sidebar roster shows the owner (minimal; land last if it risks 350/plugin
  webview WIP — else fold here).
- [x] T5 Docs truth pass + full suite + both typechecks; confirm the golden rule held (grep that
  declaredOwner has zero references inside lineage/death-poke/liveDescendants).

## Verification

- [x] Validation matrix: each of dangling/terminal/multi-owner/self-ref/direct-cycle/deep-tree produces a
  named human-actionable error — T1 tests.
- [x] Derived ownership exists from config alone (no instance) — T1/T2 test.
- [x] Spawn provenance stays actor: codex spawning claude's declared reviewer → runtime parent codex,
  declaredOwner claude, no error — T2 test (the owner≠actor case).
- [x] Round-trip writes only parent-side subagents — T3 test.
- [x] Restart: config ownership before ledger rehydrate, rehydrate invents no ownership — T2 test.
- [x] Golden rule: declaredOwner unreferenced in lineage/liveDescendants/death-poke — T5 grep + review.
- [x] `npm test` + both typechecks green.

**Headless check:** `npm test -- --run test/unit/config.test.ts test/unit/agentManager.test.ts && npm run typecheck`

**Verify:** `npm test -- --run test/unit/config.test.ts test/unit/agentManager.test.ts`
**Verify:** `npm run typecheck`

## Dogfood

**Dogfood:** `npm test -- --run test/unit/config.test.ts -t "subagents"`
<!-- The validation matrix + owner-vs-actor separation IS the contract; a live tachyon.yml edit is the human
     pass below. -->

**Human dogfood:** Add `subagents: [<some declared agent>]` to an agent in tachyon.yml; reload; confirm the
roster/list_agents shows the declared owner, a dangling/terminal/multi-owner ref shows a clear config error,
and spawning that child from a DIFFERENT agent still reports the actual spawner as runtime parent (owner and
actor stay distinct).

## Visual QA

**Visual QA Opt-Out:** Config-parse + roster-metadata work; the only rendered change is a small owner label
in the roster, covered by the human dogfood. (If the sidebar label lands, capture one roster screenshot.)
