# 398 — notes

## 2026-07-18 — planning session (hermes / t-2a2af8)

### Remeasure

```
~/.cache/tachyon/worktrees total ~1.4G
  pi-session-continuity  483M  (full node_modules)
  pi-onboarding          483M
  other pi-*             ~74M each
  b349073a/              ~25M  (change trees lean; no full npm ci)
.vscode-test under monorepo ~2.6G
  1.128.0 915M
  1.126.0 877M
  1.124.2 798M
```

Two populations: **legacy fat trees** at base root vs **canonical wsHash/change|agent** lean trees. GC must handle both; deps strategy mainly prevents new fat trees.

### Product decisions drafted (need maintainer lock before P3 code)

1. shareNodeModules symlink default **on** for local linux  
2. Auto-delete orphans past grace on boot; stopped-clean after 24h setting  
3. No status bar disk meter v1  
4. VHDX compact is docs-only Windows side  

### Out of scope confirmation

t-e7a032 inventory remains related but separate; 376 T5 does not replace this GC.

### Next

Human review of plan D1–D7 → open P1 implementation or adjust decisions.
