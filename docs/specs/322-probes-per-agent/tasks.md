# 322 — probes-per-agent — tasks

_Generated from `plan.md` on 2026-07-01. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] `src/probe/probeView.ts`: `buildProbeView(records, now, caller?)` — filter rows + counts by `caller` when given; expose `caller` in the VM (panel title/empty state).
- [x] `src/workspace/Workspace.ts`: `probeView(caller?)` passes the filter through.
- [x] `src/webview/ProbeResultPanel.ts`: composite-key manager (`wsHash\u0000(caller|"*")`): open(wsHash, caller?) reveals-or-creates; refreshAll re-posts each entry with its own filtered view; per-entry dispose; workspace-dispose sweeps the prefix; per-agent title.
- [x] `src/extension.ts`: `tachyon.openProbes` handler accepts `(wsHash, agent?)`; no-arg = internal/debug unfiltered path (code comment); refresh hook stays correct for composite entries.
- [x] `src/sidebar/actions.ts`: `"probes"` ActionId + META (icon `beaker`/`search`, label "Probes") + `actionsFor` for `ai` rows (availability mirrors `activity`), never in `primaryActions`.
- [x] `src/webview/SidebarPrototype.ts`: `runAction` special case (like `activity`) → `tachyon.openProbes(wsHash, agent)`; REMOVE the `probes:` producer in `gatherOne`.
- [x] `src/webview/sidebar/App.tsx`: remove `ProbesBtn` + both render sites + `"openProbes"` from `GlobalOp`; `src/sidebar/types.ts`: remove `fleet.probes`.
- [x] `src/webview/probes/App.tsx` + `messages.ts`: caller-aware heading + honest empty state ("no probes launched by this agent").
- [x] `package.json`: remove the `view/title` probes button; suppress `tachyon.openProbes` from the command palette (project's existing pattern); verify no keybindings.
- [x] Surface audit (dueto F7): ripgrep `openProbes|ProbesBtn|fleet\.probes|probes:` across src/ + package.json; confirm cmd+K `searchIndex` never indexed probes.

## Verification

- [x] `buildProbeView` filters rows and counts by caller; caller-less records excluded from a filtered view; unfiltered view unchanged (probeView tests).
- [x] Empty-state VM: a caller with zero records yields an empty rows list + the caller in the VM (dueto F4 fold).
- [x] `"probes"` action offered for AI rows (any lifecycle state that offers `activity`), always in the more-menu, never for terminals (sidebarActions tests).
- [x] Full unit suite + typecheck green.

**Headless check:** `env -u TMUX npx vitest run test/unit/probeView.test.ts test/unit/sidebarActions.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`

**Verify:** `env -u TMUX npx vitest run test/unit/probeView.test.ts test/unit/sidebarActions.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`

## Dogfood

**Dogfood:** `env -u TMUX npx vitest run test/unit/probeView.test.ts -t "caller"`

**Human dogfood:** Rebuild + reload; in the sidebar confirm the header probes chip and the view-title probes button are GONE; open an agent's "…" menu → Probes → panel titled for that agent shows only its probes (this workspace has 26+ records, callers codex/claude); open a second agent's Probes panel side by side; confirm an agent with no probes gets the empty state; confirm the command palette no longer offers the global probes list.
