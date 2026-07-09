# 365 — orchestrator-delivery-hygiene — plan

_Drafted 2026-07-09 from folded `spec.md` (Claude+Codex dualet). Phase 1 only._

## Approach

Implement a **GitDelivery** store + Bridge tools for observe/prune hygiene without
auto-merge. Worktree spawns optionally open a delivery; hygiene classifies with
**live git**; prune is fail-closed and re-validates before delete.

Phase 1 ship: model, persistence, list/hygiene/open/prune, autoOpen on worktree
spawn, actor defaults, unit tests. **No** integrate_delivery / record_review /
autoPrune / PR mode (Phase 2).

## Key decisions

- **Module** `src/git-delivery/` (or `src/delivery/` with Git* types) — host-agnostic
  store + pure classifiers; Workspace wires Bridge + WorktreeManager + agent
  liveness. Rejected putting logic only in tools.ts.
- **Store** `.tachyon/git-deliveries/<id>.json` + `index.json` optional; gitignore
  entry in default `.gitignore` / ensure path is ignored. Atomic write temp+rename;
  `version` CAS on mutate.
- **Containment** pure functions using injected git exec: ancestry OR (if integration
  metadata present) cherry empty — Phase 1 prune `ready_to_prune` uses ancestry **or**
  recorded `integrated` with live re-check of cherry/ancestor. Without Phase 2
  integrate tool, recorded integrated may be rare; hygiene still useful for
  ancestor-contained branches after cherry-pick *if* we also run `git cherry`.
  Phase 1: implement both checks in classifier even if only ancestry is commonly true
  until Phase 2 writes integration records.
- **Abandon prune**: worktree remove + keep branch unless forceLoseCommits.
- **Bridge tool names**: `git_delivery_list`, `git_delivery_hygiene`,
  `git_delivery_open`, `git_delivery_prune`.
- **autoOpen**: Workspace/AgentManager after successful worktree create for ad-hoc
  with worktree:true, if settings allow.
- **Liveness**: `AgentManager` / session hasSession → live; else not_live. No
  unknown unless registry ambiguous — prefer not_live when session absent.
- **Actors**: list/hygiene any agent; open = any agent (self/orchestrator); prune =
  refuse unless caller is human path OR settings allow — for Phase 1 Bridge:
  allow any **agent** principal that owns the delivery (`createdBy` or `agent`
  field match) OR settings `gitDelivery.prunePrincipals` includes name; document
  that main-mutating integrate is Phase 2. Spec said fail-closed for random peers —
  implement: prune allowed if `caller.name === delivery.agent` OR
  `caller.name === delivery.createdBy.name` OR name in allowlist; else refuse.

## Files touched

| File | Change |
|------|--------|
| `src/git-delivery/types.ts` | GitDelivery schema, phases, hygiene categories |
| `src/git-delivery/store.ts` | load/save/list, CAS version, uniqueness |
| `src/git-delivery/classify.ts` | containedInBase, hygiene report pure-ish with git port |
| `src/git-delivery/prune.ts` | predicate check + orchestrate remove |
| `src/git-delivery/settings.ts` | parse defaults/profiles from config |
| `src/config/loadConfig.ts` | `settings.gitDelivery` |
| `.gitignore` | `.tachyon/git-deliveries/` |
| `src/bridge/tools.ts` | four tools |
| `src/workspace/Workspace.ts` | wire store, autoOpen, deps |
| `src/worktree/*` or AgentManager | hook after worktree create |
| `test/unit/gitDelivery*.test.ts` | unit coverage |

## Risks

- Git exec in unit tests: inject fake git.
- Prune must not call branch -D unless tachyonCreatedBranch.
- Coordinate with existing worktree cleanup on kill/dismiss — avoid double-delete races.

## Sources

Folded spec.md · WorktreeManager · tools.ts patterns · SessionLedger atomic write style.
