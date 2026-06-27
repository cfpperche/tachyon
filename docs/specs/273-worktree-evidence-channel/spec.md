# 273 — worktree-evidence-channel

_Created 2026-06-27._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

> **Origin (2026-06-27):** a "should Tachyon ship task-quality governance?" investigation concluded NO — the
> verify-gate is already project-extensible via runbooks, so pass/fail discipline is project-owned (no core). The
> ONE core-worthy gap, validated by codex against live code (CONFIRMED-WITH-CAVEATS): the verify-gate output is
> strictly BINARY, so there is no home for NON-BINARY evidence. This spec ships that one neutral primitive — the
> channel, NOT the governance.
>
> **Codex design dueto (2026-06-27) — SHIP-WITH-CHANGES, folded** (`…20260627T163131Z-…`): neutral `data` payload +
> `schemaVersion`; append-safe persistence (no racy array RMW); per-step dedup via `verifyRunId`; Tachyon-managed
> artifact dir; evidence staleness keyed to HEAD only (not dirty); mechanical summary (no privileged "judgment");
> simple caps over ambiguous pruning. **Build-time divergence (honest):** Codex's "host-DERIVED producer
> (anti-forgery)" is NOT implementable — the bridge has no connection-bound identity, so `producer` is self-declared
> (provenance, like every other bridge `caller`); host-stamped fields (id/time/commit) stay unforgeable.

## Intent

Add a **neutral worktree EVIDENCE channel**: structured, non-binary evidence records attached to a worktree agent
(keyed to a commit, with staleness), surfaced to parent agents over the bridge and minimally in the UI —
**distinct from, and never replacing, the binary verify badge.**

This is **engine + format, not governance.** Tachyon defines the RECORD FORMAT; it does NOT define what quality
means, ship lint/TDD/visual-QA policy, or enforce anything. Producers (Tachyon's verify run, agents via the bridge,
plugins) fill the channel; consumers (parent agents, the UI) read it. The format subsumes today's homeless
evidence: non-binary advisories, per-step results, artifact refs, severities, durable notes.

**Why now / demand:** `Workspace.runVerify` (`src/workspace/Workspace.ts:1425-1429`) computes `RunbookJob.steps`
(`StepResult[]`) then throws it away — only `passed` survives into `VerifyState`. And the strongest demand driver,
**Visual QA** (a reviewer agent driving `agent-browser`, producing screenshots + a model verdict), cannot honestly
be `passed: boolean`. Both land in this one channel.

## The record format (neutral)

```ts
type Severity = "info" | "warn" | "error";   // advisory ONLY — never a hard gate

interface WorktreeEvidence {
  schemaVersion: 1;        // forward-compat; bump only on a breaking shape change
  id: string;              // unique within the agent's evidence log
  targetAgent: string;     // the worktree agent the evidence is ABOUT
  producer: string;        // SELF-DECLARED by the caller (the bridge has no connection-bound identity) — provenance, not auth (see below)
  onBehalfOf?: string;     // optional: a sub-context the producer acted for
  sourceRunId?: string;    // optional: the run/verify id that produced it
  atCommit: string;        // worktree HEAD when produced → HEAD-only staleness
  worktreeDirtyAtProduction?: boolean;  // recorded, NOT used to auto-stale (informational)
  producedAt: string;      // ISO timestamp
  kind: string;            // NEUTRAL label ("step-result" | "advisory" | "judgment" | "artifact" | …); Tachyon does NOT police the vocabulary
  severity: Severity;
  summary: string;         // one-line, human/agent-readable
  detail?: string;         // optional durable text/log
  data?: Record<string, unknown>;  // NEUTRAL structured payload (e.g. per-step {index,step,cmd,exitCode,durationMs,state})
  artifacts?: string[];    // refs into the Tachyon-managed evidence artifact dir (see Artifacts)
}
```

- **Staleness — HEAD only (diverges from verify on purpose).** Evidence is stale when the worktree HEAD moved past
  `atCommit`. It does NOT use verify's `dirty` rule — unrelated uncommitted files must not silently stale a visual
  judgment. (`worktreeDirtyAtProduction` is recorded for context, not used to invalidate.)
- **Producer is SELF-DECLARED (reality of the bridge architecture).** The design preference was a host-derived,
  unforgeable `producer` — but the Tachyon bridge has NO connection-bound identity: EVERY tool takes a self-declared
  `caller`/`agent` param (provenance/lineage, explicitly "not authentication"; only nonce-gated ops like
  `complete_node` authenticate). So `attach_evidence`'s `producer` follows that same model — self-declared
  provenance, not auth. What IS server-controlled and unforgeable: `id`, `producedAt`, `atCommit`, `schemaVersion`
  (the host stamps them). A truly-attributable producer would need a bridge-wide identity primitive — out of scope
  (and not unique to evidence).
- **Persistence is append-safe, never a racy array RMW.** Concurrent producers must not lose writes: the host
  exposes an ATOMIC append (or an append-only per-agent jsonl with compaction). Bridge handlers never mutate a
  ledger array directly.
- **Bounded by simple caps (not ambiguous pruning).** Max 100 records/agent; the per-step verify set is replaced
  (not appended) per `verifyRunId` and capped at ~20 steps. No "prune long-superseded commits" heuristic in v1.
- **Artifacts live in a Tachyon-managed evidence dir** (e.g. `.tachyon/evidence/<agent>/<id>/…`), referenced by
  ref, not blobs in the record. A missing artifact (worktree rebuilt/cleaned) is surfaced cleanly as missing, never
  a crash. (No blob store; just a managed dir so a Visual-QA screenshot survives a worktree refresh.)
- **NEVER a gate.** The binary verify badge stays the gate a parent gates on. `severity:"error"` INFORMS; it does
  not block.

## Producers (v1)

1. **Built-in: per-step verify evidence (closes the confirmed sub-gap; zero project opt-in).** After
   `runbookRunner.runSteps`, `runVerify` records ONE `kind:"step-result"` evidence record per `StepResult` into
   `data` (`index/step/cmd/exitCode/durationMs/state`), stamped with a `verifyRunId` and `atCommit`. A re-run at the
   same commit REPLACES the prior verify step-set for that agent (keyed by `verifyRunId`/agent) — no pile-up.
2. **Bridge: `attach_evidence`** — a worktree agent (or a plugin hook) attaches an evidence record (target + kind +
   severity + summary + detail + data + artifacts + a self-declared `producer`). Unblocks **Visual QA** (a reviewer
   agent attaches `kind:"judgment"` + screenshot artifact refs) and any future producer, WITHOUT Tachyon shipping
   the producer.

## Consumers / read surfaces (v1)

- **Bridge: `list_evidence(agent)`** — the agent's records, each flagged fresh/stale; semantic filtering
  (by kind/severity) is the caller's job here.
- **Compact, MECHANICAL summary folded into `verify_agent`/`list_agents`** — total, fresh/stale counts, counts by
  severity, and the latest N record summaries. NO privileged "judgment" semantic (that would reintroduce opinion).
  The binary `passed`/`stale` fields are unchanged; evidence is additive.
- **Minimal UI:** an evidence COUNT + stale indicator on the worktree agent badge (reuse its hover); optionally the
  latest summary line. No dedicated panel/artifact preview in v1.

## Acceptance criteria

- [ ] **Neutral format, never a gate:** a record carries schemaVersion/kind/severity/summary/data/artifacts;
  recording one (even `severity:"error"`) never changes the verify badge or blocks anything.
- [ ] **Self-declared producer + host-stamped trust fields:** `attach_evidence` accepts a self-declared `producer`
  (bridge has no connection identity — provenance, not auth); the host stamps id/producedAt/atCommit/schemaVersion
  (unforgeable); `targetAgent` is separate from `producer`.
- [ ] **Per-step evidence, deduped:** a multi-step verify run records one `step-result` record per step (in `data`)
  at the run's commit with a `verifyRunId`; a re-run at the same commit REPLACES (does not append) the set; the
  rollup boolean is unchanged.
- [ ] **Concurrent append safety:** two producers attaching concurrently both persist (no lost write) — proven by a
  test against the atomic/append path.
- [ ] **HEAD-only staleness:** after the worktree HEAD moves, prior evidence reads stale; an unrelated dirty file
  does NOT stale evidence.
- [ ] **Artifact handling:** an artifact ref resolves from the managed dir; a path-traversal ref is rejected; a
  missing artifact (post-rebuild) surfaces as missing, not a crash.
- [ ] **Bounded:** caps enforced (≤100/agent; verify step-set replaced + capped); no unbounded growth.
- [ ] **Mechanical summary:** `verify_agent` exposes neutral counts (+ latest N summaries), no special-cased kind.
- [ ] **No governance shipped:** core defines only the format + the built-in per-step producer + the
  attach/list/summary surfaces; no lint/TDD/visual policy, no bundled producer beyond surfacing verify's own steps.

## Open questions — RESOLVED (codex leans folded)

- **OQ1 (persistence):** an ATOMIC host append/replace API. If the ledger's current writes aren't serialized, use a
  sibling append-only per-agent jsonl + compaction instead of an array on the ledger record. Decide by inspecting
  the ledger write path at build; never a racy RMW.
- **OQ2 (attach scope/trust):** any bridge-connected agent/plugin may attach to any `targetAgent`. `producer` is
  SELF-DECLARED (the bridge has no connection identity — see § Producer); the host stamps the unforgeable fields
  (id/producedAt/atCommit/schemaVersion). `onBehalfOf`/`sourceRunId` recorded if given.
- **OQ3 (artifacts):** a Tachyon-managed evidence artifact dir (Visual QA is the driver → durability matters); refs
  validated against path traversal; missing surfaced cleanly. No blob store.
- **OQ4 (summary):** mechanical — total + fresh/stale + counts-by-severity + latest N summaries. No "latest
  judgment". Full/semantic filtering via `list_evidence`.
- **OQ5 (UI):** count + stale indicator on the existing badge (+ optional latest summary line); no panel in v1.

## Notes

LAST core primitive before retiring the source harness. Scope: the channel + built-in per-step producer +
attach/list/summary + minimal surfacing. OUT: governance, specific producers (Visual QA flow, TDD, lint summary —
downstream plugins/agents), a blob store, hard-gating, ambiguous pruning.
