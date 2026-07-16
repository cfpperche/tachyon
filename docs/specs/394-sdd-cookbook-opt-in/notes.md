# 394 — notes

- Source of truth: tachyon-plugins/sdd (not hand-edit .agents/skills/sdd)
- Heuristic uses concrete tool ids (create_worktree, …) to avoid "no Bridge tools" false positives
- Dogfood vehicle: docs/specs/392-managed-worktree-registry/cookbook.md on feature branch

## Dogfood log

### 2026-07-16 — pass (installed sdd@1.5.0 + 392 cookbook)

- Lock: `github:cfpperche/tachyon-plugins@v0.32.0#path=sdd` → version **1.5.0**, commit `9f7b76e`
- Materialized: `.agents/skills/sdd/scripts/sdd-cookbook.sh` present
- `sdd-close` on 392: findings `acceptance-unchecked` (pre-existing); warnings `dogfood-opt-out` only — **no `cookbook-missing`**
- Counterfactual shipped surface with `create_worktree` and no cookbook: warning **`cookbook-missing`** still fires
