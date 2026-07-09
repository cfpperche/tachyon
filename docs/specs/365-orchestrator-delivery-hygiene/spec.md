# 365 — orchestrator-delivery-hygiene

_Created 2026-07-09._  
_Revised 2026-07-09 (fold: Claude probe `.tachyon/reviews/365-orchestrator-delivery-hygiene-claude.md` + Codex probe `.tachyon/reviews/365-orchestrator-delivery-hygiene-codex.md`)._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred. -->

## Intent

Tachyon already has multi-agent delivery isolation — git worktrees (`worktree: true` → branch
`tachyon/{agent}` under `.cache/tachyon/worktrees/…`), board tasks
(`inbox → triaged → active → landed → done`), notify doorbells, and declared reviewers (spec 352) —
but **no first-class lifecycle for “this branch of work relative to the integration base.”**

Live dogfood of orchestrated waves (2026-07-09) showed the failure mode:

- Many local `tachyon/*` branches accumulate in Git Graph after worktree spawns.
- Board `landed` does **not** mean commits are on `main` (cherry-pick is a separate step).
- Review is social (`notify_agent`) without durable delivery state.
- Orphan worktrees accumulate after ACCEPT because prune is not a product primitive.

Tachyon is **infrastructure**, not a single mandated human process. Maintainers may prefer solo
main-line commits, cherry-pick after review, or GitHub PRs. This spec adds a **git delivery lane**
(API namespace `git_delivery_*` / type `GitDelivery` — see naming): observable state + optional
profiles + hygiene tools — defined vocabulary and fail-closed cleanup, **not** a rigid BPM.

"Done" (Phase 1) looks like: worktree spawns can open a GitDelivery; orchestrators list open /
ready-to-prune / missing-ref; hygiene reports without mutating; prune removes worktree+branch only
when live-git predicates pass (including cherry-pick equivalence or recorded integrate map); abandon
cannot silently destroy unique commits. Phase 2 adds review hooks and gated integrate modes.

---

## Product decisions (ratified from dualet)

| Topic | Decision |
|-------|----------|
| Name | **GitDelivery** in schema/docs; Bridge tools **`git_delivery_*`** (avoids collision with 332/348 notice "delivery") |
| Default profile | **`balanced`** |
| Store | Workspace **`.tachyon/git-deliveries/`**, **gitignored** (local-only v1) |
| "Integrated into base" | **Git-verified only** for phase `integrated`: (a) tip is ancestor of resolved baseRef, **or** (b) audited integrate op recorded `integratedSha` + patch mapping such that `git cherry base..tip` is empty (or equivalent patch-id check). **No** "human confirms alone → integrated" |
| Human override | Phase `integrated_unverified` (asserted only) — **never** auto-prune branch; requires explicit data-loss override to prune |
| Prune vs phase | **Live git + live liveness always re-checked at prune time**; phase is cache/display, not authority |
| Abandoned prune | Default: remove **worktree only**, **keep branch** with unintegrated commits. Branch delete only with explicit `forceLoseCommits` listing doomed SHAs |
| autoPrune | **Not in Phase 1.** Phase 2 optional, **off by default**, only after git-verified `integrated`, with dry-run audit first |
| Task link | Optional `taskLinks[]`; hygiene `landed_without_integrated` **only** for tasks with ≥1 linked delivery |
| Head tracking | Separate `currentHeadSha` (refreshed live) vs `reviewedHeadSha` / `integratedSha` (frozen at events) |
| Actors (Bridge) | Spec 351 identity: mutating tools are **privileged** — see Actor policy |
| Concurrency | Atomic per-delivery write + version/etag; prune claims exclusive lock and revalidates |

---

## Acceptance criteria

### Phase 1 — model + observe + prune (MVP)

- [ ] **Scenario: worktree spawn opens a GitDelivery (autoOpen)**
  - **Given** `settings.gitDelivery.autoOpen` is true (default under profile `balanced`)
  - **When** an ad-hoc agent is spawned with `worktree: true`
  - **Then** a GitDelivery is created with schemaVersion, id, agent, branchRef, worktreePath,
    baseRef (name, not frozen SHA), currentHeadSha (if resolvable), phase `open`, creator
    marker (Tachyon-created branch true/false), store version 1
- [ ] **Scenario: autoOpen false**
  - **Given** profile `solo` / `autoOpen: false`
  - **When** a worktree spawn occurs
  - **Then** no GitDelivery is created unless `git_delivery_open` is called explicitly
- [ ] **Scenario: list_git_deliveries**
  - **Given** deliveries in multiple phases
  - **When** `git_delivery_list` runs (optional phase filter)
  - **Then** each row exposes id, agent, branchRef, phase, currentHeadSha (live refresh preferred),
    baseRef, taskLinks, review path/verdict if any, `containedInBase` (live classification — see
    Integration semantics), `missingRef` if branch/worktree gone
- [ ] **Scenario: git_delivery_hygiene is read-only**
  - **Given** mixed branches/worktrees/tasks
  - **When** `git_delivery_hygiene` runs
  - **Then** report includes categories: `ready_to_prune` (git-verified contained + clean + not
    live), `candidate_orphan` (advisory: no live agent, optional age/dirty),
    `landed_without_integrated` **only for tasks with linked delivery**, `missing_ref`,
    `integrated_unverified`; **never deletes**
- [ ] **Scenario: prune refuses on live-git fail-closed predicates**
  - **Given** any of: dirty worktree (policy), agent live/unknown liveness, branch tip has
    unintegrated commits (not contained), other worktree uses same branch, creator marker false /
    path mismatch, store version conflict
  - **When** `git_delivery_prune` is called without overriding force flags
  - **Then** structured refusal names the failed predicate(s); nothing deleted
- [ ] **Scenario: prune after git-verified integrated**
  - **Given** phase `integrated` **and** live re-check still shows containedInBase, clean, agent not
    live, exclusive claim held
  - **When** prune runs
  - **Then** worktree removed; Tachyon-created branch deleted; phase `pruned`; audit written
- [ ] **Scenario: abandon does not destroy unique commits by default**
  - **Given** phase becomes `abandoned` with unintegrated commits
  - **When** prune runs without `forceLoseCommits`
  - **Then** worktree may be removed; **branch is kept**; refusal or partial success is explicit
  - **When** caller supplies `forceLoseCommits: true` and the doomed SHAs listed match live tip
    history
  - **Then** branch may be deleted; audit records SHAs lost
- [ ] **Scenario: board landed ≠ integrated**
  - **Given** a task is `landed`/`done` **and** has a linked GitDelivery not git-verified integrated
  - **When** hygiene runs
  - **Then** `landed_without_integrated` fires; tasks with **no** linked delivery are **out of
    scope** (solo main-line is not an error)
- [ ] **Scenario: missing_ref reconciliation**
  - **Given** a delivery whose branch or worktree no longer exists on disk
  - **When** hygiene/list runs
  - **Then** category `missing_ref`; prune may close the record to `pruned`/`abandoned` without
    deleting foreign git objects
- [ ] **Scenario: safety checks use live git**
  - **Given** stored `currentHeadSha` is stale
  - **When** prune or integrate safety runs
  - **Then** checks use live `rev-parse` of branch + worktree status + resolved baseRef; stored
    fields are cache only
- [ ] Persistence: versioned records under **gitignored** `.tachyon/git-deliveries/`; survive
      extension reload; atomic write (temp + rename); optimistic concurrency via `version` field
- [ ] Mutating tools require Bridge-resolved identity (351) and satisfy Actor policy
- [ ] Unit tests: open/list/hygiene classes; prune refuse/success; abandon partial; missing_ref;
      concurrency version refuse; liveness unknown refuse; patch-containment vs ancestry; no real
      multi-window VS Code required (fakes ok)

### Phase 2 — review + integrate

- [ ] **Scenario: request_review / record_review**
  - **Given** delivery `open` or `changes_requested`
  - **When** `git_delivery_request_review` runs
  - **Then** phase `in_review`
  - **When** `git_delivery_record_review` records ACCEPT|FINDINGS with path and freezes
    `reviewedHeadSha = currentHeadSha` at record time
  - **Then** phase `accepted` or `changes_requested`; if later `currentHeadSha ≠ reviewedHeadSha`,
    ACCEPT is stale until re-review or explicit override
- [ ] **Scenario: self-review invalid for gating**
  - **Given** the same agent principal records ACCEPT on its own delivery
  - **When** strict profile would gate integrate on ACCEPT
  - **Then** self-ACCEPT does **not** satisfy the gate (must be another principal or human)
- [ ] **Scenario: integrate git-verified**
  - **Given** mode proves containment (ancestor **or** successful audited cherry-pick/merge that
    records integratedSha + empty cherry list)
  - **When** integrate succeeds
  - **Then** phase `integrated` only; failure leaves phase unchanged
- [ ] **Scenario: integrate_unverified override**
  - **Given** human/orchestrator marks override without git proof
  - **Then** phase is `integrated_unverified` (not `integrated`); auto branch prune forbidden
- [ ] **Scenario: cherry-pick/merge capability gate**
  - **Given** mode is cherry-pick or merge
  - **When** caller lacks capability / baseRef not protected policy / dirty main worktree / invalid
    refs
  - **Then** refuse; never arbitrary refspecs; audit exact git argv + result
- [ ] Profiles `solo` | `balanced` | `strict` | `custom` parse from settings; **profiles are
      preset bundles; explicit `settings.gitDelivery.*` keys override profile values; `custom` =
      no preset**
- [ ] autoPrune if ever enabled: workspace opt-in, git-verified integrated only, dry-run audit first

### Cross-cutting

- [ ] Tool/docs names use **`git_delivery_*` / GitDelivery** — not bare `delivery_*`
- [ ] Defaults never auto-push or auto-PR
- [ ] Non-goal of non-rigid workflow is not violated by hard-gating solo main-line tasks

---

## Core contracts (normative)

### Integration / containment semantics

A tip is **containedInBase** (live) when **either**:

1. `git merge-base --is-ancestor <tip> <resolvedBase>` succeeds, **or**
2. Delivery has `integration.kind` in `{cherry-pick, merge}` with `integratedSha` on base and
   live `git cherry <base> <tip>` reports no unpicked commits (patch equivalence), **or**
3. Explicit `integration.patchIds` set recorded at integrate time matches live cherry empty.

Cherry-pick **must** use (2)/(3) — pure ancestry is **insufficient** for the motivating workflow.

### Phase transition table

| From | To | Trigger | Actor |
|------|-----|---------|--------|
| (none) | open | spawn autoOpen / `git_delivery_open` | system / orchestrator |
| open | in_review | `git_delivery_request_review` | orchestrator / owner agent |
| in_review | accepted | `record_review` ACCEPT (non-self if strict) | reviewer / human |
| in_review | changes_requested | `record_review` FINDINGS | reviewer / human |
| changes_requested | open | fixer continues (optional explicit) | orchestrator |
| open \| in_review \| accepted \| changes_requested | abandoned | explicit abandon | orchestrator / human |
| open \| accepted | integrated | git-verified integrate | privileged integrate actor |
| * | integrated_unverified | explicit unevidenced override | human / privileged |
| integrated | pruned | prune success (live predicates) | privileged prune actor |
| abandoned | pruned | worktree-only prune, or forceLoseCommits | privileged prune actor |
| * | pruned | missing_ref close | system / prune |

Review metadata **persists** across `changes_requested → open` (history not erased).

`open → integrated` is **legal** when review not required (balanced/solo).

### Minimal schema (versioned)

```text
GitDelivery {
  schemaVersion: 1
  id: string                  // gd-…
  version: number             // optimistic concurrency
  workspaceId: string
  createdBy: { kind, name? }  // 351 snapshot
  agent: string
  branchRef: string
  worktreePath: string
  tachyonCreatedBranch: boolean
  baseRef: string             // ref name resolved live
  currentHeadSha?: string     // cache; refresh live
  reviewedHeadSha?: string
  integratedSha?: string
  phase: open|in_review|accepted|changes_requested|integrated|integrated_unverified|abandoned|pruned
  taskLinks: { taskId: string, linkedAt: string }[]
  review?: { verdict, path, by, at, reviewedHeadSha }
  integration?: { kind, at, by, evidence }
  transitions: { at, from, to, by, reason }[]
  createdAt, updatedAt: string
}
```

Unknown fields preserved on read/write for forward compat. Corrupt record → hygiene
`corrupt_record`, no destructive action.

### Actor policy (Bridge tools)

| Tool | Allowed callers (Phase 1 lean) |
|------|--------------------------------|
| `git_delivery_list` / `git_delivery_hygiene` | any agent principal |
| `git_delivery_open` | orchestrator / human / the delivery agent itself |
| `git_delivery_prune` | **human** or agent with explicit workspace grant / orchestrator role policy; **not** arbitrary peer workers; prefer fail-closed default: only **legacy-disabled + agent token of orchestrator declared in settings** or human UI command |
| Phase 2 `record_review` | any agent, but **self-ACCEPT ignored for strict gate** |
| Phase 2 `integrate_*` | human UI and/or agents listed in `settings.gitDelivery.integratePrincipals` (empty = human-only for mutating modes) |

Exact grant config is plan-level; acceptance is that **defaults do not let a random ad-hoc self-integrate to main**.

### Liveness

- Source of truth: Tachyon session registry (agent running with matching session name) **plus**
  optional lease/heartbeat if already present for the agent.
- States for prune: `live` | `not_live` | `unknown`.
- **`unknown` → prune refuses** (unless force abandon with explicit flag).
- Tests: stale registry after crash treated as unknown or not_live per implementation proof —
  prefer refuse-on-unknown.

### Concurrency

- One file per delivery id; write via temp + atomic rename.
- Mutating tools require `expectedVersion` (or CAS on `version`); mismatch → refuse.
- Uniqueness: at most one non-pruned delivery per `(branchRef)` and per `(worktreePath)`.
- Prune: acquire claim → revalidate all predicates → delete → release; claim prevents concurrent
  spawn into same worktree (coordinate with WorktreeManager if needed).

### Profiles

| Profile | autoOpen | require non-self ACCEPT to integrate | integrate mode default | autoPrune |
|---------|----------|--------------------------------------|--------------------------|-----------|
| solo | false | false | manual (git-verify only) | false |
| balanced | true | false | manual (git-verify only) | false |
| strict | true | true | manual or gated cherry-pick | false in P1; opt-in P2 |
| custom | knobs | knobs | knobs | knobs |

Explicit `settings.gitDelivery.*` **overrides** profile bundle values.

---

## Non-goals

- Mandating one human process for all teams.
- Auto-push / auto-PR in Phase 1.
- Replacing Mission Control task statuses.
- Replacing 352 reviewers — GitDelivery only records outcomes.
- Deleting **remote** branches in v1.
- Rewriting WorktreeManager.
- Multi-base monorepo topology.
- AutoPrune as default destructive behavior.

---

## Open questions (remaining)

1. Exact orchestrator principal grant config shape for prune/integrate — _plan_.
2. Whether `forceLoseCommits` requires human-only (UI) vs Bridge with step-up — _lean: human UI in
   P1, Bridge only with explicit settings flag_.
3. PR integrate mode details — _Phase 2+. _

Resolved: naming (`GitDelivery` / `git_delivery_*`); store gitignored; integration evidence;
abandon defaults; live-git authority; task link scoping; head freeze fields; no Phase 1 autoPrune.

---

## Sources

Live orchestrator dogfood 2026-07-09 · WorktreeManager · TaskStore · 351 · 352 · 210 ·
Claude/Codex dualet reviews 2026-07-09 · design conversation (profiles, non-rigid infra).
