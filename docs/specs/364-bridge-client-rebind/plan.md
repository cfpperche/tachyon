# 364 — bridge-client-rebind — plan

_Drafted from `spec.md` on 2026-07-09 (post Codex + Claude folds). The approach, not the steps._

## Approach

Add a **BridgeClientRebindCoordinator** that:

1. Owns durable-ish generation counter in `host.getState/setState` keyed by
   `(workspaceHash, bridgeInstanceId)` (reuse `Workspace.bridgeInstanceId` from 351/359).
2. Stamps **`bound_generation` + `bridge_wired`** on the session ledger at every Tachyon
   spawn/resume that runs `withRuntimeBridge` materialization.
3. After Bridge is ready post-activate (and after `recoverPendingHostActionReload`), bumps
   generation once per listener-ready transition, reconstructs `suspect` from durable ledger +
   running set, and under default `auto` + `graceMs: 0` runs a serial queue:
   **preflight → `expectedDeath` → `stopGracefully` → wait dead → hard kill if needed →
   `resume` → stamp ledger → optional initiator notice**.
4. Audits to a JSONL under globalStorage `host-actions/` sibling or `bridge-client-rebind/audit.jsonl`.

Phase 1 only — no peer Bridge tool.

## Key decisions

- **Coordinator in core (`src/bridge/clientRebind.ts` or `src/workspace/BridgeClientRebind.ts`)** —
  host-agnostic orchestration; uses injected ports: `listRunning`, `stopGracefully`, `resume`,
  `hasSession`, `ledger`, `host state`, `notify`, `deliverNotice`, `expectedDeath.add`. Rejected
  putting logic only in agent-vscode — rebind is engine lifecycle.
- **Ledger fields on `SessionRecord`** — extend with optional
  `bridgeClient?: { boundGeneration: number; wired: boolean }` (names exact in impl; keep
  normalize() tolerant of missing). Rejected pure workspaceState map of bound gens — must survive
  and travel with the session row like resume ids.
- **Stamp site:** every successful path that materializes Bridge via `withRuntimeBridge` and
  completes spawn/resume — centralize a small `stampBridgeClientBinding(name, generation)` called
  from AgentManager after spawn/resume success (Workspace passes current generation getter).
- **Generation bump:** once after `bridge.start` succeeds in `Workspace.create` / activate path;
  also when Bridge usedFallback / re-listen if that code path exists later. Coalesce: one bump per
  successful `bridge.start` in that activate. Teardown-and-relisten same port = new start → new bump.
- **`expectedDeath`:** reuse `Workspace.expectedDeath` Set (already suppresses parent poke on
  deliberate kill) — add agent name before stop in rebind.
- **359 initiator notice:** if `runHostAction` records last reload caller name (or audit), after that
  agent rebinds successfully, `deliverNotice` one line. If caller unknown, skip notice. Do **not**
  forge MCP tool results.
- **Settings:** parse optional `settings.bridgeClientRebind` in `loadConfig.ts` with defaults from
  spec (`auto`, `graceMs: 0`, `stopTimeoutMs: 15000`, `maxConcurrentRebinds: 1`, `circuitFailCount: 3`).
  Missing section = defaults.
- **Wiring predicate:** `rec.bridgeClient?.wired === true` (set only when withRuntimeBridge actually
  applied materialization for that spawn/resume). Not runtime-name heuristics alone.
- **Pre-364:** missing `bridgeClient.boundGeneration` ⇒ 0.

## Files touched

| File | Change |
|------|--------|
| `src/resume/SessionLedger.ts` | Optional `bridgeClient` on `SessionRecord`; normalize pass-through |
| `src/bridge/clientRebind.ts` **NEW** | Coordinator: generation, mark, queue, preflight, lifecycle, audit, circuit |
| `src/workspace/Workspace.ts` | Wire coordinator after Bridge ready; pass ports; expectedDeath; initiator notice hook from runHostAction if feasible |
| `src/agents/AgentManager.ts` | After successful spawn/resume with Bridge materialization, stamp ledger `bridgeClient`; optional callback `onBridgeWiredSpawn` |
| `src/config/loadConfig.ts` (+ schema if present) | Optional `settings.bridgeClientRebind` |
| `test/unit/bridgeClientRebind.test.ts` **NEW** | Unit tests for generation, stamp, reconstruct, preflight, queue, circuit |
| `test/unit/sessionLedger` or existing ledger tests | Normalize/roundtrip `bridgeClient` |
| `docs/specs/364-…/notes.md` | Deviations while building |

## Risks & unknowns

- **Stamp timing:** spawn is async; must stamp only after session is actually running with wiring.
- **resume() kills live session:** coordinator must stop first per spec; do not skip to resume-only.
- **Hard kill + corrupt transcript:** fail closed (stopped + audit) — already in spec.
- **Autostart race:** agents still spawning at mark time — only RUNNING at mark; late starts stamp
  current gen and stay ok.
- **Grok dogfood** requires VSIX install + reload — unit tests first, human dogfood gate for live MCP.

## Visual impact

None required (Phase 1). Optional toast on failure via existing `host.notify`.

**Visual QA Opt-Out:** lifecycle/Bridge only.

## Sources consulted

`spec.md` (Claude fold) · `SessionLedger.ts` · `Workspace` expectedDeath + bridge.start +
recoverPendingHostActionReload · `AgentManager` stopGracefully/resume/withRuntimeBridge ·
`deliverNotice` · host-action audit sibling under globalStorage · loadConfig settings parse pattern.
