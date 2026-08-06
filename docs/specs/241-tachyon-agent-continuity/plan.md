# Plan 241 — per-agent continuity

**Status:** shipped · **Follows:** `spec.md` (debated) + `debate.md`

Thin layer over existing primitives + one owned artifact (the brief). Decision logic lives in PURE,
node-tested modules (the spec-240 "logic in the vscode layer escapes CI" lesson); the engine wiring only
gathers inputs + performs side effects.

## Modules
- `src/continuity/ContinuityStore.ts` — the brief file (`.tachyon/continuity/<agent>.md`): YAML frontmatter (Tachyon-owned) + markdown body (agent-authored), atomic write, soft size cap (D7), malformed-frontmatter rejection, unknown-field preservation (D7/D8).
- `src/continuity/ContinuityState.ts` — Tachyon-owned discontinuity sidecar (`<agent>.state.json`, D9): `discontinuitySinceRestore`, `lastDiscontinuitySeq/RestoreSeq`, `lastNudgeAt`, `lastSeenTransitions`.
- `src/continuity/classifier.ts` — PURE `classifyInjection` (D3) + `injectionText` (D4) + `reminderText` (OQ1).

## Increments (all shipped)
- **A** — ContinuityStore + write contract (D7) + Bridge tools `get/set/continuity_status` (D2); wired into Workspace + BridgeDeps.
- **B** — discontinuity state model (D9) + injection classifier (D3); idle-hook detection (compaction via `onCompaction`; `/clear`/restart/external via the activity writer's `transitions` counter; clean resume → no bump → no inject).
- **C** — freshness (D4, exact lag from durable-log line count) + nudges (D5/OQ1, cooldown, proactive idle checkpoint reminder) + cold start (OQ3).
- **D** — sidebar badge fresh/stale/missing (OQ4) + manual `Tachyon: Re-inject Continuity` command/action + gitignore `.tachyon/continuity/` (D10).
- **E** — fork snapshot `status: paused` (D8) + bounded pre-teardown checkpoint (OQ6) + delete cleanup (D5).

## Verify
`cd /home/goat/tachyon && env -u TMUX npx vitest run`

## Read-path amendment

- Add pure formatting and token-diff helpers under `src/continuity/`.
- Read tasks and pins through existing Bridge dependencies.
- Keep `ContinuityStore` limited to authored data.
- Calculate lag through the existing activity sequence dependency.
- Share one stale threshold with host injection and sidebar status.
- Return drop warnings after successful writes.
- Cover agent tool calls in `test/unit/bridge.test.ts`.

The Interface cannot call these private tools. Agents reach them through Bridge calls. Tachyon reaches stored briefs through injection and sidebar paths. Those host paths remain unchanged.

Rejected: persist the open-work projection. Persisted derived state can drift from tasks and pins.

Rejected: block removals. Agents can remove references intentionally.
