# l10n

The extension manifest points here (`"l10n": "./l10n"`). That is the VS Code language
architecture: `vscode.l10n.t()` in source, contribution titles in `package.nls.json`,
and locale files in this directory when a translation exists.

The product language is English (`t-92bf17`). There is no translation bundle.

`l10n.t` returns the source string when no locale bundle is present. An English
`bundle.l10n.json` is an extraction artifact for translators, not a runtime input.
The one that used to live here was hand-maintained (no `@vscode/l10n-dev`), stale,
and blind to aliased calls, so it was removed rather than kept as a lying catalog.

## When translation returns

Add `bundle.l10n.<locale>.json` (source English string → translation) and
`package.nls.<locale>.json` (contribution keys). Do not invent a completeness gate
until there is a locale to protect.

Regex extraction of `l10n.t("...")` misses 304 strings that pass through
`const t = vscode.l10n.t`:

| file | line | hidden strings |
|---|---|---|
| `src/webview/controlStrings.ts` | 5 | 129 |
| `src/webview/WorktreesPanel.ts` | 278 | 83 |
| `src/webview/TmuxPanel.ts` | 262 | 54 |
| `src/webview/RuntimeConfigPanel.ts` | 137 | 38 |

Any extractor has to follow the alias, or half the product stays untranslated.
The previous pt-BR gate used that regex and never ran (not in `.tachyon/githooks`).
