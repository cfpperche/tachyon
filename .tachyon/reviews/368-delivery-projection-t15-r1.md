# SDD 368 T15 canonical GitDelivery projection — Sonnet R1 independent review — FINDINGS

Reviewed candidate `29b52eaf` (branch `deliveryProjectionT15GrokR1`) against BASE `9b8d6d89`, journal
contract `j-ed50f2582808` (task `t-0b5723`), and current main `ebdb9d80`. Read the full production diff
(`src/delivery/{types,store,projectionService}.ts`, `src/git-delivery/{types,store,classify,policy}.ts`,
`src/bridge/tools.ts`, `src/workspace/Workspace.ts`), the canonical `verify_task` record, and the new/changed
tests. Ran `tsc --noEmit` (clean) and the five directly-touched suites (114/114 pass). Canonical `verify_task`
verdict is **`blocked`** (`scope_breach` on `test/unit/auth.test.ts`) — correctly withheld, and I additionally
confirm that file is now numerically wrong against current main regardless of scope. Independent of that block,
I found **two HIGH-severity authorization gaps** in the new linked-mutation policy that contradict the
contract's explicit authority rule, proven exploitable by the candidate's own test suite, plus one
defense-in-depth gap in the store layer.

## Canonical scope-breach block — CONFIRMED, not waivable, now also stale against main

`.tachyon/verifications/29b52eaf2c40ee5cc3904a722fd68906e64e2b23.json` records `verdict: "blocked"`,
`scope_breach` on `test/unit/auth.test.ts` — not among the 15 declared owned paths in the T15 contract.
The diff itself is a mechanically-forced two-line count bump (`59` → `60`) reflecting the new
`git_delivery_integrate` Bridge tool registered in the (owned) `src/bridge/tools.ts`.

This is not just an out-of-scope touch — **it is now also numerically wrong against current main**. Main
(`ebdb9d80`) already carries an *unrelated* commit, `49af2981` (`test(t-099be8): sync bridge tool count to
60`), landed after this candidate's `9b8d6d89` base, which bumped the same hardcoded assertion 59→60 for a
different reason entirely: task `t-099be8`'s `write_tachyon_config` tool (confirmed via
`git show ebdb9d80:src/bridge/tools.ts` vs `9b8d6d89` — `write_tachyon_config` is the only new tool name on
main in that range). If `29b52eaf` is rebased onto current main as-is, the true registered-tool count becomes
**61** (60 already on main + `git_delivery_integrate`), and this exact assertion would fail immediately. Per
this project's established precedent for scope breaches (T13 R1: "immutable scope history is authority... migrate
the corrected net state into a fresh gated Delivery"), this reinforces — it does not merely repeat — that the
fix belongs in a fresh gated Delivery rebased onto current main, not a waiver of the existing commit.

## HIGH — `legacy` caller kind granted unconditional integrate/prune authority

`src/git-delivery/policy.ts:19-29`, `canMutateLinkedGitDelivery`:

```ts
const kind = caller?.kind ?? actor.kind;
if (kind === "system" || kind === "human" || kind === "master") return true;
// legacy bridge callers are treated as privileged for compatibility with direct-register tests
if (kind === "legacy") return true;
```

The T15 contract is explicit: "Mutations require a privileged human/system/master caller or a Bridge-resolved
agent explicitly listed in `integratePrincipals`/`prunePrincipals`." `legacy` is none of those four categories —
and the codebase's own identity-resolution doc comments (`src/bridge/callerIdentity.ts:236-241`, `:288-290`)
treat `legacy` as a deliberately distinct, lower-trust compat tier from `master`/`human`, reachable simply by
presenting the workspace's shared bearer token. `legacyCompatEnabled` (which produces `kind: "legacy"`)
**defaults to `true`** for existing workspaces (`src/bridge/Bridge.ts:199`, `legacyCompatEnabled: this.options.legacyCompatEnabled ?? true`).

Net effect: on any workspace with default settings, a caller holding the shared/master token — the most widely
held, lowest-ceremony credential in the system by design — gets unconditional `integrate`/`prune` authority over
*any* linked GitDelivery, completely bypassing the `integratePrincipals`/`prunePrincipals` allowlist this task
exists to enforce. The inline comment ("treated as privileged for compatibility with direct-register tests")
reads as the change being shaped to keep existing tests green rather than to satisfy the contract's authority
rule.

## HIGH — self-declared `actor` grants authority when `caller` is omitted (proven by the candidate's own test)

Same function, `src/git-delivery/policy.ts:19-29`:

```ts
const kind = caller?.kind ?? actor.kind;
...
const name = caller?.kind === "agent" ? caller.name : actor.kind === "agent" ? actor.name : undefined;
return !!name && principals.includes(name);
```

`caller` is optional on both `CanonicalIntegrateInput.caller` and `CanonicalPruneInput.caller`
(`src/delivery/projectionService.ts:115`, `:125`) and on `canIntegrateLinkedGitDelivery`/
`canPruneLinkedGitDelivery` themselves. When it's omitted, the check falls back to trusting `actor.kind`/
`actor.name` — fields the contract explicitly names as attribution-only: "ephemeral execution name,
`GitDelivery.agent`, `createdBy`, and attribution-only `principal` never grant integrate/prune authority by
equality." `actor` is exactly this kind of self-declared, attribution-only field on the caller's own input.

This isn't hypothetical — the candidate's own test proves it. `test/unit/deliveryProjectionService.test.ts:322-324`:

```ts
expect(canIntegrateLinkedGitDelivery({ kind: "agent", name: "worker" }, settings.integratePrincipals)).toBe(false);
expect(canPruneLinkedGitDelivery({ kind: "agent", name: "worker" }, settings.prunePrincipals)).toBe(false);
expect(canIntegrateLinkedGitDelivery({ kind: "agent", name: "orch" }, settings.integratePrincipals)).toBe(true);
```

All three calls omit `caller` entirely and pass only a self-declared `actor`. The third assertion is asserted as
*correct behavior*: an `actor` whose self-declared name happens to match an `integratePrincipals` entry gets
`true` with no server-resolved caller identity involved at all — precisely the "authority by equality" the
contract forbids. The one Bridge tool call site (`src/bridge/tools.ts:685-701`, `:796-812`) happens to always
pass `deps.caller` today, so this isn't reachable through the currently-wired HTTP path — but it is a proven,
live defect in the policy function itself, exploitable by any future or internal direct caller of
`DeliveryProjectionService.integrate`/`.prune` (retries, repair tooling, orchestration code) that constructs
its own `CanonicalIntegrateInput`/`CanonicalPruneInput` without threading a resolved `caller` through. Given the
contract states this rule in the imperative ("never... by equality"), and the candidate's own suite demonstrates
the violation directly rather than merely permitting it as an edge case, I'm treating this as HIGH rather than
latent.

**Recommended fix shape for both HIGH findings** (not to be implemented by me): `canMutateLinkedGitDelivery`
should require a resolved `caller` — refuse (not fall back) when `caller` is undefined — and should drop the
`kind === "legacy"` blanket-trust branch, keeping only `system`/`human`/`master` as caller-kind-equality
privileged tiers plus the principals-allowlist agent check.

## MEDIUM — `GitDeliveryStore.update()` has no store-level guard against mutating a linked record

`src/git-delivery/store.ts:153-172`. The generic `update()` method gained an `_options: { allowLinkedBypass?:
boolean }` parameter (underscore-prefixed — unused in the body) and is invoked with `{ allowLinkedBypass: true }`
at exactly one call site (`store.ts:91`, the pre-link reservation path inside `open()`). The parameter is never
read; `update()` applies no check at all against mutating a GitDelivery that already has `deliveryId` set.

Today this is safe only because every call site that could reach a linked record checks `delivery.deliveryId`
first and branches to the canonical `DeliveryProjectionService` path (`src/bridge/tools.ts:718-723`, `:800-812`;
the two remaining direct `store.update()` calls at `tools.ts:760` and `:830` are both inside the
Delivery-less/`else` branch). But there is no backstop at the data layer analogous to
`DeliveryStore.updateInternal`'s claim-exclusivity check (`src/delivery/store.ts:388-399`, which refuses
ordinary `update()` outright while a projection claim is held). A single future caller — a repair script, a new
Bridge tool, an internal refactor — that calls `gitDeliveries.update()` directly on a linked record without
checking `deliveryId` would silently mutate `phase`/`currentHeadSha`/etc. with zero authorization check, zero
live-Git containment proof, and zero sequence tracking, defeating T15's entire safety model for that call. The
vestigial, unused `allowLinkedBypass` parameter suggests this enforcement was intended but not finished. No test
exercises `update()` against a linked record to confirm refusal (there isn't one to confirm, since none exists).

## Architecture assessment (lock order, sequencing, claim mechanics) — sound

The parts I could verify against the contract are well-built:

- **Lock order** (`src/delivery/projectionService.ts` `openCanonical`/`integrate`/`prune`/`reconcile`): every
  entry point acquires the projection claim (`withClaim`) before the canonical worktree mutex
  (`withWorktreeLock`), and live Git/GitDelivery-transaction work happens only inside both — matches "claim →
  worktree mutex → live checks → GitDelivery transaction," never reversed.
- **Owner identity and reclaim** (`src/delivery/store.ts` `readLocalProjectionOwnerIdentity`/
  `classifyProjectionOwner`): PID + `/proc/<pid>/stat` start-time field 19 + boot id + PID-namespace inode,
  exactly as specified. Reclaim only fires on same-boot/same-namespace + `ENOENT`; live, foreign-domain,
  PID-reuse, and unreadable observations all fail closed to `ambiguous` (busy). `updateInternal` refuses
  ordinary `update()` while any claim exists (any delivery, not just projection-mutation paths) and refuses
  `updateUnderProjectionClaim` on a nonce mismatch — a real mutual-exclusion backstop at the data layer, the
  thing the GitDelivery-side `update()` (MEDIUM finding above) is missing.
- **Intent/sequence replay**: `nextProjectionSequence`/`appendIntent`/`applyCanonicalIntent`
  (`projectionService.ts`, `git-delivery/store.ts:184-243`) correctly treat identical `(sequence, operationId)`
  replay as success, refuse a different `operationId` at an already-applied sequence, refuse gaps
  (`sequence !== appliedSeq + 1`), and refuse `deliveryId` link drift via `assertImmutableLink`. `reconcile()`
  walks intents in order and repairs each of the three named crash boundaries (intent-appended-but-not-applied,
  applied-but-backlink-missing, and idempotent completion after Git-side changes race ahead) — the canonical
  behavior test (`test/unit/deliveryProjectionT15GrokR1Behavior.gen.test.ts:36`, "concurrent reconcile and prune
  cannot diverge GitDelivery from canonical lease safety") matches the contract's named title.
- **Safety-state refusal**: `assertSafeForMutation` (`projectionService.ts:730-796`) refuses on
  `held`/`quarantined`/`unavailable` and, since `ReloadLeaseClass` (`src/delivery/reloadReconciliation.ts:24`)
  has only those three plus `terminal`, the `class !== "terminal"` fallback is an exhaustive fail-closed guard,
  not a gap — `pending`/`draining`/`verifying` are already folded into `unavailable` upstream
  (`reloadReconciliation.ts:349-354`), so they refuse correctly (if generically-labeled).
- **`withPathLock`/`withAgentPathLock`**: confirmed the same underlying `withLock(path.resolve(...))` mutex
  (`src/worktree/WorktreeManager.ts:306-314`) — the canonical projection path and the legacy Delivery-less path
  serialize on the same key for a given worktree; no cross-path race.
- **Record-only integrate**: verified `integrate()` never calls a main-mutating Git command — only
  `classifyDelivery`/`containedInBase` (read-only) precede the store mutation, matching the contract and the
  tool description.

## Verification run

- `tsc --noEmit -p tsconfig.json`: clean, no errors.
- `vitest run test/unit/{deliveryProjectionService,gitDelivery,deliveryStore,bridge,auth}.test.ts`: **114/114
  pass** (5 files).
- `git diff --check 9b8d6d89..29b52eaf`: not separately needed — no whitespace conflicts surfaced during review.
- Confirmed drift against main via `git log 9b8d6d89..ebdb9d80 -- src/delivery src/git-delivery
  src/bridge/tools.ts src/workspace/Workspace.ts test/unit/auth.test.ts` and a tool-name diff
  (`write_tachyon_config` is main's 60th tool, unrelated to this candidate) — see scope-breach section above.

## Verdict

**FINDINGS.** Canonical gate is correctly `blocked` on the `auth.test.ts` scope breach, which — independent of
scope — is also now numerically stale against current main and needs a fresh rebase, not a waiver. Independent
of that block, the new linked-mutation authorization policy (`canMutateLinkedGitDelivery` and its two wrappers
in `src/git-delivery/policy.ts`) has two HIGH-severity gaps against the contract's explicit authority rule: an
unconditional `kind === "legacy"` privilege grant reachable by default (`legacyCompatEnabled` defaults `true`),
and a `caller`-omitted fallback to self-declared `actor` equality, the latter directly demonstrated by the
candidate's own test at `deliveryProjectionService.test.ts:322-324`. There is also a MEDIUM defense-in-depth gap
where `GitDeliveryStore.update()` has no store-level refusal for mutating an already-linked record (a vestigial,
unused `allowLinkedBypass` parameter suggests this was intended but not finished). The lock-order, owner-identity,
intent/sequence-replay, and safety-state-refusal architecture is otherwise sound and matches the contract
precisely everywhere I could verify it. Recommend: migrate onto a fresh gated Delivery rebased on current main
(closing the scope breach and the count drift together), and close both HIGH authorization findings plus the
MEDIUM store-layer gap in that same pass.
