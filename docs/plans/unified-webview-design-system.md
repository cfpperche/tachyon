# Unified webview design system — implementation plan

> **Mission:** One design system consumed by every Tachyon webview; repeated UI is reusable components.

**Goal:** End multi-skin Control/sidebar/board drift by contracting tokens + primitives + product patterns, then migrating surfaces.

**Architecture:** Keep Preact + `--ds-*` over VS Code + existing `shared/ui` + `kit/` (342). Add **product patterns** (`PageChrome`, `ListRow`, `EmptyState`). Migrate high-pain surfaces first (Control embeds, Approvals/Validations). No big-bang Board rewrite. No second theme.

**Tech:** Preact, design-system.css, shared/ui, kit/vendor (gated), optional Tailwind only where already piloted.

**Style guide:** `docs/STYLEGUIDE.md` (source of rules).

---

## Phases

### Phase A — Contract (this PR / foundation)
- [x] `docs/STYLEGUIDE.md`
- [x] This plan
- [ ] `PageChrome`, `ListRow`, `EmptyState` + CSS in `design-system.css`
- [ ] Barrel export + unit tests
- [ ] README adoption pointer
- [ ] First adopters: Control `ModuleChrome` → `PageChrome`; Approvals resolve buttons → `Button`

### Phase B — Control convergence
1. Approvals + Validations full Kit buttons + PageChrome head (drop duplicate h1 chrome or wrap)
2. Runtime Ops minimal PageChrome
3. Inspector/tmux: align toolbar density; avoid fighting Control tabs
4. Fleet/Worktrees/Deliveries → `ListRow`
5. Board: PageChrome-compatible head only (search/actions stay)

### Phase C — Surface migration (ongoing)
Order: Sidebar → Board body → Activity/Handoff → remaining studios → probes/misc.  
Rule: migrate on touch + dedicated slices for top traffic.

### Phase D — Forcing functions
- Extend `test/unit/webviewComponentKit.test.ts` (ban new hand-rolled product buttons in target dirs)
- Optional scoreboard of legacy-only surfaces
- Dogfood: Control all 12 tabs after chrome PRs

### Phase E — Token unify (t-7ff4c2)
- Single radius (`--ds-radius` ← shadcn `--radius`)
- Single status vocabulary
- Finish kit pilots without dual paradigms

---

## Non-goals
- Replace tmux/terminal UI
- Mobile companion DS fork
- Radix Tooltip/Dialog until preact/compat gate green
- Rewriting Board kanban layout in one shot

---

## Board mapping
| Existing task | Role |
|---------------|------|
| t-e8bfb5 | STYLEGUIDE (superseded/partial by docs/STYLEGUIDE.md) |
| t-eaa94d | ListRow |
| t-7ff4c2 | token/paradigm reconcile |
| t-b0a229 | surface-by-surface migration |
| t-c7e518 | tooltip/dialog gate |

---

## Verification
```bash
npm run typecheck
npx vitest run test/unit/webviewComponentKit.test.ts test/unit/uiPatterns.test.ts
# dogfood: open Control, walk tabs Overview→Settings
```

## First ship acceptance
- STYLEGUIDE + plan on main
- Three patterns importable from `shared/ui`
- Control module pages use PageChrome
- Approvals Approve/Deny use `Button`
- Tests green
