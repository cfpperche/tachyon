# 371 — governed-release-boundary — tasks

_Decomposed 2026-07-10 from `plan.md` (dueto-hardened: 1 BLOCKER + 8 MAJOR + 1 MINOR folded). Tier A (audit-only) per the ratified OQ-0. Each phase is a delegated, gated ad-hoc — Fable does not implement._

**Verify:** `npm run verify:full`

> **Shipping rule (from the plan's dueto hardening):** P1–P3 build a **"governed broker path"**, never a
> "release boundary" — a real boundary needs the Phase-4 off-machine consumer gate. **P2 and P3 ship
> together** (P2 alone is an outward capability that can never fire — dormant scaffolding that would read
> as false protection). The no-overclaim contract lands in **P1** and is required in every partial ship.

## Phase 1 — artifact provenance + the no-overclaim contract

_Cheap, independently useful (provenance is valuable even with no outward action), unblocks everything._

- [ ] **T1.1** — Add `src/artifactProvenance/` with the record shape + host-compute helpers: full sha256 of the file, `git rev-parse HEAD` + `HEAD^{tree}`, `workingTreeClean` from `git status --porcelain` + a bounded dirty summary, and a reader for `.tachyon/verifications/<refSha>.json` (the verify_task record: `verdict`, `integrityHash`, `refSha`).
- [ ] **T1.2** — Stage the artifact bytes into the spec-274 managed content-addressed store (`src/worktree/evidenceArtifacts.ts`). **Store writes are atomic create-if-absent; symlinks and non-regular files are REJECTED; no overwrite of an existing digest.** (Dueto BLOCKER: content-addressed naming does not make bytes immutable.)
- [ ] **T1.3** — Add the `record_artifact_provenance` Bridge tool in `src/bridge/tools.ts`. The caller supplies ONLY a traversal-checked worktree-relative path + an optional summary. The HOST stamps everything trust-bearing: full digest, commit, treeSha, clean flag, verification record, and `producedBy` = the Bridge-resolved caller (spec 351). **No hash/commit/producer params exist** — forgery is impossible by construction, not by validation.
- [ ] **T1.4** — Emit the record as a first-class `artifact-provenance` evidence kind on the spec-273 channel (append-safe, host-stamped id/time/commit, never a gate).
- [ ] **T1.5 (no-overclaim contract)** — Add the test that FAILS if any doc/UI/tool-description string claims Tachyon *prevents* unauthorized shipping while the Tier-E isolation conformance check is absent. This test is required in every partial ship from here on.
- [ ] **T1.6** — Behavior test: a caller-supplied digest/commit is impossible (no such param); the record links the verification when one exists for the commit and records `verification: none` when it does not; a dirty tree records `workingTreeClean:false` + the bounded summary.

## Phase 2 + 3 — outward capability class + approval binding (SHIP TOGETHER)

_P2 alone is inert. Do not release P2 without P3._

### Config + catalog

- [ ] **T2.1** — Build-pinned `src/host-action/outwardCatalog.ts`: the FIXED template set. v1 hard-gate templates (clean full-digest binding): `npm-publish` (packed tarball), `vsix-install`, `generic-upload`. Each template declares its executable, wrapper, binding semantics, credential class, **and its host-pinned allowlisted destination origin(s) + account/identity + protocol**.
- [ ] **T2.2** — `docker-push` and the state templates (`kubectl-apply`, `terraform-apply`) are declared **advisory + provenance-recorded, NOT hard-gated** in v1 (a mutable tag / multi-platform index can publish a different graph than approved; a host-computed manifest digest isn't consumer-verifiable). Their promotion to hard-gated is a separate task (T6.x) requiring digest-addressed push + post-push remote-digest verification.
- [ ] **T2.3** — `src/config/loadConfig.ts`: parse + validate `settings.releaseBoundary.outward[]`. An entry SELECTS a catalog template and may only NARROW it (restrict args, pin a destination from the template's allowlist, name a credential ALIAS from the template's declared classes, list allowed agents). An unknown template, an unknown credential alias, a destination outside the template's host-pinned allowlist, or an attempt to WIDEN allowed agents beyond the host-pinned policy → **config error**. The project can never introduce a new executable, interpreter, or credential.
- [ ] **T2.4** — Canonicalize + hash the resolved release config into a **policy digest** that covers the project declaration AND the resolved catalog entry + wrapper + binding semantics + broker policy version. (Dueto MINOR: a Tachyon update can change catalog semantics without touching tachyon.yml — `declarationHash` alone would let an old approval authorize different execution.) Reload + recanonicalize independently at approval AND at dispatch, following includes/symlinks, rejecting duplicate keys.

### Execution port

- [ ] **T3.1** — Add an `OutwardExecutionPort` (broker-owned child-process runner) and wire it into a `HostActionBroker` instance, reusing the existing decision path (caller resolution, closed-schema arg validation, hash-chained audit). `HostActionPort` and its VS Code adapter are untouched.
- [ ] **T3.2 (dueto BLOCKER)** — The child executes against a **file descriptor** of the staged object (opened ONCE by the broker after validating size + full digest), or a broker-created private snapshot — **never re-opened by pathname**. Behavior test: swap/mutate the path between validation and child open → dispatch FAILS.
- [ ] **T3.3** — Materialize the credential (resolved host-side from the catalog alias → keychain / `.tachyon/secrets.env`) into the child's env ONLY, for the duration of a granted+approved action. Never argv, never an agent pane. Document loudly that on a shared-UID host this is custody placement, NOT a boundary (Tier A honesty).

### Approval binding + broker preconditions

- [ ] **T4.1** — Extend the approval payload (`src/bridge/approvalRequest.ts`) to embed the provenance snapshot VERBATIM: artifact name, **FULL 256-bit digest** (a short form may be display-only, with an unambiguous full expansion), commit, verification verdict, clean/DIRTY, **resolved destination origin + account/identity**, wrapper version, normalized args, and the policy digest. `payloadHash` already makes it tamper-evident. Resolution stays HOST-SIDE ONLY (no new Bridge surface — anti-laundering rule untouched).
- [ ] **T4.2** — Broker precondition: the caller MUST be an agent-token-resolved principal. **Reject legacy/self-declared callers on approval creation AND on dispatch** (mirror `StaticHostActionPolicy`'s existing non-agent rejection onto the approval requester-match).
- [ ] **T4.3** — Broker precondition: an integrity-valid verification record with `verdict:accept` whose `refSha === provenance.commit` MUST exist (the broker reads it itself — evidence stays non-gating). Absent / failed / stale / wrong-refSha / tampered-integrityHash → denied. A `break-glass` capability is separate, with its own audit class and a louder approval.
- [ ] **T4.4** — Broker precondition: the approved FULL digest equals the staged object's digest at dispatch; destination/identity/args/policy-digest all match the approval. Any drift → denied.
- [ ] **T4.5 (dueto MAJOR)** — Single-use = a **host-owned durable compare-and-swap** keyed by (approvalId, full payloadHash): explicit states `claimed → launching → launched → outcome`, transactional persist + fsync BEFORE launch, uniqueness enforced. Crash recovery is defined: a claim with no recorded launch/outcome is **terminal-indeterminate and never auto-replayable**. Retry = a NEW approval unless the template proves idempotency via a destination operation id.
- [ ] **T4.6 (dueto MAJOR)** — `dirtyArtifacts: refuse` is the DEFAULT. The exception is `allow-with-manifest`: a **closed-schema, host-computed manifest** of every relevant path + digest (incl. untracked/ignored/submodule state), staged BEFORE approval and bound verbatim into it, under a distinct approval reason + audit class. **There is no boolean dirty override** and no plain `warn`.
- [ ] **T4.7** — Behavior tests, each a forcing function: no-approval → denied · resolved-DENIED → denied · digest mismatch → denied · consumed twice / two concurrent dispatches → exactly one claims, the other denied · broker restart at each claim state → no replay · verification absent/failed/stale/wrong-refSha → denied · legacy-caller spoof through every Bridge entry point → rejected · dirty without manifest → refused · policy digest changed between approval and dispatch → denied.
- [ ] **T4.8** — Audit + UI inventory the known raw bypass paths (the governed path is one route; the shell still exists). No string implies the raw path is closed.

## Phase 4 — the off-machine consumer gate (where a REAL boundary begins)

- [ ] **T5.1** — Reference consumer gates: registry admission webhook / protected-CI release identity / cluster admission / immutable-digest allowlist that REJECT an artifact whose digest is absent from recorded provenance.
- [ ] **T5.2 (dueto MAJOR)** — The e2e must traverse ONE supported outward template through its **actual destination class + protected release identity** — a synthetic webhook that rejects an unrecorded digest while production stays unguarded is formally green and operationally vacuous. Demonstrate: the real consumer REJECTS the unrecorded digest and ACCEPTS the recorded one.
- [ ] **T5.3** — Record explicitly which destinations remain advisory (no consumer gate) — that list is the honest scope of the boundary.
- [ ] **T5.4** — Declare the dogfood command in this file (`**Dogfood:** <cmd>`) once the e2e exists.

## Phase 5 — Tier E isolation conformance (DEFERRED — design only)

- [ ] **T6.1** — Define (do not build) the conformance check: the agent principal cannot read the broker's filesystem, process env, `/proc`, credential-helper sockets, or keychain, before/during/after dispatch. Until it PASSES, the credential-custody criterion is **SKIPPED, never silently passed**, and the no-overclaim test (T1.5) keeps the "prevents" claim off.
- [ ] **T6.2** — Promote `docker-push` / state templates to hard-gated (digest-addressed push, locked manifest/index graph, post-push remote-digest verification, constrained destination).

## Visual QA

**Visual QA Opt-Out:** this spec is Bridge/broker/config plumbing with no rendered surface of its own; the only human-facing surface is the approval payload, whose verbatim-rendering contract is already covered by the t-7d8bdf approval view and asserted by T4.1's behavior test.
