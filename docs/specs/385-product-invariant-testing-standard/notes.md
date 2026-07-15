# 385 — product-invariant-testing-standard — notes

_Created 2026-07-14._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- 2026-07-14 — Repository audit first considered the VSIX shipping classifier for `PI-001`, then rejected
  it during contract review: classifying literal paths does not prove the stronger packaged-archive promise.
  `PI-001` instead protects the portable, externally observable project-guidance ownership boundary: opt-in,
  provenance-labelled delivery and absence from an unconfigured consumer primer.
- 2026-07-14 — Verification ownership audit found three implicit product assumptions: every gate got a
  Vitest `test/unit` stub (including `cmd:`), plain names ran through npm/Vitest JSON, and affected tests
  always ran `npx vitest related`. Spec 385 moves all three behind explicit project configuration.
- 2026-07-14 — The global SDD skill templates remain unchanged. Tachyon's repository convention lives in
  project guidance and requires each local Task/spec to name affected `PI-*` IDs or `none — reason`.
- 2026-07-14 — Security review rejected the initial generated failing Vitest placeholder: RED/GREEN alone
  is not a behavior oracle. Named verification now binds a real, pre-existing, tracked project test, records
  its committed SHA-256, and requires byte-identical content at BASE and HEAD without granting the
  implementer ownership of the file.
- 2026-07-14 — The verifier settings snapshot is frozen at delegation creation, including `{}` when the
  project configured no verifier. BASE and HEAD run in separate tracked-only clones outside the source repo,
  with independent Git object storage, checkout hooks neutralized, clean-state checks and phase-private
  temporary/common package-cache roots. Login/toolchain configuration and deliberate absolute inputs remain
  trusted project inputs; this is not a filesystem sandbox.
- 2026-07-14 — Final security review rejected destructive launch compensation entirely. Even an exact HEAD and
  clean-status observation has a check/use race with ignored writes. Failed setup or launch therefore preserves
  fresh and reused checkouts for explicit recovery. Every launch attempt uses a Git worktree lock as a durable
  quarantine receipt until ledger/delegation ownership is recorded; a surviving receipt refuses implicit retry,
  while a normally finalized unlocked checkout remains reusable after a clean stop or lost ephemeral ledger row.
  Automatic orphan cleanup is traded for no silent data loss.
- 2026-07-15 — Governance was ratified as a separation of authorities. Agents write and propose Product
  Invariants; an independent reviewer distinct from the implementer proves that the promise is stable and the
  executable evidence has meaningful RED/GREEN; a maintainer approves the promise and accepted outcomes. The
  implementer cannot self-approve.
- 2026-07-15 — Mechanically equivalent topology, runner or path maintenance may proceed with independent review
  alone only when repository policy permits and promise, oracle strength, accepted variance, identity, active
  status and gates remain unchanged. Weakening, removing or changing any of those semantics requires explicit
  maintainer approval.
- 2026-07-15 — The approved authority snapshot is frozen before delegation and throughout fixer/reuse rounds.
  Tachyon's generic hardening authenticates canonical Delivery and legacy delegation records with a
  workspace-bound host HMAC and rejects rollback through a host-custodied current revision/MAC freshness head.
  This protects project-selected authority without choosing consumer frameworks, commands or governance policy.
- 2026-07-15 — Independent PI-001 review accepted the promise as stable and externally observable, found the
  oracle independent of implementation output, and proved meaningful RED/GREEN in an isolated copy: the gate
  passed at the candidate and failed when Tachyon-repository policy was injected into the generic primer.
- 2026-07-15 — Independent authority review found and closed three concrete bypass classes before closure:
  stale host-head caches across canonical/legacy hosts, a reused runtime starting before its durable FixerAttempt,
  and historical operation receipts replayed after lease/tail/event drift. Multi-host rollback, branch/tip
  revalidation, pre-spawn authority and receipt-TOCTOU regressions now fail closed.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- 2026-07-14 — The drafted plan described a generated adapter stub. Implementation deliberately replaced it
  with read-only oracle binding after adversarial review showed that a placeholder could be rewritten into a
  meaningless pass. `stubPath` remains only as a compatibility configuration key.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- 2026-07-15 — HMAC without freshness was rejected because an older, validly signed authority record could be
  replayed. Keeping the current revision/MAC outside workspace-controlled storage adds host state and fail-closed
  recovery, but distinguishes the current approved snapshot from stale authentic history.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

None. Governance roles, independent PI-001 proof, generic authority hardening and closure verification are complete.

## Installed-upgrade follow-up — 2026-07-15

- Installed `0.56.8` dogfood against the real Tachyon workspace found 21 canonical Delivery rows created before
  authority sealing shipped. Every row is structurally readable but unsigned; all 21 are linked to historical
  GitDelivery projections. The new store correctly refuses each row, but reload incorrectly promoted those
  independent row failures into one workspace-wide Delivery failure and emitted an unbounded list of IDs.
- Ratified containment: invalid authority remains unusable and is never auto-signed, repaired, deleted or trusted.
  Reload treats each failed row as an unavailable Delivery identity, denies any session that binds to it, and
  continues with independently valid signed rows. Database-level failure still fails the entire reload. This keeps
  the spec's authority promise while preventing one historical or malicious row from becoming a global availability
  switch. Explicit import/retirement remains separate human-authorized recovery work.
- Closure evidence: rollback-tamper and pre-hardening regressions pass in the focused 76-test reload/workspace set;
  typecheck and `npm run verify:full:quiet` pass on `0.56.9`. An offline disposable copy of the installed workspace
  database reproduced the exact upgrade shape as `0` trusted + `21` quarantined rows, with all 21 classified
  unavailable and the overall snapshot ready. The live database was never opened for mutation.

## Verification evidence

_The evidence below predates the 2026-07-15 governance and authority-hardening additions. It is retained as
historical baseline evidence and does not close the new pending tasks._

- 2026-07-14 — `npx tsc --noEmit --pretty false` passed.
- 2026-07-14 — Focused affected matrix passed: 14 files, 618 tests.
- 2026-07-14 — `npm run test:invariants` passed: 1 active invariant, 1 executable test.
- 2026-07-14 — `npm run verify:full:quiet` passed: 348 files, 4,257 passed, 3 skipped.
- 2026-07-14 — `git diff --check` passed.

### Closure evidence — 2026-07-15

- Independent PI-001 review: GREEN gate at the candidate; intentional generic-primer policy leak produced RED
  for the expected absence assertion in an isolated copy; no candidate files were changed by the reviewer.
- Independent hardening re-audit: freshness multi-host, reuse grant/branch/tip and historical-receipt TOCTOU
  all closed; no Tachyon-repository invariant vocabulary or approval policy leaked to an unconfigured consumer.
- Integrated hardening matrix: 10 files, 682 tests passed.
- Full-gate compatibility matrix after closure fixes: 4 files, 13 tests passed.
- SDD verification: 4/4 declared checks passed; SDD dogfood: 1/1 passed; `git diff --check` passed.

## Verification log

### 2026-07-15T02:04:07Z — pass (4/4) — source: tasks.md
- `npm run test:invariants` — pass
- `npm exec -- vitest run test/unit/config.test.ts test/unit/configSchema.test.ts test/unit/verifyTask.test.ts test/unit/workspaceHeadless.test.ts test/unit/snBoundaryLocksBehavior.gen.test.ts` — pass
- `npm run typecheck` — pass
- `npm run verify:full:quiet` — pass

### 2026-07-15T15:20:39Z — fail (3/4) — source: tasks.md
- `npm run test:invariants` — pass
- `npm exec -- vitest run test/unit/config.test.ts test/unit/configSchema.test.ts test/unit/deliveryStore.test.ts test/unit/verifyTask.test.ts test/unit/workspaceHeadless.test.ts test/unit/snBoundaryLocksBehavior.gen.test.ts` — pass
- `npm run typecheck` — pass
- `npm run verify:full:quiet` — fail

### 2026-07-15T15:26:08Z — pass (4/4) — source: tasks.md
- `npm run test:invariants` — pass
- `npm exec -- vitest run test/unit/config.test.ts test/unit/configSchema.test.ts test/unit/deliveryStore.test.ts test/unit/verifyTask.test.ts test/unit/workspaceHeadless.test.ts test/unit/snBoundaryLocksBehavior.gen.test.ts` — pass
- `npm run typecheck` — pass
- `npm run verify:full:quiet` — pass

## Dogfood log

### 2026-07-15T15:27:13Z — pass (1/1) — source: tasks.md — commit: 143a3210bb46a7343c846d38a485bd27fb4456f8
- `npm run test:invariants` — pass

### 2026-07-15T15:30:12Z — pass (4/4) — source: tasks.md
- `npm run test:invariants` — pass
- `npm exec -- vitest run test/unit/config.test.ts test/unit/configSchema.test.ts test/unit/deliveryStore.test.ts test/unit/verifyTask.test.ts test/unit/workspaceHeadless.test.ts test/unit/snBoundaryLocksBehavior.gen.test.ts` — pass
- `npm run typecheck` — pass
- `npm run verify:full:quiet` — pass

### 2026-07-15T15:31:16Z — pass (1/1) — source: tasks.md — commit: d9b9e16b1f27dba5de332b967c2e6e3f97f5852a
- `npm run test:invariants` — pass
