# design-direction — sidebar-prototype (frontend-designer refine)

**UI impact:** ui (webview surface). **Done-proof:** EDH visual inspection only — this is a throwaway
visual prototype with **no UI-test runner** (`detect`: browser_renderable no). Evidence = the human driving
it in the Extension Development Host + a green `typecheck + check:engine-boundary + build`. This is **NOT a
UI-test proof** (honest-evidence path per the skill's native-surface rule).

## Feel
"Native VS Code, but denser and better-organized than the tree." It should be indistinguishable in vocabulary
from Agent Studio — same tokens, same sharpness — while solving the scale problem the tree can't (search,
grouping, tabs). Calm by default; color only where it carries meaning.

## Tokens (reuse — propose nothing new)
- text: `--vscode-foreground`; muted: `--vscode-descriptionForeground`.
- active/focus: `--vscode-focusBorder` (tab underline, input focus, cmdk border).
- surfaces: `--vscode-sideBar-background`, `--vscode-input-background`, `--vscode-list-hoverBackground`,
  `--vscode-list-inactiveSelectionBackground`, `--vscode-quickInput-background`.
- status (the ONLY color): running/ok = `testing-iconPassed`; needs/warn = `list-warningForeground`;
  crashed/err = `list-errorForeground`; idle/stopped = `disabledForeground`.
- radii: 2–4px (native sharpness; cmdk panel up to 6px). type: name 13/500, section 11/600 uppercase,
  meta 11 muted, badge 10.

## Surfaces to refine (bounded diff — one file)
1. **cmd+K palette (hero):** group results by section with small group headers; a footer legend (↑↓ navigate
   · ↵ open · esc); selected row uses list-activeSelection; trigger styled as an Agent-Studio input with the
   ⌘K/Ctrl K keycap. Larger hit targets, calmer panel.
2. **Tabs:** active = `focusBorder` underline + inactiveSelection fill; equal-width icon tabs (keep). Tighten.
3. **Status groups + rows:** clearer group header rhythm; agent name 13/500; **reserve color** — attention +
   verify + the status dot carry color; worktree/harness/resumable/fork become **muted** outline badges
   (less rainbow). Hover action overlay restyled to the toolbar idiom (`toolbar-hoverBackground`).
4. **Bridge footer:** quieter status-bar line (dot + label + muted meta), `sideBar` surface, top hairline.
5. **Motion:** keep only the row "flash" on cmd+K jump; wrap ALL transitions/animation in
   `@media (prefers-reduced-motion: reduce){ * { animation:none; transition:none } }`.

## Stop criteria (refine loop)
- Reads as the same product as Agent Studio (tokens/sharpness); color appears only on status/verify/attention.
- cmd+K is grouped + has a legend + keyboard-navigable; tabs/rows responsive at narrow widths (no overflow).
- Bounded to `SidebarPrototype.ts` (+ the two docs); the native tree untouched; build green. Max 2 visual passes.

## Out of scope
Wiring actions to real commands; reading real engine data; the native tree; any production architecture
(that's spec 237's phased plan — this is the visual prototype only).
