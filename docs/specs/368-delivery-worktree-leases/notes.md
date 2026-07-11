# 368 — delivery-worktree-leases — notes

_Created 2026-07-10._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

### T0 review mechanism

- `probe-3b090dfe-3706-4fa4-aee1-6bab3034a9fb` — Claude Opus adversarial probe timed out after 120s with no
  result artifact; not accepted as review evidence.
- `probe-03e68304-050b-44d0-a533-e8f3f22126b6` — Codex GPT-5.6 adversarial probe failed in the adapter with
  `Reading additional input from stdin...`; not accepted as review evidence.
- Fallback: temporary ad-hoc `review368`, read-only except for
  `.tachyon/reviews/368-delivery-worktree-leases-adversarial.md`. Production implementation remains gated on
  its review and a post-fold ACCEPT round.

### T0 adversarial findings disposition

Review: `.tachyon/reviews/368-delivery-worktree-leases-adversarial.md` — verdict FINDINGS.

- **F1 HIGH — folded.** Persist PID + process-start + boot/host identity; reload treats unknown as unavailable/
  quarantined and never frees on tmux disappearance alone.
- **F2 HIGH — folded.** `verify_task` exclusion keys on the canonical current holder, not segment zero.
- **F3 HIGH — folded.** Legacy agent-name verification requires exactly one non-archived candidate; mtime selection
  is forbidden.
- **F4 HIGH — folded.** Delivery locks gain provably-dead reclamation and authenticated ambiguous-lock recovery;
  PinStore's timeout-only lock is explicitly insufficient.
- **F5 MEDIUM — folded.** Runtime spawn moves outside locks behind nonce-bound durable `pending` reservation, so
  contenders receive structured occupancy instead of lock timeout.
- **F6 MEDIUM — folded.** Lifecycle authority uses Bridge-resolved/configured principals only; execution/principal/
  GitDelivery display-name equality never grants destructive authority.
- **F7 MEDIUM — folded.** Linked GitDelivery mutations serialize through the Delivery lock and projection transitions
  are idempotently replayable; lease state is not copied into the projection.
- **F8 MEDIUM — folded.** Segment boundaries must be ancestor-linear; rebase/reset blocks verification and import.
- **F9 LOW — folded.** Verification persists restore intent so a clean interrupted temporary checkout can be restored
  automatically; inconsistent state still quarantines.

T0.1 must re-review the folded documents and return ACCEPT before T1 begins.

### T0.1 finding disposition

Review: `.tachyon/reviews/368-delivery-worktree-leases-adversarial-r2.md` — verdict FINDINGS.

- **R2-F1 HIGH — folded.** The prior reserve-then-spawn wording allowed a live predecessor to overlap successor
  boot. Handoff now persists `draining`, stops and proves the predecessor/root process gone, revalidates final Git
  state, and only then closes the prior segment and writes `pending`. Successor spawn stays outside locks. Failed
  spawn cannot implicitly revive the predecessor; a restart is a new segment.

T0.2 must confirm this fence closes the last concurrency gap before T1 begins.

### T0.2 finding disposition

Review: `.tachyon/reviews/368-delivery-worktree-leases-adversarial-r3.md` — verdict FINDINGS.

- **R3-F1 HIGH — folded.** Pane-root death was not a filesystem fence because detached/reparented descendants
  could survive. Every Delivery execution must now launch through `ProcessFencePort`; handoff and crash
  reconciliation share a `proven_empty|survivors|unknown` predicate over the complete containment group plus a
  canonical worktree-bound process audit. Survivors/unknown quarantine and block successor spawn. Unsupported
  hosts report capability unavailable rather than weakening the invariant. A detached-child empirical spike is
  required before production work.

T0.3 must confirm the process-fence contract closes R3-F1 before T1 begins.

### T0.3 closure

Review: `.tachyon/reviews/368-delivery-worktree-leases-adversarial-r4.md` — **ACCEPT**.

The reviewer confirmed the shared tri-state `ProcessFencePort` predicate, whole containment group, independent
canonical-worktree process audit, durable anti-PID-reuse identity, and unsupported-host fail-closed behavior close
R3-F1 without reintroducing a free gap. Architecture review is complete. Production work remains gated only on
the empirical detached-child spike declared as T0.2.

### T0.2 empirical result — PARTIAL

Study: `.tachyon/studies/368-process-fence-spike.md`.

- A PID-namespace init retained/reparented the detached writer and terminating the namespace containment removed
  its members, validating a promising containment core.
- Pane/root PID, process group, and session alone were disproven as fences.
- The independent same-UID global `/proc` audit encountered unreadable entries, so canonical cwd/root/open-FD
  absence cannot be proven on this host. `proveEmpty` must therefore return capability unavailable/`unknown`.
- Sequential same-worktree handoff stays disabled and quarantined; there is no fallback or optimistic downgrade.
- Spike resources were cleaned up. T1 may proceed because it defines only the canonical aggregate/store and does
  not enable handoff. A complete production fence adapter remains a prerequisite for T5-T7 and real dogfood.

## Deviations

### T1 lock protocol redesign — SQLite decision

Five adversarial rounds found successive crash windows in application-managed owner/fence/claim lockfiles. The
maintainer approved replacing that family rather than patching another marker. T1 now uses a SQLite transaction as
the only physical cross-process exclusion mechanism: short `BEGIN IMMEDIATE` transactions, durable receipts for
retry after a lost response, and capability-gated local lock-domain validation. The long-lived Delivery lease
remains domain state. The experimental lockfile commits are not accepted or integrated.

### SQLite runtime capability spike — GO

The actual VS Code extension-host binary (`~/.vscode-server/bin/4fe60c8b…/node`) reports Node `v24.15.0` and
exports `node:sqlite` (`DatabaseSync` and `StatementSync`). A disposable `/tmp` smoke using that exact binary
opened a database, selected `journal_mode=DELETE`, set `synchronous=FULL`, ran `BEGIN IMMEDIATE` + a parameterized
write + `COMMIT`, read the committed row, and cleaned up the database/journal. The workspace filesystem reports
`ext2/ext3`. This is GO evidence for a capability-gated implementation; the production adapter must still refuse
unsupported extension runtimes and unvalidated lock domains.

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Prepared delegation — T1 (T0.2 reconciled; ready)

- **Runtime/model triage:** Codex `gpt-5.6-sol` with high reasoning. T1 is a bounded code task but contains
  cross-process locking, stale-owner proof, CAS, immutable-state enforcement, and crash recovery; low/fast effort
  is inappropriate. Independent review should use another model family when Claude capacity returns, otherwise a
  fresh Codex high reviewer with an explicit adversarial-only contract.
- **Owns:** `src/delivery/types.ts`, `src/delivery/store.ts`, `test/unit/deliveryStore.test.ts`, plus the canonical
  generated behavior stub only.
- **Behavior gate:** `DeliveryStore recovers a provably stale lock while preserving immutable append-only state`.
- **Done condition:** new DeliveryStore/types exist with no Workspace/Bridge/spawn wiring; focused tests and
  typecheck pass; commit references `t-0b5723`; full parent verification remains the coordinator gate.
- **Guardrail:** do not start until T0.2 records PROVEN/PARTIAL/NOT_VIABLE and the plan is reconciled to that
  empirical result. No implementation may silently weaken `proven_empty` or process-fence capability semantics.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

# T1 SQLite DeliveryStore closure — 2026-07-10

- Replaced the lockfile backend with a workspace-local SQLite store using short `BEGIN IMMEDIATE` transactions,
  CAS versions, immutable/append-only validation, structured busy/unsupported errors, and intent-fingerprinted
  operation receipts.
- Added fail-closed runtime/filesystem capability detection and a transactional, idempotent migration of legacy
  Delivery JSON records. Concurrent migrators converge under the SQLite write lock and archive legacy data only
  after proving durable equivalence.
- Adversarial reviews R1–R3 closed legacy invisibility, runtime loading, receipt collision, concurrent marker, and
  archive-rename races. Final verdict: ACCEPT (`c56042a`).
- Integrated on `main` through `96942f7`; `npm run verify:full` passed (295 files, 3263 tests, 3 skipped).
- The superseded lockfile working copy remains preserved in stash
  `pre-sqlite delivery-store lockfile work t-0b5723` until the broader Delivery rollout is complete.

# T2 canonical gated-spawn projection closure — 2026-07-10

- Added opt-in canonical gated-spawn persistence: exactly one Delivery, implementer segment zero, and linked
  GitDelivery projection. Legacy mode remains the default rollout path.
- Spawn failures after runtime creation now run verified compensation without hiding a possibly-live runtime or
  deleting a pre-existing forced worktree.
- GitDelivery moved to a transactionally unique SQLite authority with fail-closed legacy migration and repairable
  JSON mirrors. Real subprocess coverage proves concurrent `open()` converges to one projection.
- Adversarial reviews R1–R4 closed cross-store partial failure, projection uniqueness, migration, crash/mirror,
  compensation, and subprocess cleanup findings.
- Integrated on `main` through `f7476fe`; `npm run verify:full` passed (296 files, 3272 tests, 3 skipped).

# T3 deterministic legacy import closure — 2026-07-11

- Added read-only preview plus fingerprint-bound apply for converting a legacy DelegationRecord and linear fixer
  attempts into canonical Delivery segments with one exact GitDelivery projection.
- Zero/multiple/drifted projections, nonlinear history, changed realpaths/ancestry, and conflicting intent refuse
  before canonical writes.
- A serialized Git reservation makes partial create/link failures resumable by canonical intent rather than a lost
  transport operation id; identical concurrent retries converge to the same Delivery and linked projection.
- Adversarial reviews R1–R5 closed partial-write, stale-inventory TOCTOU, incomplete fingerprint, pending wedge,
  and concurrent retry findings. Final verdict: ACCEPT (`c8a59da`).
- Integrated on `main` through `583f238`; `npm run verify:full` passed (297 files, 3275 tests, 3 skipped).
