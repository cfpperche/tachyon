# reference-research — sidebar-prototype (frontend-designer refine)

Surface: the Tachyon sidebar webview prototype (`src/webview/SidebarPrototype.ts`). Stack ladder **rung 1**
— reuse the existing project design language: **VS Code theme tokens (`--vscode-*`) + bundled codicons**, the
same vocabulary Agent Studio (`AgentForm.ts`) already uses. `detect`: framework unknown (extension webview),
design_system none (VS Code IS the system), browser_renderable no (EDH-inspected, not UI-tested).

| source | relevance | borrowed | rejected | consequence |
|---|---|---|---|---|
| `src/webview/AgentForm.ts` (Agent Studio) — the project's own webview | the in-house design language to match | active state via `--vscode-focusBorder` + `font-weight:600`; muted = `descriptionForeground`; inputs use `--vscode-input-*` + focus `outline:1px focusBorder offset -1px`; section labels 11px/600/uppercase/.04em; codicons | its 640px centered max-width + larger paddings (that's an editor-tab form, not a narrow sidebar) | tighten radii to 2–4px (native sharpness), reuse focusBorder/input/button tokens so the prototype reads as the *same product* as Agent Studio |
| GitLens Home view (2025) — VS Code-native rich sidebar | the bar for a premium native sidebar | status "cards" with color-coded **status pills** + **subtle** animation when active; slightly spacious density | heavy chrome / gradients / per-row borders (noisy at sidebar width) | group agents by status with a clear pill; reserve motion for state-change only |
| cmdk / Linear / Raycast palette patterns | the global search is the hero interaction | 4 parts = trigger + input + **grouped** results + **footer keyboard legend**; show ⌘K hint; label·hint·kind per row; fuzzy filter; ↑↓/↵/esc | dumping all items ungrouped; nested submenus (overkill) | add result **grouping by section** + a footer legend (↑↓ navigate · ↵ open · esc); keep the trigger styled like an Agent-Studio input |
| VS Code webview UX guidance + `vscode-reduce-motion`/`vscode-using-screen-reader` body classes | a11y + theme correctness | honor reduced-motion (kill the flash/transitions); rely on injected theme classes; keep contrast on `--vscode-*` | custom color palettes that fight the active theme | wrap motion in `@media (prefers-reduced-motion: reduce)`; never hardcode colors except as token *fallbacks* |

**Net direction:** less "custom UI", more "native VS Code, denser + better-organized than the tree". Reserve
color for **status semantics only** (running/needs/idle/stopped/crashed + verify + attention); everything else
muted-outline. Make cmd+K the polished hero (grouped + legend). Tighten the type/space rhythm to Agent Studio.
