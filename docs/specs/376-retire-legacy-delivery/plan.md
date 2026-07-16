# 376 — retire-legacy-delivery — plan

_Drafted from `spec.md` on 2026-07-13. This plan removes the old lifecycle; it does not complete spec 368._

## Approach

Make one breaking, pre-1.0 cut with a safe state-retirement step. The final runtime has one tracked-work path:

```text
new tracked work
  spawn_agent(gate)
      -> Delivery + segment 0
      -> one worktree/branch
      -> linked GitDelivery projection
      -> structured Delivery receipt

same logical work
  spawn_agent(delivery_join, role)
      -> exclusive mechanism-only lease
      -> same Delivery/worktree/branch

landing
  verify_task(delivery_id)
      -> immutable Delivery contract + segment scopes
      -> linked projection integrate/hygiene/prune
```

Generic sessions stay outside this graph. They manage a process, not a tracked change, and therefore get no
Delivery/GitDelivery/verification state.

## Correlation with existing work

Spec 376 is the hard-cut successor to existing migration work, not a second independent implementation queue.
Relationships are deliberately split into **absorbed**, **evidence to preserve**, and **separate** so a related
task is not accidentally treated as a blocking dependency.

| Existing item | Relation to spec 376 | Disposition |
|---|---|---|
| `t-c91486` — remove legacy DelegationRecord/GitDelivery | Same product outcome, but its old contract waited for all of spec 368 plus a compatibility window | **Superseded by `t-85f251`.** Preserve its preview, archive, no-Git-mutation, upgrade-diagnostic, and dogfood requirements; replace its sequencing with the maintainer-approved hard cut |
| `t-0b5723` / spec 368 | Architectural predecessor that produced canonical Delivery, sequential leases, reload binding, and linked projection policy | **Related, not a dependency.** Spec 376 consumes the already-landed mechanism but does not finish, close, or change the status of spec 368 |
| spec 368 T16 | Proposed selectable rollout modes and legacy-by-default compatibility | **Contract replaced, checkbox untouched.** Spec 376 removes the selector and compatibility path instead of satisfying T16 as written |
| spec 368 T17 | Broader temp-git lifecycle including a second concurrent Delivery | **Partial overlap only.** Spec 376 owns the canonical-only retirement fixture and optimal one-Delivery lifecycle; it does not claim T17's complete matrix |
| `t-dc5d94` / spec 368 T18 | Accepted installed mechanism-only dogfood on one Delivery/worktree | **Completed baseline evidence.** T6 reruns the happy path after legacy removal; prior dogfood does not substitute for the post-cut proof or close T18's crash/recovery matrix |
| spec 368 T19 | Proposed making canonical the default while retaining explicit legacy compatibility | **Superseded direction, checkbox untouched.** Spec 376 removes legacy entirely, so it cannot truthfully mark T19's different contract complete |
| spec 368 T20 | Closure of all spec 368 acceptance | **Separate and untouched.** Closing spec 376 must not move `t-0b5723` or spec 368 to done |
| `t-0de165`, `t-a9d850`, `t-815796` | Bugs/design around `reuse_worktree` and DelegationRecord-owned worktree transfer | **Legacy branch retired.** Do not repair `t-0de165`; remove the public path. Preserve the historical landed evidence, while canonical successors use `delivery_join` |
| `t-7acc58` | Existing coordinator waiver behavior is coupled to legacy verification identity | **Regression contract to preserve.** The direct Delivery verifier must retain auditable coordinator waivers without reading or editing a DelegationRecord |
| `t-aa9b77` | Existing live-worktree and prune safety in GitDelivery hygiene | **Regression contract to preserve.** Projection-only refactoring must keep the live/dirty/unknown fail-closed behavior |
| `t-13c2b6`, `t-cd8cbe`, `t-108a79` | Residual fault-injection, recovery-window, and ProcessFence hardening | **Separate, non-blocking work.** None is pulled into spec 376 and none becomes complete because the legacy path is removed |
| `t-e7a032` / `t-2a2af8` | General inventory, cleanup, disk GC, and worktree retention | **Related but separate.** T5 retires only old metadata; general cleanup still owns branches, worktrees, caches, sessions, and disk reclamation |

The board dependency list for `t-85f251` therefore remains empty: all required canonical primitives are already
landed, while the open related tasks are either superseded or explicitly out of scope. Board relations and this
table provide traceability without creating a false wait on unfinished spec 368 work.

### 1. Freeze and retire active legacy state

Add one human-invoked retirement action with preview and apply phases. Preview reads raw legacy metadata only to
produce an inventory: `.tachyon/delegations`, Delivery-less rows in `git-deliveries-v2.sqlite3`, and obsolete JSON
mirrors/migration directories. Apply copies the raw records plus manifest into a timestamped archive, verifies the
archive, then removes only those metadata rows/directories from active stores. It never runs a Git mutation.

Until this succeeds, canonical tracked-work entry points return one `LEGACY_DELIVERY_STATE_REQUIRES_RETIREMENT`
diagnostic. Bridge startup, the task board, and generic session control remain usable. Re-running the action after
a lost response is idempotent; a partial archive or changed inventory refuses instead of guessing.

The 2026-07-13 workspace snapshot proves this is not theoretical: 101 DelegationRecord files, 100 GitDelivery
rows (96 unlinked, 74 active-unlinked), and four canonical Delivery/linked-projection pairs exist. The canonical
rows are preserved. Counts are re-read at execution time because the snapshot can drift.

### 2. Remove selection and compatibility entry points

Delete `settings.delivery` from the TypeScript config model, parser, schema, repository config, samples, and
doctor input. Canonical mechanism-only becomes a Workspace invariant rather than a user choice. Reduce
`settings.gitDelivery` to the authority allowlists still used by linked integrate/prune; remove the standalone
profiles, `autoOpen`, `requireNonSelfAccept`, and `autoPrune` knobs.

Remove `DeliveryHandoffSafety` as a product/configuration union. Workspace wires one required mechanism-only
transfer-absence policy, and durable events keep the literal `mechanism-only` evidence label. The reviewed Linux
ProcessFence experiment may remain in its isolated module, but no factory, config value, or lease-service runtime
branch can select it; making it selectable later requires a separate spec and code change.

At the Bridge boundary:

- remove `spawn_agent.reuse_worktree` and all delegation-id/agent-name reuse sugar;
- retain `gate` for creation and `delivery_join` for subsequent roles;
- remove `git_delivery_open`;
- require `verify_task.delivery_id` and remove `agent`;
- make gated `spawn_agent` return a structured canonical receipt needed by later joins;
- reject an ad-hoc AI `worktree:true` as a tracked-change substitute; use `gate` for tracked work. Generic
  terminal/pipeline/session isolation remains available through its existing non-Delivery call paths.

No heuristic guesses the Delivery from task, agent, cwd, or branch. The creator receives and propagates the
stable id; every successor is explicit and auditable.

### 3. Remove legacy models from the core

Move the still-valid gate shape out of `bridge/delegationRecord.ts` into the canonical Delivery/spawn boundary,
then delete:

- `src/bridge/delegationRecord.ts`;
- `src/agents/reuseWorktree.ts`;
- `src/delivery/legacyImport.ts`;
- the `DeliveryStore.createLegacyImport` and `GitDeliveryStore.reserveLegacyImport` seams;
- legacy JSON-store promotion/mirror code after the retirement action owns that one-time archival boundary.

Refactor `verifyTask` to consume a canonical verification subject directly:

```ts
interface DeliveryVerificationSubject {
  deliveryId: string;
  contract: DeliveryContract;
  segments: DelegationSegment[];
  currentSegment: DelegationSegment;
  occupants: string[];
  createdBy: DeliveryActor;
  createdAt: string;
}
```

Scope checking derives boundaries from Delivery segments instead of converting them into `fixerAttempts`.
Verification record identity drops `legacy`, `delegationId`, and compatibility comments/fields. Historical
verification JSON remains evidence on disk but is not accepted as the identity of a new verification.

Agent re-anchor/primer logic reads a bound Delivery when it needs the gate reminder. Generic restart/resume no
longer consults old delegation files; Delivery-bound restart/resume continues through explicit lease recovery,
not generic pane revival.

### 4. Make GitDelivery structurally projection-only

Require `deliveryId` on stored GitDelivery projections and require deterministic canonical id/open inputs.
`DeliveryProjectionService` becomes the sole create/mutate caller. Remove the generic update path and the
unlinked branches from integrate/prune/classification/policy. List and hygiene join every projection to its
Delivery; a missing or mismatched link is corrupt canonical state, not a supported `unlinked` mode.

The Delivery backlink may remain temporarily absent only inside the already-modelled cross-store crash-repair
window. Such a Delivery is unavailable until projection reconciliation repairs it; it is never interpreted as
legacy or exposed as a second lifecycle.

GitDelivery keeps its name and `git_delivery_{list,hygiene,integrate,prune}` vocabulary because it still owns Git
facts (branch, worktree, review, integration, prune). It does not own lease, verification contract, or segment
authority.

### 5. Close in one bounded delivery

Implement as one reviewable change set with focused tests during editing, one `npm run verify:full:quiet` at the
first complete candidate, one independent review, one consolidated correction round if concrete defects exist,
then the final full gate. Do not reopen spec 368 tasks or add strong-isolation work to make this spec pass.

The final installed-extension dogfood exercises only the optimal lifecycle requested here. Exceptions that need
process fencing remain explicitly outside this spec.

## Key decisions

- **Hard cut, not a default flip** — removing APIs, types, readers, and configuration is the only way code rather
  than coordinator discipline guarantees one lifecycle; rejected leaving `mode: legacy` hidden or deprecated.
- **Archive old metadata; do not import it** — historical records are numerous and ambiguous, while promoting
  them would create live authority from stale work; rejected eager import and silent deletion.
- **Never mutate Git in retirement** — metadata cleanup can be made idempotent and safe without deciding whether
  old branches contain valuable commits; rejected automatic prune as unrelated and destructive.
- **GitDelivery remains a linked projection** — Git facts still need a durable model; rejected deleting it or
  making it authoritative because either loses hygiene/integration state or recreates two authorities.
- **Delivery id is explicit** — the creation receipt supplies it and every follow-up passes it; rejected inference
  by task, agent, branch, cwd, or most-recent timestamp as ambiguous.
- **Mechanism-only is product policy, not configuration** — it is the only wired handoff behavior now; the
  ProcessFence experiment remains isolated with no selectable runtime branch, and this spec neither completes nor
  markets it.
- **Generic sessions are not legacy Deliveries** — keeping process/session management separate avoids forcing
  terminals, home agents, and read-only scratch work into a fake change contract.
- **One bounded implementation/review cycle** — acceptance is the declared matrix below, not an expanding search
  for every unfinished 368 condition.

## Interface changes

| Surface | Before | After |
|---|---|---|
| `settings.delivery` | `legacy` or `canonical` plus three safety modes | removed; canonical mechanism-only is invariant |
| `settings.gitDelivery` | profiles + auto-open + future knobs + allowlists | linked-projection authority allowlists only |
| `spawn_agent` new work | optional `gate`, `worktree`, or standalone lifecycle | `gate` is the tracked-work creator and returns canonical receipt |
| `spawn_agent` follow-up | `reuse_worktree` or `delivery_join` | `delivery_join` only |
| `verify_task` | `delivery_id` or legacy `agent` sugar | required `delivery_id` |
| Git projection creation | auto-open or public `git_delivery_open` | internal `DeliveryProjectionService` only |
| Git projection mutation | linked canonical or Delivery-less generic | linked canonical only |
| old on-disk state | read as live compatibility | explicit preview/archive/retire; never live authority |

## Files touched

- `src/config/loadConfig.ts`, `src/config/tachyon.schema.json`, `tachyon.yml` — remove mode/safety and obsolete
  GitDelivery profile controls; retain only linked-projection authority settings.
- `src/workspace/Workspace.ts`, `src/extension.ts`, `src/workspace/doctorReport.ts` — wire canonical mechanism-only
  unconditionally, return creation receipts, remove standalone auto-open, and expose retirement diagnostics/action.
- `src/delivery/retireLegacyState.ts` (new) — raw preview/archive/apply boundary with no Git mutation.
- `src/agents/AgentManager.ts`, `src/bridge/{tools,primer,spawnContract}.ts` — remove reuse compatibility, make
  Delivery creation/join receipts explicit, clean obsolete contract language, and source gate reminders from
  canonical state.
- `src/bridge/verifyTask.ts`, `src/delivery/verifyAdapter.ts` — replace the compatibility adapter with a direct
  Delivery verification subject, then delete the adapter if no caller remains.
- `src/bridge/delegationRecord.ts`, `src/agents/reuseWorktree.ts`, `src/delivery/legacyImport.ts` — delete after
  their remaining valid types/callers are moved.
- `src/delivery/{types,store,leaseService}.ts` — remove legacy source/import state and selectable disabled legacy
  behavior while preserving the current mechanism-only contract.
- `src/git-delivery/{types,store,settings,policy,classify,prune}.ts`,
  `src/delivery/{projectionService,reloadReconciliation}.ts` — require linked projections and remove standalone
  creation/mutation/import/classification branches.
- `src/init/initLogic.ts`, `docs/funcionalidades.html`, tool-count/auth fixtures, and relevant current docs — remove
  obsolete store mirrors, tools, and user-facing compatibility language.
- `test/unit/{config,bridge,agentManager,verifyTask,gitDelivery,deliveryStore,deliveryProjectionService,workspaceHeadless}*.test.ts`
  and generated behavior gates — replace compatibility assertions with canonical-only and retirement coverage;
  delete generated tests whose sole contract was a removed compatibility path.

## Test matrix

| Boundary | Required proof |
|---|---|
| Config | omitted config is canonical; the known removed Delivery block is ignored and diagnosed; unrelated invalid keys still fail; authority allowlists still parse |
| New spawn | one Delivery/projection/worktree/segment; exact structured receipt; zero delegation files |
| Spawn failure | no phantom Delivery holder, projection, session, token, or deleted caller-owned worktree |
| Successor | exact `delivery_join`, same worktree/branch, no fallback; old reuse field absent from schema |
| Verification | delivery id required; segment boundary/scope, fail-before/pass-after, waiver, doorbell, and stub checks remain sound without a DelegationRecord |
| Projection | every row linked; only canonical sequence mutation; open/unlinked/generic update paths absent |
| Retirement preview | exact stable counts/digest; corrupt/changed/partial state refuses |
| Retirement apply | raw archive verified; only legacy metadata removed; linked/canonical rows byte-stable; Git refs/worktrees/status byte-stable; replay idempotent |
| Reload | canonical binding reconstructs; retired data cannot reactivate or resolve by agent name |
| API/docs | removed config values, tools, fields, and compatibility descriptions absent from current surfaces |
| Dogfood | real implement -> verify -> review FINDINGS -> fix -> verify -> ACCEPT on one Delivery/worktree |

## Risks & controls

- **Existing legacy volume is large.** Preview and archive raw bytes before active-state deletion; do not import or
  operate on Git.
- **Cross-store creation is not one SQLite transaction.** Keep the existing intent/reconciliation protocol and
  explicitly distinguish incomplete canonical creation from a supported unlinked projection.
- **Verifier refactor can weaken scope boundaries.** Freeze current canonical segment fixtures before deleting the
  adapter and prove identical blockers/acceptance on those fixtures.
- **Removing `worktree:true` as a tracked shortcut can break callers.** Reject with a specific migration message;
  do not silently convert because a gate needs a verifier and owns contract the caller did not provide.
- **Current canonical Deliveries may be held/quarantined.** Retirement never mutates them; dogfood uses a fresh
  Delivery and closure reports the pre-existing states separately.
- **Process-fenced code can tempt scope expansion.** No config wiring, helper installation, detached-child claim,
  or 368 task closure is accepted in this change.

## Visual impact

Only the existing notification/command-palette error path changes: a workspace with legacy delivery metadata gets
one actionable retirement message and preview. No new webview is required.

**Visual QA Opt-Out:** the migration surface is a command/notification plus structured text; functional installed
dogfood is the useful proof.

## Sources consulted

- `docs/specs/368-delivery-worktree-leases/{spec,plan,tasks}.md` — canonical aggregate, compatibility window,
  mechanism-only dogfood, and explicitly unfinished process-fenced/default rollout.
- `docs/specs/365-orchestrator-delivery-hygiene/{spec,plan}.md` — original standalone GitDelivery lifecycle and
  the Git projection facts that remain useful.
- `docs/specs/362-delegation-verification-gate/{spec,plan}.md` — original DelegationRecord and verifier contract.
- `src/workspace/Workspace.ts` — mode branch, canonical creation, auto-open, join, reload, and ledger wiring.
- `src/agents/{AgentManager,reuseWorktree}.ts` — legacy reuse path and canonical join path.
- `src/bridge/{tools,verifyTask,delegationRecord}.ts` — public compatibility surfaces and verification model.
- `src/delivery/{types,store,leaseService,legacyImport,verifyAdapter,projectionService}.ts` — canonical and
  compatibility internals.
- `src/git-delivery/{types,store,settings,policy,classify}.ts` — standalone/unlinked versus linked projection paths.
- `src/config/{loadConfig.ts,tachyon.schema.json}` and `tachyon.yml` — current default and workspace opt-in.
- Read-only 2026-07-13 state inventory under `.tachyon/` — migration-size evidence recorded above.
