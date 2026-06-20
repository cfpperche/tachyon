# 237 — webview sidebar (Preact) replaces the tree — PLAN v3 (ADOPTION DECISION)

_Created 2026-06-19. v1 (full webview) → v2 (cautious: native-palliative-first + hybrid end-state, codex
×2) → **v3: DECISION — adopt the webview as THE sidebar; the native tree is retired.** The visual prototype
(`src/webview/SidebarPrototype.ts`) validated the UX in the EDH; the maintainer committed to full adoption.
This consciously overrides codex's "palliative-first / hybrid-forever" caution — rationale below._

## Decision
The Tachyon sidebar becomes a **single Preact webview**. The native `tachyonTree` is **retired** (deleted),
not kept as a permanent second UI. Rationale:
- The fleet view IS the product's core surface; the tree (a generic widget) can't do search / filter /
  virtualization / tabs / cmd+K — the things that matter at scale. A purpose-built sidebar is a real moat.
- Demand is real (large fleets make the tree unscrollable); the pattern is market-validated (GitLens Home,
  Continue, …); the prototype proved the UX.
- **Why not the v2 palliative/hybrid:** the goal isn't "relieve scroll" (palliative) — it's "unlock the
  richer surface" (only the webview gives it). And a permanent hybrid (tree for some sections + webview for
  agents) splits the UI = its own confusion + dual-maintenance cost. One great UI > two mediocre ones.

## Stack — Preact (decided)
- **Why a framework, why Preact:** the sidebar is live (re-renders on every fleet change), complex (cmd+K,
  virtual list of 100s, capability-gated per-row actions, tabs, scroll/collapse state). Manual `innerHTML`
  (today's inline-string webviews) loses scroll/focus/selection on every update — a framework with keyed
  reconciliation fixes it. **Preact** = React API/JSX/hooks at ~3KB (vs ~45KB React); ideal for an
  always-loaded sidebar. (The official `@vscode/webview-ui-toolkit` is deprecated → bring-your-own + theme
  with `--vscode-*`.) Lit was the runner-up; React rejected on bundle size.
- **Scope:** Preact is for the NEW sidebar ONLY. The existing simple webviews (`AgentForm`,
  `ServerInspector`) stay vanilla strings — rewriting working simple UIs is cost without benefit.

## Architecture — UI decoupled from rules (the load-bearing principle)
Two layers, separated from birth:
| layer | where | nature | tested |
|---|---|---|---|
| **rules (UI-agnostic)** | `src/sidebar/` (pure TS, NO vscode, NO preact) — agent-row **model** builder + **action matrix** (over `agentContextValue`) + the **command/action functions** (`{ws, agentName, …} → effect`, extracted off `AgentTreeItem`) | pure | ✅ unit |
| **UI (Preact)** | `src/webview/sidebar/*.tsx` — components render the model + dispatch actions via `postMessage`; bundled to `dist/webview/sidebar.js`, loaded via `<script src=asWebviewUri>` | view-only | EDH |
| **host glue** | `SidebarPrototypeProvider` (→ `SidebarViewProvider`) + the message router that maps webview actions → the rules layer; pushes model on engine change | thin, vscode-bound | dependency-guarded |

Because the rules layer is framework-agnostic, **the UI framework is swappable** — choosing Preact is low
risk (the expensive part — rules/model — never moves). This is exactly "UI desacoplada de regras."

## Build
- esbuild gains a **second entry**: `src/webview/sidebar/main.tsx` → `dist/webview/sidebar.js` (browser/iife,
  JSX→Preact, minified, vscode-free by nature). The extension entry (`src/extension.ts`) is unchanged.
- `tsconfig` gains JSX (`jsx: react-jsx`, `jsxImportSource: preact`) so `tsc --noEmit` checks the components.
- `check:engine-boundary` stays green: webview bundle imports preact, NOT vscode; the provider (in the
  allowlisted `src/webview/`) keeps the vscode import.

## Progress (2026-06-20)
Built incrementally + dogfooded in the EDH between each step (all green: typecheck ×2 + engine-boundary +
build + unit tests): Preact toolchain + visual port → live agents/terminals/bridge → capability-gated agent
actions (pure matrix) + real verify → all sections live → section actions + proposals → a11y first pass →
pipeline (def+node) actions + multi-root folder picker → **default FLIPPED: the webview is now the default
sidebar; the legacy tree is opt-in via `tachyon.sidebar.legacyTree` (deprecated, slated for removal).**
Remaining: deeper roving-arrow list a11y; soak; then DELETE the tree. All local (unpushed).

## Migration — flagged cutover, tree as TEMPORARY safety net (NOT permanent dual-UI)
1. **Deprecate the tree now** — a note in this spec + a code comment + a removal target = "when the webview
   ships as default". Forcing function. No refactor to the tree's rendering (it's frozen until deleted).
2. **Extract the rules layer** — model + action matrix + command functions (decouple handlers off
   `AgentTreeItem`; this is the prerequisite for deleting the tree, since commands currently need its
   instances). Tested. Tree keeps working (untouched or pointed at the shared fns with a 1-line adapter).
3. **Build the Preact sidebar** from the model — all sections, capability-gated actions, a11y, the codex gap
   list (proposals, pipeline node states, multi-root, bridge states, pins+notes, lifecycle-vs-attention),
   reading REAL fleet state. Behind `tachyon.sidebar.experimental` (tree still default).
4. **Ship → prove → flip** — dogfood in a real large fleet; when parity + a11y hold, flip the default to the
   webview.
5. **Delete the tree** — remove `tachyonTree` + the `*TreeItem` rendering + the flag. The rules layer stays.

**The one gate before deletion (quality, not date):** webview parity on the sections that matter **+ a11y
no worse than the native tree** (keyboard nav, roving tabindex/`aria-activedescendant`, screen-reader labels,
focus trap in cmd+K). The date is the ambition; if the gate isn't met, slip the date — never ship a regression.

## Codex gap list to honor in step 3 (fidelity + craft)
Gaps (from the prototype review): **Pending approval / proposals** section; **pipeline node states** (pending/
blocked/awaiting-approval/done/failed + reasons + per-node actions); **capability-gated agent actions** (the
full set: spawn/resume/promote/edit/clone/rename/delete/re-anchor/worktree review·PR·remove, gated by
`agentContextValue`) — not a uniform 6-icon set; **multi-root folder grouping**; **bridge states**
(down/auth/copy/inspect), not just connected; **pins + Notes + authorship + real checkbox**; **view toolbar**
(refresh/settings/new agent); **lifecycle vs attention** (don't bucket "needs input" as a lifecycle state —
group by root-agent lifecycle, attention as a signal, lineage preserved). Craft: cmd+K as a **command**
surface (actions + recents + fuzzy ranking, not just navigation); **virtualization** + persisted collapse/
scroll/filter; a11y; discoverable actions on keyboard/touch (not hover-only).

## Acceptance
- The Preact sidebar renders the real fleet from the rules-layer model; rules layer unit-tested (model +
  action matrix + command fns, incl. destructive); `tsc --noEmit` + `check:engine-boundary` + build (both
  bundles) green; dependency guard (the webview bundle imports no vscode; the host glue imports no rules
  duplication). Parity + a11y gate met before the tree is deleted. EDH dogfood in a large fleet.

## Out of scope
Rewriting `AgentForm`/`ServerInspector` to Preact; any engine/Bridge behavior change (the model reads existing
state); new agent features (this is a UI surface migration).

## History (for context)
v1 full-webview → v2 codex ×2 (palliative-first + hybrid, to de-risk) → prototype built + frontend-designer
refine (icon tabs, cmd+K, footer Bridge, native tokens) → codex prototype review (gap list above) → **v3
adoption decision (this doc).** Decision docs: `reference-research.md`, `design-direction.md`.
