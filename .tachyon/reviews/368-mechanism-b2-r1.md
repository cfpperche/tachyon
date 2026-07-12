# SDD 368 T14.6B2 mechanism-only delivery joins — Grok R1 independent review — FINDINGS

Reviewed immutable range `0a62e50e7afe0646d13b16ca52903b7cf3f491fc..3bbe002b5fab4158cb3f528583d660146363d73c`
(single commit `3bbe002b` "t-0b5723 implement canonical mechanism-only delivery joins") in worktree
`/home/goat/.cache/tachyon/worktrees/b349073a/deliveryMechanismB2TerraR1` against frozen implementation contract
`j-79a1d65658d0` and review contract `j-53aac6cdec19` (task `t-0b5723`).

Canonical `verify_task(full=false)` ACCEPT is recorded at
`.tachyon/verifications/3bbe002b5fab4158cb3f528583d660146363d73c.json` (typecheck, related tests, behavior BASE fail /
HEAD pass). Worker full green is noted but is not treated as independent acceptance of production safety or matrix
truthfulness.

Delta (11 files, +173/−14): `Workspace.ts`, `leaseService.ts` (`failJoin`), `bridge/tools.ts`
(`delivery_complete_review`), config/schema parse, doctor warning flag, tool-count tests, generated behavior stub,
dogfood script. Production and tests were inspected read-only; only this artifact is written.

Independently traced coordinator hypotheses H1–H9 against source and, where noted, local git/exec evidence. No
fixes implemented.

## Hypothesis disposition

| ID | Coordinator claim | Disposition |
|----|-------------------|-------------|
| H1 | Generated behavior only parses config; dogfood only prints readiness; no implement→review lifecycle on one worktree | **CONFIRMED** (see F2) |
| H2 | `exactExecutionStopper` validates stored `/proc` identity but never compares live tmux pane PID to `input.process.pid` | **CONFIRMED** (see F3) |
| H3 | `isAncestor` ignores `GitExec` exit codes; `readHead`/inspection may accept failed/empty git results | **CONFIRMED** (see F1; empirically reproduced) |
| H4 | `DeliveryLeaseService` captures `handoffSafety` from early config and ignores live reload | **CONFIRMED** (see F4) |
| H5 | Resolver/review tool require one linked projection but not `id === delivery.gitDeliveryId` | **CONFIRMED** (see F5) |
| H6 | Initial identity/nonce path; old/missing nonce rows may not fail at the intended boundary | **PARTIALLY CONFIRMED** (see F6) |
| H7 | Bridge auth/zero-call/refusal/idempotence/warning have no material tests | **CONFIRMED** (see F2/F7) |
| H8 | `failJoin` / reverse-marker compensation races / held quarantine | **PARTIAL** — nonce matching is sound; residual race/orphan notes under F8 |
| H9 | No proof AgentManager prepare/confirm/fail reuses one worktree and never creates fallback | **CONFIRMED** (see F2) |

Config enum/default/incompatible combos in `loadConfig` look structurally correct (non-disabled safety requires
`mode: canonical`; unknown keys rejected; schema enums match). Doctor warning is wired when
`mode===canonical && handoffSafety===mechanism-only` (`extension.ts` → `buildDoctorReport`). Tool list count 62
includes `delivery_complete_review`. Those pieces are not findings.

---

## Findings (severity-ranked)

### F1 — HIGH: Workspace git adapters ignore `GitExec` exit codes, so ancestry is always true and failed inspections can look clean

`createGitExec` (`WorktreeManager.ts:178–189`) is documented and implemented to **resolve** on non-zero exit and
only reject when the binary cannot spawn:

```text
Resolves (never rejects) on a non-zero exit so callers branch on `code`
```

The new lease adapters in `Workspace.ts:475–484` do not branch on `code`:

```ts
readHead: async (cwd) => (await this.gitExec(["rev-parse", "HEAD"], cwd)).stdout.trim(),
inspectWorktree: async (cwd) => ({
  headSha: (await this.gitExec(["rev-parse", "HEAD"], cwd)).stdout.trim(),
  clean: (await this.gitExec(["status", "--porcelain"], cwd)).stdout.trim() === "",
}),
isAncestor: async (older, newer, cwd) => {
  try { await this.gitExec(["merge-base", "--is-ancestor", older, newer], cwd); return true; }
  catch { return false; }
},
```

Because `gitExec` almost never throws, `isAncestor` returns **`true` for every case where git ran**, including:

- diverged history (`merge-base --is-ancestor` exit `1`)
- invalid SHAs (exit `128`)

**Empirically reproduced** in this environment with the same resolve-on-nonzero shape:

- diverged commits: git exit `1`, Workspace-shaped `isAncestor` → `true`
- invalid older SHA: git exit `128`, Workspace-shaped `isAncestor` → `true`
- non-repo `status --porcelain`: stdout empty, `clean === true` despite fatal error
- non-repo / failed `rev-parse`: empty or garbage stdout becomes `headSha` without fail-closed

**Concrete impact** in `DeliveryLeaseService` acquire / handoff / review paths that call these deps:

- `DELIVERY_NON_LINEAR_HEAD` (`leaseService.ts` ~550, ~1222) cannot fire for non-ancestor succession when wired
  through Workspace.
- Dirty/failed worktree inspections can report `clean: true` and empty heads, undermining review postconditions
  that trust `inspectWorktree` / `inspectReviewWorktree`.

This is a production safety defect on the only integration path that mechanism-only handoff/acquire/review will use
in the extension. Unit tests that inject honest `isAncestor: () => true/false` mocks do not catch it.

### F2 — HIGH: Forcing behavior title is false; contract lifecycle matrix is not proven

Generated gate
`test/unit/deliveryMechanismB2TerraR1Behavior.gen.test.ts`:

```ts
it("mechanism-only canonical Delivery reuses one worktree through review completion", () => {
  const parsed = parseConfig("settings:\n  delivery:\n    mode: canonical\n    handoffSafety: mechanism-only\n...");
  expect(parsed.errors).toEqual([]);
  expect(parsed.config?.settings.delivery).toEqual({ mode: "canonical", handoffSafety: "mechanism-only" });
});
```

That only proves YAML parse of two settings keys. It does **not** exercise:

- free vs held `prepareDeliveryJoin` / one-worktree reuse
- implement → review FINDINGS → fix → review ACCEPT
- AgentManager prepare/confirm/failJoin
- stopper, PID identity, or reverse marker
- Bridge `delivery_complete_review`

`scripts/dogfood/delivery-lease.mjs` only checks `package.json` existence and prints
`delivery lease dogfood ready: …`.

Canonical verify_task therefore BASE-fails / HEAD-passes a **misleading** title while the frozen contract’s done
matrix (“dedicated temp-git/headless implement→review… lifecycle on one worktree”, Bridge auth matrix, exact
stopper binding, etc.) remains largely unproven by this delta. Prior T14.6B1 unit coverage of
`DeliveryLeaseService` mechanism-only policy is real but is not this B2 join/wiring/lifecycle gate.

### F3 — MEDIUM: `exactExecutionStopper` never re-reads the live pane PID for `executionAgent`

`Workspace.ts:492–503`:

- Loads holder + ledger binding and checks nonce/segment/agent/cwd/worktree realpaths.
- Calls `readLinuxProcessIdentity(input.process.pid)` — the **stored** holder PID.
- Never calls `tmux.panePid(session(executionAgent))` (or equivalent) to require live pane PID equality with
  `input.process.pid` before `manager.kill(executionAgent)`.

Contract j-79a1d65658d0 requires revalidation of “live pane PID/start/boot” for the execution agent. Validating
`/proc` for the stored PID and then killing by **agent name** allows stop/absence to be about process A while the
tmux session for that name is process B (restart/rebind/window replace races). Mechanism-only already admits
best-effort root death; skipping live pane rebind makes the “exact” stopper less exact than the contract text.

### F4 — MEDIUM: `handoffSafety` is frozen from constructor-time `earlyConfig`, not live config

`Workspace.ts:466–469`:

```ts
this.deliveryLease = new DeliveryLeaseService({
  ...
  handoffSafety: earlyConfig?.settings.delivery?.handoffSafety ?? "disabled",
```

`DeliveryLeaseService.handoffSafety()` (`leaseService.ts:1339–1342`) only returns `this.deps.handoffSafety`
(defaulting to `"process-fenced"` if the dep is missing — a second footgun for direct constructors).

`reloadConfig()` updates `this.config` but does not reconstruct `deliveryLease` or refresh the safety dep.
Operator changes to `settings.delivery.handoffSafety` after activation are ignored until process restart. Contract
called out “reload exactness”; this wiring fails it for the safety level itself (while doctor reads live
`ws.config` and can disagree with the service).

### F5 — MEDIUM: Linked projection selection ignores `delivery.gitDeliveryId`

Three new/updated call sites select “the” worktree by filtering GitDelivery rows on `deliveryId` + non-empty
`worktreePath` and requiring `length === 1`:

- `canonicalWorktreeFor` (`Workspace.ts:470–473`)
- `prepareDeliveryJoin` (`Workspace.ts:2352–2354`)
- `delivery_complete_review` (`tools.ts` ~2552–2553)

None require `projection.id === delivery.gitDeliveryId` when that backlink is set. Elsewhere in the product
(reload reconciliation, verification lease, projection service) that equality is treated as authoritative. A
wrong single linked row (stale path, mis-linked id, repair lag) is accepted as canonical. Same gap on the Bridge
tool path.

Additionally, the Bridge tool passes `linked[0].worktreePath` **without** `realpathSync`, while
`canonicalWorktreeFor` / prepare realpath the path. `completeReview` then compares
`path.resolve(input)` to `path.resolve(realpath(canonical))` and can refuse a correct Delivery with
`DELIVERY_WORKTREE_MISMATCH` when the stored path is not already real.

### F6 — MEDIUM: Initial nonce bind can omit sequential identity; missing-nonce markers remain “valid”

New create path in `recordCanonicalDelivery` (canonical mode only) correctly fail-closes on non-exact pane
identity and mints `executionNonce` + process on first create (`Workspace.ts:2283–2302`). Good for new rows.

Gaps:

1. If `deliveries.get` already returns a row (create race / pre-B2 row), identity mint is skipped; bind still
   runs with `executionNonce: holder.executionNonce` which may be **undefined** (`:2345`).
2. `isValidDeliveryBinding` (`SessionLedger.ts:105–111`) requires only non-empty `deliveryId` + `segmentId`;
   nonce is optional. Stopper and handoff paths that require nonce then refuse later, but the reverse marker can
   persist without sequential identity — not the fail-closed “missing identity fails at the intended boundary”
   for all entry points.
3. Identity capture is not conditioned on `handoffSafety === "mechanism-only"`; it applies to all canonical
   creates. That is stricter than the contract’s mechanism-only wording but is not by itself a defect if
   intentional; the defect is the skip path for existing holders without process/nonce.

### F7 — MEDIUM: `delivery_complete_review` authorization is thin and untested

Tool (`tools.ts:2537–2558`):

- Refuses missing `deliveryLease` / git delivery deps, missing/`legacy`/`external` caller.
- Permits `human` | `master` | agent whose name equals `delivery.createdBy` when creator is an agent.
- Does not add material tests for: reviewer-by-name refuse, zero service calls on refuse, idempotent
  `operation_id` replay, warning payload contents, missing caller, creator-vs-principal distinction, or
  unavailable deps.

Only `auth.test.ts` / `bridge.test.ts` tool-count and name-list updates land. Contract explicitly required Bridge
auth/refusal/idempotence/warning coverage.

Auth policy also never grants a non-creator “coordinator” principal separate from `createdBy` (fine if creator
is always the coordinator). Attribution principal is not used for stop (stopper path) — good vs contract item (3).

### F8 — LOW/MEDIUM: `failJoin` nonce matching is correct; residual compensation surface remains unproven

New `failJoin` (`leaseService.ts:704–726`) quarantines only when:

- `pending` and `holder.reservationNonce === reservationNonce`, or
- `held` and `holder.executionNonce === reservationNonce`

That matches `confirmHeld` promoting reservation nonce → `executionNonce` (`:657`). AgentManager join catch calls
cleanup then `failDeliveryJoin` with `prepared.reservationNonce` (`AgentManager.ts` ~986–1000). Names are not
authority. Good design vs H8’s worst reading.

Residual (not fully disproven by this delta’s tests):

- No material test that reverse-marker failure after confirmHeld runs cleanup + failJoin without leaving a live
  held execution and free lease (or held lease with live agent).
- No test that concurrent handoff after pending makes failJoin throw `occupied` and surfaces AggregateError
  rather than silent success.
- Quarantine does not itself stop processes; correctness depends entirely on `cleanupFailedDeliveryExecution`
  ordering — untested in this commit.

---

## What looks sound (not findings)

- Config parse rejects `handoffSafety` without `mode: canonical`; defaults are disabled/legacy-shaped when keys
  appear.
- Strong `ProcessFence` remains `UnavailableProcessFence` with explicit T14.6C deferral comment.
- Mechanism-only doctor warning string matches the Bridge review warning theme.
- `failJoin` is lease-owned and nonce-scoped rather than name-inferred.
- Prepare refuses non-canonical mode and non free/held lease states; does not invent a second worktree path when
  projection count ≠ 1 (logic present; H9 is about missing proof, not missing code for the happy filter).

---

## Verification performed (read-only)

- Full `git diff 0a62e50e..3bbe002b` and surrounding call paths in `Workspace`, `AgentManager.spawnDeliveryJoin`,
  `leaseService` acquire/handoff/confirm/failJoin/completeReview, Bridge tool registration, config/schema, doctor.
- Empirical node reproduction of gitExec + Workspace-shaped `isAncestor` / clean-status false negatives (see F1).
- Confirmed verification record ACCEPT for `3bbe002b` without treating it as safety proof.
- No production/test edits; no typecheck/full re-run required by review contract beyond independent inspection.

## Verdict

**FINDINGS.** Not accepted.

Blocking production defect: **F1** (ancestry/inspection always-success adapters). Blocking contract/gate
truthfulness: **F2** (forcing test does not prove one-worktree review completion). Additional MEDIUM items F3–F7
must be closed or explicitly waived with a revised done matrix before T14.6B2 integration.
