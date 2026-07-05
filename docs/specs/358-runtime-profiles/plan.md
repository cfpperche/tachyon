# 358 — runtime-profiles — plan

_Drafted 2026-07-05 post-dueto. Big system → PHASED. The dueto's core: the profile is a MEASURED,
fingerprinted, mode-parameterized, governed contract where the Bridge enforces INTEGRITY (not correctness).
Each phase is separately shippable and independently valuable._

## Phases

### Phase 1 — Runtime profile scaffold + isolation as a measured property (START HERE)
The concrete, low-risk anchor — codifies what 357 (codex private-home) + 220 (claude uuid+title) already do.
- A runtime-profile module: typed sections, each field carrying `source: measured|declared|assumed` +
  `verified: bool` (dueto findings 5/10). Populate claude + codex with their KNOWN MEASURED values.
- `isolation: mint | private-home | unknown | none` + `verified` (dueto blocker 6). Tachyon GUARANTEES
  per-instance transcript isolation via the profile's mechanism (already true; this DECLARES + centralizes
  it). The Bridge FAILS CLOSED for `unknown/none` in normal delegation (restrict to isolated-harness /
  admin opt-in `unsafe_shared_transcript`).
- Remove the now-redundant `isolate: transcript` CHECKBOX for the collision concern (safe: claude+codex both
  have `verified: true` isolation). "Isolated harness" stays as the stronger opt-in. If a runtime's isolation
  is unverified, the removal does NOT apply (fail-closed, not silent).
Deliverable: the profile module + claude/codex entries + isolation guarantee wired + checkbox removed +
tests. VISUAL: the form loses the checkbox (small; maintainer glance).

### Phase 2 — Contract modes + artifact_policy + auto-injection (the delegation-as-system core)
- `contract_mode: answer_only | review | explore | implement | release` derived from task type; only
  implement/release get DONE_WHEN + FINAL REPORT (dueto majors 2/3/9 — no monolith, no bloat on small tasks).
- `artifact_policy: required_commit | no_commit_expected | optional_patch`; FINAL REPORT accepts
  `commit: none` + enumerated reason; implement requires a hash on HEAD/expected branch (not "exists in git").
- Auto-inject the mode's template into the spawn brief (spec 246) from the profile. Supersedes the
  implementation-runtime-codex memory (which becomes a pointer).

### Phase 3 — Fingerprint + drift detection + profile-smoke (freshness; dueto blocker 4)
- `profile_fingerprint` (runtime, CLI version, tool-schema, sandbox, capture/resume, prompt-contract version).
- Bridge compares live fingerprint at spawn; drift beyond tolerance → `stale` → fail-closed for
  implement/release or drop to conservative contract.
- Automated profile-smoke: synthetic microtasks measuring commit behavior, FINAL-REPORT adherence, isolation
  path, resume — run to DETECT drift; re-interview only when smoke/fingerprint says so.

### Phase 4 — Onboard (interview + empirical probes), Bridge-side integrity verification, governance
- Onboard = interview (candidates) + probes (measured) → activate only after probes pass (dueto blocker 1/5:
  interview is hypothesis, not authority; integrity≠correctness).
- Bridge-side: `update_task(done)` on an implement task validated for INTEGRITY (hash on HEAD, suite result
  present, worktree clean) — marked `reviewable`, never `verified correct`. Structured risk-tied
  `smoke_evidence` (dueto 7).
- Governance: profiles versioned/owned/reviewed; typed sections with `verified_at`/`valid_for_versions`.

## Key decision
Integrity ≠ correctness is the invariant across all phases. The Bridge NEVER claims correctness — it enforces
verifiable delivery artifacts; correctness stays reviewable + task-specific smoke.

## Sources
spec 358 post-dueto (probe 525ea0c8) · 357 (codex private-home) · 220 (claude customTitle) · 246 (delegation
contract) · the implementation-runtime-codex memory (to be superseded) · t-ee7d5f (tracking).
