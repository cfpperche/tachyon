# 211 — tachyon-adhoc-persistence — notes

## Origin
Surfaced while dogfooding spec 210's review: the maintainer spawned a codex
sub-agent via MCP (`specrev`), saw the "ad-hoc, not in tachyon.yml" toast, and
asked "isn't that a bug? do I lose it on reopen?". Code investigation (2026-06-13):

- **Not a bug that ad-hoc isn't in `tachyon.yml`** — by design (transient
  delegations must not pollute/commit the shared config).
- **Not truly lost:** `AgentManager.spawn` already records AI ad-hoc agents in the
  ledger with `cmd`+`sessionId`; window reopen → `planResume` **reattaches** the
  live tmux session; full restart → **offers** resume from the ledger.
- **Two real gaps + one affordance** (this spec):
  1. Re-discovered ad-hoc isn't restartable — `adhoc` map not rehydrated from the
     ledger (the cmd is right there). `AgentManager` comment even says the ad-hoc
     def "does not survive an extension restart by design" — 211 makes it survive
     via the ledger without touching `tachyon.yml`.
  2. Lineage (`parent`) isn't persisted — ledger has no `parent` field → orphaned
     after restart.
  3. No "Save to tachyon.yml" path to keep a useful ad-hoc agent.

## Design stance
- The fix persists ad-hoc **definitions** in the **ledger** (machine-local,
  gitignored), NOT in `tachyon.yml`. So the "ad-hoc ≠ committed config" contract is
  preserved; promotion to declared stays an explicit one-click action.
- Decouples **def-persistence** (every ad-hoc, incl. non-AI `sh`) from **resume**
  (only adapter-backed runtimes) — today they're conflated (only AI ad-hoc is
  recorded at all), which is why a `sh` ad-hoc loses everything.
- Relationship: closes spec 209 (resume) residuals (the ad-hoc OFFER path was
  "unit-tested, not exercised live") and the restartability gap. Independent of
  spec 210 (worktrees).

## Open questions — RESOLVED by the review
- **Promoted entry:** adapter-backed → flip `declared:true` (keep for resume);
  def-only → remove the row after the yml write. (codex)
- **One ledger store vs a separate `.tachyon/adhoc.json`:** keep ONE store — the
  ledger already keys by agent; a second file invites drift. (codex agreed.)

## Review — codex GPT-5.5 (xhigh), 2026-06-13 — INCORPORATED
Spawned via Tachyon (`specrev2`, dogfood); verdict **revise**. It grepped the real
code and caught issues a prose-only read would miss. Accepted + folded in:
- **The central catch:** `planResume` + the Sidebar treat EVERY ledger row as
  resumable today, so def-only `sh` rows would falsely show as resumable. → schema
  **def/resume split** + an `isResumable` predicate that all resume paths filter on.
- **Factual correction to my plan:** kill does NOT remove the ledger row today (only
  the in-memory maps) → def-only rows would resurrect. → kill/dismiss now removes the
  row.
- **`restart` leaves a stale `sessionId`** (bypasses resume bookkeeping) → refresh the
  resume block on adapter-backed restart.
- **Declared-vs-ad-hoc from current config**, not just `record.declared` (avoid a
  promoted-name shadow).
- **Promote leaked an absolute cwd** into the committed yml + **`addAgent` doesn't
  support `instructions`** → write no abs cwd, extend addAgent.
- **Record only after a successful spawn** (no phantom rows).
- **Rename must rewrite children's persisted `parent`** + self-parent guard.

**Downscoped (my call, not the review's):** multi-node lineage cycle detection — near-
impossible to form via spawn-time `parent`; only the self-parent guard is kept, and
render-time orphan-promotion already covers a missing parent.

Two codex reviews on two specs (210, 211) each found real, code-verified holes —
the dogfood loop is paying for itself.
