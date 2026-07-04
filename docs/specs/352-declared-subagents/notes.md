# 352 — declared-subagents — notes

_Created 2026-07-04._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Design dueto (probe codex, adversarial-review, 2026-07-04, runId probe-48e0b09a) + coordinator adjustments

The spec was drafted by claude-3 OUTSIDE the coordinator's context, before spec 351 (per-agent caller
identity) shipped. The coordinator (claude) read it against current code and found 5 adjustments; the codex
dueto validated all 5 and found 10 more. 15 findings, 3 blockers — all fold into ONE principle:

**`subagents:` = OWNERSHIP (config edge, roster/UI) ≠ runtime lineage `parent` (actor edge, 351/332,
lifecycle). One `parent` concept must never carry both.**

Coordinator adjustments, as validated:
- A1 (invert-at-load) — CONFIRMED but CORRECTED by dueto blocker 2: invert into a DERIVED child-side
  `declaredOwner` map, NOT into `AgentDef.parent` (which now feeds 351 actor lineage). The child-list is
  normalized, but the sink is ownership metadata, never runtime parent.
- A2 (owner-vs-actor) — CONFIRMED as the central blocker (dueto blocker 1/finding 4/6). Kept separate;
  semantics table added; death-poke/liveDescendants keep actor lineage.
- A3 (no AgentForm) — CONFIRMED (finding 12); now a hard out-of-scope, roster-only criterion.
- A4 (AGENT_KEYS) — CONFIRMED as a release blocker (finding 11), not an anchor nit; line numbers marked
  approximate.
- A5 (rehydrate skips declared) — CONFIRMED + extended by finding 13: restart ordering (config ownership
  before ledger rehydrate; rehydrate never invents ownership).

Dueto-only findings folded: multi-owner rejection (9), kind-check as criterion (10), YAML writes only the
canonical parent-side field (7), deep-tree rejection makes direct-cycle sufficient (15), subagents stays on
AgentDef for display/round-trip only (14), criterion-3 split into config-ownership-exists + spawn-provenance
-is-actor (5). Nothing rebutted — in a schema/identity spec the probe's strictness is the deliverable, and
it caught the exact "planned outside context" collision the maintainer flagged.

## Implementation notes

### 2026-07-04 — T1/T3 plus roster metadata shell shipped mechanically; T2 blocked by file collision

`subagents:` now parses on `kind: agent` entries and remains parent-side config data for display/YAML
round-trip. `parseConfig` derives `config.declaredOwner` as child -> owner metadata and validates dangling,
terminal-kind, multi-owner, self-ref, direct-cycle, and deep-tree refs with named `agents.<owner>.subagents`
errors.

The pending `AgentManager.list()` hunk surfaces `declaredOwner` from config only. Runtime lineage remains
`parent` from spawn actor/ledger; `parentOf`, `liveDescendants`, `rehydrateFromLedger`, and death-poke code
were not wired to ownership metadata. The owner != actor regression exists in the worktree in
`test/unit/agentManager.test.ts`, but both files are intentionally uncommitted until the unrelated
`isolate: "transcript"` WIP in `AgentManager.ts` is resolved.

`list_agents` will inherit `declaredOwner` from `manager.list()` once T2 lands; its description now names the
separate runtime parent vs declared owner fields. The sidebar VM carries `declaredOwner`; rendering shows
"owned by <agent>" without changing parent-based grouping.

Commit note: `src/agents/AgentManager.ts` and `test/unit/agentManager.test.ts` had pre-existing WIP from
another agent before this implementation. `declaredSub` notified `claude`; per the coordinator instruction,
those two files are not committed for now. Committed 352 slices: `f3da6bf` (T1/T3 config parsing +
round-trip tests) and `34b75e0` (T4 tools/VM/sidebar metadata shell).

## Verification log

### 2026-07-04T19:51Z — pass

- `npm test -- --run test/unit/config.test.ts test/unit/yamlEditor.test.ts test/unit/agentManager.test.ts test/unit/agentModel.test.ts` — pass (259 tests)
- `git diff --check` — pass

### 2026-07-04T19:52Z — pass

- `npm run typecheck` — pass (`tsc --noEmit`, `tsc -p tsconfig.webview.json`, `tsc -p tsconfig.browser-test.json`)

### 2026-07-04T19:52Z — pass

- `npm test` — pass (181 files, 2561 tests passed, 3 skipped)

### 2026-07-04T19:52Z — pass

- Golden-rule grep: `rg -n "declaredOwner" src/agents/AgentManager.ts src/bridge src/config src/sidebar src/webview -g '!src/webview/AgentForm.ts' | rg -v "ManagedEntryInfo|list\\(\\)|config\\?\\.declaredOwner|loadConfig|agentModel|types|sidebar/App|tools.ts"` — only the `ManagedEntryInfo` field remained after the allowlist filter; no `declaredOwner` reference in runtime lineage machinery.

### 2026-07-04T19:54:15Z — fail (1/2) — source: tasks.md
- `npm test -- --run test/unit/loadConfig.test.ts test/unit/agentManager.test.ts` — pass
- `npm run typecheck` — fail

## Dogfood log

### 2026-07-04T19:54:43Z — fail (0/1) — source: tasks.md — commit: ee81fc1220e8c1472def72d564e507352dc12cee
- `npm test -- --run test/unit/loadConfig.test.ts -t "subagents"` — fail

### 2026-07-04T19:54:56Z — pass (1/1) — source: tasks.md — commit: ee81fc1220e8c1472def72d564e507352dc12cee
- `npm test -- --run test/unit/config.test.ts -t "subagents"` — pass
