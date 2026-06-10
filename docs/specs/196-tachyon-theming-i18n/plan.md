# 196 — tachyon-theming-i18n — plan

_Drafted from `spec.md` on 2026-06-10. Update this file if implementation reveals the plan is wrong; do NOT silently diverge._

## Approach

_One or two paragraphs. The strategy in plain language — what we'll build, in what order, and why this shape (not just any shape)._

(1) formLogic validation → stable FormIssue codes (vscode-free; UI maps to l10n strings). (2) extension.ts + Sidebar.ts: all human strings wrapped in vscode.l10n.t ({n} placeholders). (3) AgentForm: studioStrings() resolved extension-side, shipped in init; HTML labels populated by id; codicon.css/ttf copied to dist/webview at build, loaded via asWebviewUri with font-src CSP; full token CSS (hover/placeholder/validation/focus/accent). (4) l10n/bundle.l10n.pt-br.json (116 entries) + package.nls{,.pt-br}.json + %key% contributions + "l10n" field; .vscodeignore ships them. (5) Drift guards as unit tests; live nls-resolution assert in integration; vitest vscode mock gains a placeholder-substituting l10n.t.

## Files to touch

_Concrete list of files to be created, modified, or deleted. Group by category if it helps._

**Create:** `l10n/bundle.l10n.pt-br.json`, `package.nls.json`, `package.nls.pt-br.json`, `test/unit/i18n.test.ts`.

**Modify:** `src/extension.ts` + `src/presentation/Sidebar.ts` (l10n wrapping, ~65 strings), `src/webview/AgentForm.ts` (strings payload + codicons + token CSS), `src/webview/formLogic.ts` (issue codes), `esbuild.mjs` (codicon copy), `package.json` (%keys%, l10n field, @vscode/codicons dep), `.vscodeignore`, vscode mock, integration suite, `README.md`.

**Delete:** none.

## Alternatives considered

_At least one rejected approach with its reasoning. If there genuinely was no alternative, state that explicitly ("no real alternative — only viable approach is X because Y")._

### Extension-level language setting (tachyon.locale)

Rejected: anti-pattern — no major extension does it; the editor's Configure Display Language is where that preference lives, and l10n follows it automatically.

### Localized strings inside formLogic

Rejected: would couple the pure logic layer to vscode and freeze message text into tests; stable codes + boundary mapping keeps both testability and translatability.

## Risks and unknowns

_What could go wrong, what we're not sure about, what assumptions we're making. Spell them out — surprises during implementation are usually pre-implementation risks that weren't named._

- Bundle/source drift as strings evolve — guarded by the completeness + placeholder unit tests (fail the suite on any new untranslated key).
- vscode-free layers (manager/tmux errors) surface English text inside localized toasts — accepted residual, documented.
- l10n.t keys are the English strings themselves — renaming a string is a translation-breaking change; the drift guard catches it immediately.

## Research / citations

_Sources consulted (docs, blog posts, code references) that informed this plan. Satisfies `.agent0/context/rules/research-before-proposing.md`._

- VS Code l10n API + package.nls docs; @vscode/codicons; webview CSP (font-src/style-src cspSource).
