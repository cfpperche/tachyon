# 258 — sidebar-pin-copy — plan

## Approach

Reuse the existing sidebar section-action path instead of introducing a command or Bridge tool. The webview only asks for `pin:copy`; the extension host resolves the workspace, looks up the pin by ID in `PinStore`, formats the stable text payload, and writes it with `vscode.env.clipboard.writeText`.

## Files touched

- `src/webview/sidebar/App.tsx` — add a copy icon button to each pin row's inline action bar.
- `src/webview/SidebarPrototype.ts` — handle `pin:copy`, use `PinStore` as the source of truth, and notify on success.
- `test/unit/sidebarPrototype.test.ts` + `test/mocks/vscode.ts` — cover clipboard output and the stale-webview-title case.
- `l10n/bundle.l10n.pt-br.json` — translate the new toast key.

## Validation

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npx --yes @vscode/vsce package --allow-package-secrets --out /home/goat/tachyon/tachyon-0.39.1.vsix`
