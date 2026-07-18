# 398 — worktree-disk-sustainability — plan

_Drafted 2026-07-18 from t-2a2af8 + live remeasure + specs 210/368/392._

## Approach

Split the problem into **three independent slices** that share one **retention classifier** and one **GC orchestrator**, built on top of **392 ManagedWorktreeService** (never raw `rm -rf` outside gates):

1. **Reclaim lifecycle** — when a tree is safe to delete, actually delete it (auto + dry-run + explicit).
2. **Deps materialization** — stop paying ~400MB×N for `node_modules` on local agent/change trees.
3. **Auxiliary GC** — `.vscode-test` version retention + docs for VHDX compact.

Do **not** invent a second worktree engine. Occupancy, dirty confirm, and Delivery-linked remove stay fail-closed in WorktreeManager / ManagedWorktreeService / git_delivery_prune.

## Key decisions (proposed — lock before code)

### D1 — Source of truth for “what exists”

| Layer | Role |
|-------|------|
| **Registry (392)** | Canonical managed paths under `settings.worktree.base/<wsHash>/…` |
| **Git worktree list** | Live git truth; used to detect orphans registry≠git |
| **On-disk scan of base** | Catch pre-392 / mis-layout dirs (`pi-*` at base root) as **orphan candidates** with stricter policy |

**Orphans outside registry but under base:** reclaim only if (a) path under base, (b) not occupied, (c) age > grace, (d) optional fingerprint “tachyon-created” (`.git` + branch prefix / registry tombstone). Never touch paths outside base.

### D2 — Retention classifier (single pure function)

Input: registry entry | orphan candidate + live probes.

```
retain if ANY:
  occupied(cwd)           // AgentManager / session cwd under path
  deliveryHeld(path)      // 368 lease / open GitDelivery linked
  dirty(git status)       // unless explicit force + confirmDirty already in product path
  uniqueCommitsUnmerged   // optional: treat as dirty-equivalent for abandon policy (reuse git_delivery rules)
  withinGrace(lastUsedAt)
  pin.retain / settings keep list
else → reclaimable
```

Expose `reason: occupied|dirty|delivery-held|grace|pinned|reclaimable`.

### D3 — Auto-GC triggers (v1)

| Trigger | Behavior |
|---------|----------|
| **Agent dismiss / forget / remove_worktree success path** | Already removes; ensure no leftover empty parents |
| **Delivery prune / abandon** (existing) | Keep; ensure registry sync |
| **Engine boot / reload** | **Dry inventory + reclaim orphans past grace** (opt-in setting default **on** for orphans only) |
| **Explicit Bridge/Control action** | `worktree.gc` dryRun\|run |
| **Periodic** | v1.1 — not required if boot + explicit exist |

**Default auto-delete only:** reclaimable **orphans** + registry entries marked `status=abandoned` past grace.  
**Do not** auto-delete a live registry `active` entry solely because agent stopped — require grace **and** clean **and** no delivery, configurable `settings.worktree.gc.reclaimStoppedAfter` (default 24h).

### D4 — Dependency strategy (highest disk ROI)

**Chosen primary: opt-in symlink to primary workspace `node_modules` for same-repo change/agent trees on local FS.**

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **A. Symlink → primary `node_modules`** | Near-zero incremental; already used informally by agents; simple | Breaks if primary install drifts; not hermetic for offline WT | **v1 default when `settings.worktree.shareNodeModules: true` (default true on linux local)** |
| **B. Full `npm ci` per tree** | Hermetic | 400MB×N — status quo pain | Keep as fallback / CI / when share=false |
| **C. pnpm store / hardlinks** | Correct sharing | Requires packageManager migration | Document as future if monorepo moves to pnpm |
| **D. Reflink copy (btrfs/xfs)** | COW | WSL ext4 usually no | Probe; enable if `cp --reflink=auto` works |

**Gates / verify:** verify_task and hermetic runners that need isolation must either run with share=false **or** treat shared node_modules as acceptable for monorepo unit tests (current reality on main). Delivery hermetic clones stay separate (368) — out of scope for sharing.

**Primer change:** fresh worktree primer says: prefer `ln -s <workspace>/node_modules node_modules` when share enabled and lockfile matches; else `npm ci`.

### D5 — `.vscode-test` GC

- Location: workspace `.vscode-test/` (and document global if any).
- Keep: version matching `package.json` engines / last successful test run + N-1 previous (default N=2).
- Lock file during test download/run; GC skips locked version.
- Tool: npm script or Bridge host action `devtools.gcVscodeTest` (or package script only in v1 to avoid Bridge surface creep).

### D6 — Surfaces

| Surface | v1 |
|---------|----|
| **Bridge** | `worktree_gc` { dryRun, includeOrphans } → report |
| **Control / Cockpit disk** | Reuse/extend `src/cockpit/disk.ts` rows: path, bytes, reason, lastUsed |
| **Logs** | structured GC summary on boot |
| **VS Code status bar** | **no** (noise) |

### D7 — WSL vs VHDX docs

Runbook section:

1. Linux `du` / GC frees **blocks inside** the ext4 VHDX.
2. Windows still holds sparse file size until **Optimize-VHD** / Disk Cleanup / `wsl --shutdown` + compact.
3. Link known Microsoft compact steps; Tachyon does not automate Windows compact.

## Architecture sketch

```
WorktreeGcService
  classify(entry) -> { action, reason, bytes? }
  inventory()     -> rows (registry ∪ disk orphans under base)
  dryRun() / run() -> results[]
  uses:
    ManagedWorktreeService.remove / list
    AgentManager.worktreeOccupant
    Delivery/GitDelivery liveness probes (read-only)
    du/stat (async, bounded concurrency)
```

Wire:

- `engineService` boot → optional `gc.run({ orphansOnly: true, dryRun: false })` behind setting
- Bridge tool → full report
- Cockpit collect → inventory snapshot

## Files (expected)

- `src/worktree/WorktreeGcService.ts` (new)
- `src/worktree/ManagedWorktreeService.ts` / registry types — lastUsedAt, abandonedAt if missing
- `src/bridge/tools.ts` — `worktree_gc`
- `src/cockpit/disk.ts` — surface bytes/reasons
- `src/config/loadConfig.ts` — `settings.worktree.gc.*`, `shareNodeModules`
- primer / onboarding string (narrow)
- `docs/runbooks/disk-and-vhdx.md` (new) + pointer from README
- tests: `test/unit/worktreeGc*.ts`

## Risks

| Risk | Mitigation |
|------|------------|
| Symlink node_modules masks missing native rebuild | Document; share=false escape; typecheck still works for pure JS/TS |
| GC deletes someone's WIP orphan | grace + dirty check + dry-run default for first ship week via setting |
| Boot GC slows startup | orphans-only, concurrency limit, budget ms |
| `.vscode-test` GC mid-test | lockfile / mtime of running pid |
| Confuse free disk with VHDX shrink | docs + dogfood note mandatory |

## Alternatives considered

1. **Only docs “please remove worktrees”** — rejected; measured pile-up continues.
2. **Always full npm ci + aggressive delete only** — helps retention but not incremental 400MB tax while trees live.
3. **Global content-addressed npm cache daemon** — overkill for v1.
4. **Status-bar disk meter** — rejected for v1 noise.

## Phased delivery

| Phase | Slice | Ships when |
|-------|-------|------------|
| **P0** | Plan (this doc) + remeasure baseline | t-2a2af8 plan land |
| **P1** | Classifier + inventory + dry-run Bridge + boot orphan report (no delete default) | safe observability |
| **P2** | Auto-reclaim reclaimable orphans + stopped-clean past grace | real reclaim |
| **P3** | `shareNodeModules` + primer | incremental ≤100MB goal |
| **P4** | `.vscode-test` GC + VHDX docs | aux disk |
| **P5** | Cockpit/Control bytes UI polish | operator UX |

P1→P2 can be one PR if tests are tight; P3 is the big acceptance lever.

## Success metrics (dogfood)

- Baseline `du -sh ~/.cache/tachyon/worktrees` and top offenders.
- After P2: orphan count → 0 after grace; no false deletes (journal reasons).
- After P3: create 5 change WTs with share on → median incremental size.
- `.vscode-test` keeps ≤2 engines after P4.
- Explicit note: VHDX size on Windows may need compact to **show** host free space.

## Sources consulted

- Task t-2a2af8 body (2026-07-10 measure)
- Live 2026-07-18: base 1.4G; `pi-*` ~483M with real `node_modules`; `b349073a/change/*` small
- Specs 210, 368, 376 notes (t-e7a032 related), 392 cookbook (remove gates)
- `src/cockpit/disk.ts`, `ManagedWorktreeService`, `WorktreeManager` prune/remove
- Informal review notes already mentioning `ln -s main/node_modules`
