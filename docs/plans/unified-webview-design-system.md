# Unified webview design system — implementation plan

> **Mission:** One design system consumed by every Tachyon webview; repeated UI is reusable components.

**Goal:** End multi-skin Control/sidebar/board drift by contracting tokens + primitives + product patterns, then migrating surfaces.

**Architecture:** Keep Preact + `--ds-*` over VS Code + existing `shared/ui` + `kit/` (342). Add **product patterns** (`PageChrome`, `ListRow`, `EmptyState`). Migrate high-pain surfaces first (Control embeds, Approvals/Validations). No big-bang Board rewrite. No second theme.

**Tech:** Preact, design-system.css, shared/ui, kit/vendor (gated), optional Tailwind only where already piloted.

**Style guide:** `docs/STYLEGUIDE.md` (source of rules).

---

## Phases

### Phase A — Contract (foundation) — **shipped 0.56.61**
- [x] `docs/STYLEGUIDE.md`
- [x] This plan
- [x] `PageChrome`, `ListRow`, `EmptyState` + CSS
- [x] Barrel export + unit tests
- [x] First adopters: Control ModuleChrome, Approvals

### Phase B — Control convergence — **shipped (remainder)**
1. [x] STYLEGUIDE Top-5 from fable review
2. [x] Validations → PageChrome + Button + EmptyState + `--ds-*`
3. [x] Runtime Ops → PageChrome + EmptyState
4. [x] Fleet / Worktrees / Deliveries → ListRow + Badge
5. [x] Overview → PageChrome
6. [x] Board head → PageChrome + primary Task + IconButton clear
7. [x] tmux/Inspector → PageChrome + Tabs + denser embed CSS
8. [x] Expand `MIGRATED_VIEWS` for Control family

### Phase C — Surface migration (ongoing)
Order: Sidebar → Board body → Activity/Handoff → remaining studios → probes/misc.  
Rule: when a feature already touches the surface, finish kit adoption in the same PR.

#### C.1 Sidebar (0.56.64)
- [x] Agent / section badges → shared `Badge`
- [x] Config error actions → `Button`
- [x] Empty slots → `EmptyState`

#### C.2 DenseRow (this PR)
- [x] Extract sidebar `ListRow` → shared `DenseRow` (`.row` DOM preserved)
- [x] Sidebar aliases `const ListRow = DenseRow`
- [ ] AgentRow itself still custom (tree/metrics) — out of scope

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
