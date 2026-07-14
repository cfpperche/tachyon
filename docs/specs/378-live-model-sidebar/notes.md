# 378 — live-model-sidebar — notes

_Created 2026-07-13._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- **Divergence compares LABELS, not raw ids.** `resolveModelFact` normalizes both declared and observed
  through the same `labelModel`/`modelLabelForRuntime` alias table and compares the resulting strings, rather
  than comparing raw ids directly. This is what makes the flagship motivating bug (bare `codex` declared
  "Codex default" vs observed `gpt-5.6-sol`) correctly read as divergent — comparing raw ids would need a
  separate "what would this bare command resolve to" id, which doesn't exist as a concept (a bare runtime has
  no declared id, only a profile-default label).
- **All precedence/label/divergence logic lives in `sidebar/agentModel.ts`, not `runtimeOps/model.ts`.**
  `runtimeOps/snapshotService.ts` already imports `modelFromCommand` from `sidebar/agentModel.ts` (existing
  dependency direction). Putting `resolveModelFact`/`declaredModelFromCommand`/`validatedObservedModelId`
  there too (rather than in `runtimeOps/model.ts`, which would need to import back from sidebar) avoids an
  ESM import cycle. `runtimeOps/snapshotService.ts` calls `resolveModelFact` directly to build the snapshot's
  `modelObserved`/`modelDivergence` fields — same function the sidebar mapper uses, so the two consumers can
  never disagree on precedence.
- **`observedModelFor` returns the raw fact, not the resolved label.** The view-independent accessor
  (`RuntimeOpsSnapshotService.observedModelFor`) returns `{id, effort, observedAt, stale}` — mechanical
  projection-latch state only. `SidebarPrototype.ts`'s `gatherOne()` passes that straight through as
  `AgentExtras.model`; `toAgentVM` is where `resolveModelFact` actually runs. This keeps precedence in the
  "pure mapper" per the task list, and means the accessor has zero business logic to keep in sync with the
  RuntimeOps snapshot path.
- **`extension.ts`'s onAppended keeps calling `runtimeOps.refresh()` unchanged, additively.** The new
  model-fact-tuple-diff + `sidebarProto.refresh()` logic is added alongside the pre-existing
  `runtimeOps.refresh()` call, not instead of it — the existing "RuntimeOps panel live-updates while open"
  behavior must not regress.

## Deviations

- None from `plan.md`'s Key decisions — the boundary-reason set (`restarted`/`started`/`forked` = rotating;
  everything else, including undefined, = preserving) was derived directly from `logWriter.ts`'s
  `noteLifecycle` call sites in `extension.ts` (`"started"`, `"restarted"`, `"resumed"`, `"forked"`) plus the
  inferred `"new"`/`"resume"` reasons `logWriter.ts` emits when no lifecycle action was noted — matches the
  plan's "restarted/started/fork" / "'new' = in-TUI /clear, resumed" wording exactly (plan says "fork"; the
  actual reason string is `"forked"`).

## Tradeoffs

- **RuntimeOps table's own Model column stays declared-only** (non-goal, honored as-is) — `projectModel()` /
  `RuntimeOpsModelV1` / the webview's `<Model>` component are untouched. The observed+divergence fact is
  exposed on `RuntimeOpsAgentRefV1.modelObserved`/`.modelDivergence` (new, additive fields) for agent/API
  consumers and for the RuntimeOps-panel-follow-up spec to pick up later without another snapshot-shape
  change.
- **The charset/length validation gate is applied twice** — once on the raw observed id in
  `sidebar/agentModel.ts` (`validatedObservedModelId`, gates before labeling) and once on the resulting label
  string in `runtimeOps/model.ts` (`normalizeObservedModel`, gates the cross-module protocol boundary). This
  is deliberate defensive-in-depth matching the codebase's existing pattern (every `RuntimeOpsAgentInput`
  field is treated as untrusted `unknown` at that boundary, even fields the host itself produces) rather than
  trusting a single validation point.

## Open questions

- None new. The spec's own open questions (codex 0.144 live `/model` emission per-turn; grok
  switch-forces-new-session semantics) are unchanged by this implementation — they're live-dogfood
  confirmations, not implementation blockers, and the code degrades honestly either way (per-turn latency is
  timestamped via `observedAt`; grok's `summary.json` was explicitly out of scope for this spec).

## Dogfood log

### 2026-07-14T12:50:01Z — fail (0/1) — source: tasks.md — commit: 3a09f51a73ef1b8d28581f496ab2fd9cd3ed9c59
- `npx vitest run test/unit/liveModelBehavior.gen.test.ts` — fail

### 2026-07-14T12:50:28Z — pass (1/1) — source: tasks.md — commit: 3a09f51a73ef1b8d28581f496ab2fd9cd3ed9c59
- `npx vitest run test/unit/livemodel2Behavior.gen.test.ts` — pass
