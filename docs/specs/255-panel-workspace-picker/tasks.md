# Spec 255 — tasks

A focused, single-change fix (no new module). UI proof is a manual multi-root check (a `showQuickPick` can't be driven headless); correctness rests on reusing the already-shared, in-use `pickWorkspace()` rather than new logic.

**Verify:** `npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit && bash scripts/check-engine-boundary.sh && env -u TMUX npx vitest run`

## Steps

- [x] **Step 1 — route the two panel-open commands through `pickWorkspace()`.** `tachyon.openPlugins` + `tachyon.openProjectHandoff` (`src/extension.ts`) now resolve `hash ? byHash(hash) : await pickWorkspace()` and open with a concrete `wsHash`; the panel managers' `open(hash?)` contract is untouched (D2). No silent `getWorkspaces()[0]` on the multi-root path.
- [ ] **Step 2 — manual multi-root verification.** Open two Tachyon folders; via the Command Palette and the sidebar 🧩 button confirm the "Which folder?" QuickPick appears and the chosen folder is the panel target; confirm single-folder opens with no prompt; confirm zero-folder warns.

## Closure
**Closure:** _(filled at ship.)_
