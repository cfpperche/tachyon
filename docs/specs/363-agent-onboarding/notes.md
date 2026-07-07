# 363 — agent-onboarding — notes

_Created 2026-07-07. Phase 1 build + measurement record._

## Phase 1 build (T1-T3, runtime-alternation experiment ordered by the maintainer)

- **T1 doorbell witness (SONNET, fd899d6 net)** — Bridge appends notify_agent events to
  `.tachyon/doorbells.jsonl` (source tree, tamper-resistant); verifyTask findings gain
  `blocking?: boolean` (reviewer traced all 14 push sites byte-identical); non-blocking
  `protocol_doorbell_missed`. Reviewer informational worth keeping: the security ceiling is STRONGER
  than documented — per-agent minted tokens hard-reject spoofed identities (`caller_mismatch`); only
  legacy-token callers get the weak self-declared guarantee. Proven live the same hour: the
  coordinator's direct MCP client was rejected claiming `parent:"claude"` on the legacy token and
  switched to `TACHYON_AGENT_BRIDGE_TOKEN`.
- **T2 canonical stub (CODEX, be512a6 net)** — gated spawn commits a stub test with the exact
  behaviorTest title on the task branch; record gains `stubPath` (auto-owned); blocking
  `behavior_test_renamed` on tamper. DELIVERED DESIGN DEVIATION (kept — better than contracted):
  baseSha is recorded as the STUB COMMIT itself, so the base leg executes the stub's failing body —
  a real behavioral fail-at-base instead of "no test found", and the container's commit stays out of
  the agent's attributable diff.
- **T3 primer + before-finishing (SONNET, 29fc361 net)** — one pure renderer → `── TACHYON PRIMER ──`
  (~30-line budget, tested constant) at brief top + `── BEFORE FINISHING ──` (≤8 lines) at brief END
  (recency), wired into spawn/restart/resume/re-anchor, declared AND ad-hoc, always-full. Reviewer
  non-blocking findings: (1) restart/resume/re-anchor read "latest record by mtime" — a name reused
  across a gated→ungated transition shows a stale gate reminder; remedy when it matters: check
  record.taskRef against the current worktree branch. (2) single-source overclaim: the primer reads
  the in-memory file-watched config (arguably better than the claimed loadVerifySettings disk read) —
  doc-level. (3) budget counts lines, not bytes.
- **Hotfix (0b2e493, ungated — bootstrap: the gate can't verify a fix to its own false positive)** —
  first live delegation exposed that collectVitestNames only kept vitest `fullName`
  ("describe > title") so the bare canonical title never matched → bogus `behavior_test_renamed` for
  every stub (which the generated describe wrapper guarantees). Fix collects title too + regression.
  Also settled VERIFIER_VERSION to "363-phase1" (T2 had promised a bump and silently didn't — the
  drop-a-contract-item pattern struck the version string twice).

## T4 measurement — before vs after (the numbers)

**Before (prose-only era, 7 gated deliveries):**
- Exact behavior-test name honored: **0/7** (4 codex + 3 Sonnet; warnings escalated each contract; one
  title was re-sent in a dedicated notify and still renamed). Every delivery needed a surgical
  rename-fixer round (+~5 min, +1 spawn each).
- Completion doorbell rung: 4/6 (2 skipped entirely; 1 rang with `to:"delegator"` as a literal role
  word).
- One ~5KB brief TRUNCATED mid-done_when (t-11a2d1) — agent flagged and proceeded on stated
  assumptions.

**After (first delivery through the full machinery — apiErrAttn, codex, t-bd638d):**
- Rename: **impossible by construction** — stub committed by the container (`tachyon setup:` commit),
  title intact at delivery, `behavior_test_renamed` guarding tampering. Zero fixer rounds.
- Doorbell: **rung and Bridge-witnessed** (zero `protocol_doorbell_missed`).
- Contract: **lean** (3-line constraints; protocol carried by primer + before-finishing — both
  confirmed rendered in the live pane, before-finishing carrying the canonical title + doorbell as
  the last lines before execution).
- Final verdict: ACCEPT with ZERO findings, verifierVersion `363-phase1`.

**Runtime ledger (alternation experiment):** exact-name violations are a MODEL-CLASS behavior, not a
vendor quirk (0/7 across both). Sonnet obeys process better unprompted (spontaneous full-suite,
pathspec commits, literal summary lines) but slips on literal parameters (`to:"delegator"`); codex
fails by omission (uncommitted work, skipped doorbells, dropped contract items — the {files} filter
and VERIFIER_VERSION were each dropped twice) but often deviates INTO better designs (no-match JSON
normalization, base-at-stub-commit) — always unexplained, per its minimize-blast-radius defaults.
Both runtimes handle EXPLICIT ambiguity well (scope-wall → journal note; truncated brief → stated
assumptions). Conclusion the spec already drew, now with numbers: enforcement beats prose; prose is
for orientation.

## Open / Phase 2

- `orient` pull tool (+ identity note: convenience-never-authority stands; strong tokens make caller
  resolution trustworthy where minted).
- findings-file protocol check; structured notify payload (the 500-char cap).
- t-11a2d1 brief truncation (the lean-contract era shrinks exposure; root cause still open).
- Stale-record-on-name-reuse remedy (taskRef check) if name reuse becomes a pattern.
- Primer effectiveness beyond delivery #1: keep counting doorbell/blocker rates in verification
  records (free telemetry) before hardening doorbell to blocking.
