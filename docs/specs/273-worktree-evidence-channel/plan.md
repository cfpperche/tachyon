# 273 — plan

## Approach

Build the channel bottom-up, testing each layer, then wire producers/consumers. Engine+format only — no governance.

### Layer 1 — the pure store (format + caps + staleness)
- `src/worktree/evidence.ts` — the `WorktreeEvidence` type + pure helpers: `evidenceStale(atCommit, headRef)`
  (HEAD-only, NOT dirty), cap/replace logic (`applyCaps`: ≤100/agent; replace the verify step-set by `verifyRunId`),
  a mechanical `summarize(records, headRef)` (total + fresh/stale + counts-by-severity + latest N). No git, no IO →
  unit-tested like `verify.ts`.

### Layer 2 — persistence (concurrency-safe)
- Inspect the ledger write path first (OQ1). If writes are serialized, add an atomic
  `appendEvidence`/`replaceVerifySet` on the store; else a sibling append-only per-agent jsonl under
  `.tachyon/evidence/<agent>/log.jsonl` + compaction. Never a racy array read-modify-write from bridge handlers.
- The managed artifact dir: `.tachyon/evidence/<agent>/<id>/` ; a ref resolver that rejects path traversal and
  reports missing cleanly.

### Layer 3 — built-in producer (per-step verify)
- In `Workspace.runVerify`, after `runSteps`, write one `step-result` record per `StepResult` (into `data`) stamped
  `verifyRunId` + `atCommit`, REPLACING the prior verify set for that agent. The rollup `VerifyState` is untouched.

### Layer 4 — bridge tools
- `attach_evidence` — caller supplies target/kind/severity/summary/detail/data/artifacts; host DERIVES `producer`
  from the connected identity (reject client `producer`), stamps id/producedAt/schemaVersion, persists via Layer 2.
- `list_evidence(agent)` — returns records flagged fresh/stale.
- Fold a compact MECHANICAL evidence summary into the existing `verify_agent`/`list_agents` (`VerifyHandoff`),
  additive to `passed`/`stale`.

### Layer 5 — minimal UI
- An evidence count + stale indicator on the worktree agent (reuse the verify badge hover); optional latest-summary
  line. No panel.

## Sequencing
L1 (pure + tests) → L2 (persistence + tests) → L3 (producer + test) → L4 (bridge + tests) → L5 (UI) → dogfood +
final codex dueto.

## Risks
- Concurrency (L2) is the trickiest — get the atomic append right or use jsonl.
- Don't let the per-step producer add latency to `runVerify` (write after the run, async-safe).
- Keep the format neutral — resist baking kind-specific behavior anywhere except producers/consumers outside core.
