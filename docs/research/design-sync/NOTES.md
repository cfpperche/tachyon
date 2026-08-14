# design-sync notes — tachyon

Recorded 2026-08-14 by agent `dsync` on branch `tachyon/tmp.dsync.20260814-124325-bde6`.
Run scope was **local build + validate only — nothing was uploaded and no project was created.**

## Blocker: this DS is Preact, the skill targets React

**This is the finding that matters. It is structural, not a config miss.**

`shared/ui` is "Pure Preact" (`tsconfig.webview.json`: `jsxImportSource: "preact"`, with
`react`/`react-dom` mapped to `./node_modules/preact/compat/`). The converter's preview harness
ships **real React** in `_vendor/react.js` + `_vendor/react-dom.js`, and every `<Name>.html` loads
those and mounts `window.TachyonDS.<Name>` with React.

`_ds_bundle.js` inlines preact (esbuild follows the barrel's own imports — `inlined npm packages: 1`).
So React calls a Preact function component, the component calls preact's hooks, and preact's hook
dispatcher reads `currentComponent.__H` on a component React never registered:

- `TypeError: Cannot read properties of undefined (reading '__H')` — 5 components
- `TypeError: Cannot add property updater, object is not extensible` — 4 components (React writing
  to a frozen preact vnode)

Measured on the final build: **17 components, 11 fall back to the typographic floor card, 6 attempt a
real render and 6/6 come out blank. Zero components render correctly.**

The skill's own Scope section states it: *"React design systems … a non-React DS has nothing for the
claude.ai/design agent to build with."*

**Do not read `validate` exit 0 as success here.** It exits 0 because floor cards "pass the gate by
design" — the floor card's own text ("The component is fully importable") is FALSE for this repo.
A green validate masks a total runtime incompatibility.

Any real attempt would need `_vendor/react.js` aliased to `preact/compat`, which lives in
`lib/emit.mjs`/`lib/bundle.mjs` — the two files the skill explicitly says not to fork. Treat this as
an upstream question, not a local workaround.

## Config that is correct and worth keeping

- **`--entry ./src/webview/shared/ui/index.ts`.** `package.json` `main` is `./dist/extension.js`
  (the VS Code extension host entry) and there is no `module`/`exports`. Pointing the converter at
  the package entry is wrong; the DS barrel is the entry.
- **`componentSrcMap` is mandatory here.** `dist/` ships no `.d.ts` (the webview build is esbuild,
  `noEmit: true`), so discovery found only the stray `types/markdown-plugins.d.ts` and reported
  `[ZERO_MATCH] no component exports — treating as tokens-only DS`. The 17 pins in `config.json` are
  what produce a component list at all. `shared/ui/kit/*` is NOT in the barrel and is therefore
  absent from the bundle — it would need `extraEntries`.
- **`tokensGlob` does NOT do what it sounds like.** It is not a way to point at repo-local CSS: in
  `lib/css.mjs`, `copyTokens()` returns immediately unless `tokensPkg` is set, and `tokensGlob` only
  filters files *inside* `node_modules/<tokensPkg>`. Setting `tokensGlob` to
  `dist/webview/tokens.css` silently copied nothing and left 49 `--ds-*`/`--tachyon-*` vars
  undefined. (It also expects a string — `.split('/')` — not an array.)
- **Use `cssEntry` for repo-local tokens.** `cssEntry` content is appended verbatim into
  `_ds_bundle.css`, which is inside the `styles.css` import closure. Concatenating
  `tokens.css + design-system.css` into `dist/webview/_ds-sync-entry.css` and pointing `cssEntry`
  there took missing vars **49 → 12**.
- **`extraFonts: ["dist/webview/faces.css"]`** ships the 4 JetBrains Mono `@font-face` rules and
  copies the woff2s into `fonts/`. `faces.css` must not go through `cssEntry` — its `url()`s are
  relative and would dangle.
- **The residual 12 `[TOKENS_MISSING]` are all `--vscode-*` and are correct.** VS Code injects them
  into the webview at runtime; they cannot ship. Do not chase them. (Known render warn.)

## Environment

- `node_modules` is a **symlink to the primary checkout** (`/home/goat/tachyon/node_modules`), shared
  by every worktree. Never install into it. The skill's `.ds-sync/` staging dir is worktree-local and
  is the right place (`esbuild`, `ts-morph`, `@types/react`, `playwright`).
- `@types/react` is genuinely absent from the shared tree (a Preact repo never needed it), so
  `[DTS_REACT]` fires on every run. Installing it into `.ds-sync/node_modules` does not silence it —
  the converter probes the tree passed to `--node-modules`.
- **playwright is not installed and the cached chromium builds do not match it.**
  `~/.cache/ms-playwright` has `chromium-1228`/`1237`; playwright 1.62.1 pins `1234`. Don't chase a
  version match — `package-validate.mjs` honors **`DS_CHROMIUM_PATH`**, so
  `DS_CHROMIUM_PATH=/usr/bin/google-chrome` runs the render check against the system Chrome.

## Re-sync risks

- `dist/webview/_ds-sync-entry.css` is a **generated concatenation** produced by hand
  (`cat tokens.css design-system.css > _ds-sync-entry.css`). `dist/` is gitignored and rebuilt by
  `npm run build`, so this file vanishes on a clean checkout and `cssEntry` then points at nothing.
  Regenerate it before any re-sync, or move the concatenation into the repo's own build.
- The `componentSrcMap` is a hand-maintained list of 17. It rots the moment a component is added to
  or removed from `shared/ui/index.ts` — nothing cross-checks it.
- No component was ever verified rendering. There are no authored previews and no grades, so there is
  no verified baseline for a future run to carry forward.
- Nothing was uploaded, so there is **no `_ds_sync.json` anchor in any project**. A future sync
  correctly re-verifies everything from scratch.
