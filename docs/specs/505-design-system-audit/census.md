# 505 — census (evidence)

_Measured 2026-08-13 on tree `bc6f5787`, `src/webview/` only. Every number below is reproducible from
the working tree; the method for each table is stated with it. This file is EVIDENCE — the reading of
it lives in `spec.md`._

Method note that applies to every count: CSS and JS/TS comments are masked before counting, so a value
that appears only in prose is not counted. Where a number differs from an earlier audit, both numbers
and both dates are given, because the delta is the finding.

---

## 0. The corpus

| | count |
|---|---|
| directories under `src/webview/` | 36 |
| entries in the `WEBVIEW_SURFACES` manifest (`surfaces.ts`) | 26 |
| `.css` files under `src/webview/` | 44 |
| CSS lines | 6,004 |
| `.tsx` files | 93 |
| `.ts` files | 175 |

The 10 directories with no manifest entry are `approval`, `chat-bridge`, `design-mode-overlay`,
`ide-browser-bridge`, `pin-studio`, `rich-doc`, `task-prototype`, `task-studio`, `ui-gate`,
`validations`. Most are Control sections or shared render layers lazily imported by a host that does
have an entry; `design-mode-overlay` and `ide-browser-bridge` are injected into a third-party page.
"36 surfaces" is therefore a directory count, not a count of independently mounted pages.

---

## 1. Token systems

There are **six** places that mint custom properties for Tachyon UI. Four of them mint `--ds-*`.

| # | file | props | what it is |
|---|---|---|---|
| 1 | `shared/design-system.css` `:root` | **50** `--ds-*` / `--tachyon-*` | the declared source of truth |
| 2 | `shared/quick-picker.css` `:root` | **13** `--ds-*` / `--tachyon-*` | font-free layer; holds every status colour |
| 3 | `agent-pane/agent-pane.css` `:root` | **4** `--ds-*` re-declared + **12** `--agent-pane-*` | the pane's private palette |
| 4 | `ide-browser-bridge/themeTokens.ts` | **46** `--ds-*` / `--tachyon-*` | a hand-written TypeScript mirror |
| 5 | `shared/vscode-theme.css` `:root` | **20** unprefixed shadcn names | the shadcn bridge |
| 6 | `shared/tailwind-theme.css` `@theme` | **26** (`--color-*` ×19, font ×3, radius ×4) | the Tailwind namespace |

### 1.1 Which file declares what (the split nobody chose)

`quick-picker.css` — not `design-system.css` — declares the thirteen tokens below. Nine of them are
colour roles, including all four status colours.

```
--ds-fg  --ds-muted  --ds-border  --ds-focus  --ds-ok  --ds-warn  --ds-err  --ds-hover
--ds-disabled-opacity  --ds-z-dialog  --ds-scrim  --tachyon-weight-medium  --tachyon-weight-semibold
```

Combined use across `src/webview/`: `--ds-muted` 286×/35 files, `--ds-border` 231×/29 files,
`--ds-err` 79×, `--ds-warn` 76×, `--ds-fg` 64×, `--ds-focus` 41×, `--ds-ok` 32×.

### 1.2 `design-system.css` reads 13 tokens it does not declare

Counted by parsing the file's own `var()` references against its own declarations:

| token | references in `design-system.css` | of those, with NO fallback |
|---|---|---|
| `--ds-border` | 24 | 24 |
| `--ds-muted` | 20 | 20 |
| `--ds-fg` | 17 | 17 |
| `--ds-err` | 12 | 12 |
| `--ds-focus` | 11 | 9 |
| `--tachyon-weight-semibold` | 8 | 4 |
| `--ds-warn` | 7 | 6 |
| `--ds-ok` | 6 | 6 |
| `--ds-hover` | 6 | 5 |
| `--ds-disabled-opacity` | 6 | 6 |
| `--ds-scrim` | 2 | 0 |
| `--tachyon-mono` | 1 | 0 |
| `--tachyon-weight-medium` | 1 | 0 |
| **total** | **121** | **109** |

`--tachyon-mono` (line 667) is a typo for `--tachyon-font-mono`; it has a font-stack fallback, so the
typo is invisible and permanent.

### 1.3 The two surfaces that link one half of the pair

| surface | sheets linked | source |
|---|---|---|
| `ui-gate` | codicon, **design-system**, vscode-theme, ui-gate.tailwind | `ui-gate/gatePage.ts:11` |
| `plugin-host` (`tachyonPluginSurface`, `tachyonPluginSurfaces`) | codicon, **design-system**, plugin-host | `src/plugins/ui/host.ts:216` |
| `agent-pane` | xterm, **quick-picker**, agent-pane | `AgentPanePanel.ts:166` |
| every other surface | codicon, design-system, quick-picker, … | 24 hosts |

`agent-pane` links the half that carries the colours and skips the half that carries the font — which
is coherent with its stated reason. `ui-gate` and `plugin-host` link the half that carries the
components and skip the half that carries the colours.

### 1.4 Measured consequence of 1.3 (headless Chrome)

Method: two `file://` pages, identical markup (`.ds-btn`, `.ds-btn[disabled]`, `.ds-badge.ok`,
`.ds-badge.err`, `.ds-card`), identical `:root` block of Dark+ `--vscode-*` values plus a
`body { color: var(--vscode-editor-foreground) }` standing in for VS Code's injected default sheet.
Page A links `design-system.css` + `quick-picker.css`; page B links `design-system.css` only.
Computed styles read with `getComputedStyle` in `puppeteer-core` on `/usr/bin/google-chrome`.

| property read | A (both sheets) | B (design-system only) |
|---|---|---|
| `body` colour | `rgb(204,204,204)` | **`rgb(0,0,0)`** |
| `.ds-btn` colour | `rgb(204,204,204)` | **`rgb(0,0,0)`** |
| `.ds-btn` border-width | `1px` | **`0px`** |
| `.ds-btn` focus outline | `solid 1px rgb(0,120,212)` | **`none`** |
| `.ds-btn[disabled]` opacity | `0.5` | **`1`** |
| `.ds-badge.ok` colour | `rgb(137,209,133)` | **`rgb(0,0,0)`** |
| `.ds-badge.ok` border-width | `1px` | **`0px`** |
| `.ds-badge.err` colour | `rgb(241,76,76)` | **`rgb(0,0,0)`** |
| `.ds-card` border | `1px rgb(69,69,69)` | **`0px`** |

The mechanism is CSS-spec-level and theme-independent: an unresolvable `var()` with no fallback makes
the declaration **invalid at computed-value time**, which resolves to `unset` — `inherit` for `color`
(so `body` reaches `html`'s initial black and OVERRIDES VS Code's own later-losing default), `initial`
for `border`/`outline`/`opacity`. Nothing about the user's theme changes this.

Honest scope: today `plugin-host` renders only an `<iframe>` plus one `.plugin-host-empty` line that
carries its own colour, so the user-visible damage there is currently near zero — the breakage is
LATENT, and it is a shipped surface declared `conform`. On `ui-gate` (dev/test) the `IconButton` it
renders is measurably borderless and black.

### 1.5 What guards this today

- `shared/shell.ts:42` exports `SHELL_BASE_STYLESHEETS = ["codicon.css", "design-system.css", "quick-picker.css"]`. **Zero consumers** — `grep -rn SHELL_BASE_STYLESHEETS src/ test/` returns only the declaration. Every host writes its own array by hand.
- `test/unit/quickPickerPackaging.test.ts:18` asserts that the *string* `'["codicon.css", "design-system.css", "quick-picker.css"]'` appears in `shell.ts`. It proves the constant is written, not that anything reads it.
- `test/unit/webviewConvention.test.ts:287` checks `SHELL_DESIGN_SYSTEM_STYLESHEET` (`design-system.css`) only. A surface omitting `quick-picker.css` is `conform` by that rule.
- `test/unit/cssOrderSnapshot.test.ts:12` asserts ui-gate's exact four-sheet list — the picker-less one — as the correct order.

### 1.6 `--ds-*` used but never declared anywhere

| token | uses | files | effect |
|---|---|---|---|
| `--ds-danger` | 7 | `rich-doc.css` ×2, `task-studio.css` ×2, `agent-studio-shell.css` ×2 (as fallback), `rich-doc.css` border | `color: var(--ds-danger)` with no fallback → the four error affordances render in inherited colour, not red |
| `--ds-radius-lg` | 1 | `rich-doc.css:78` `.rd-import-picker` | no fallback → modal corners square |
| `--ds-large` | 1 | `probes.css:10` `h1` | falls back to `1.2em` ≈ 15.6px — a page title outside the scale |
| `--ds-fg-muted` | 1 | `studio-frame.css:44` | has fallback |
| `--tachyon-font-sans` | 1 | `studio-frame.css:46` inside a `font:` shorthand | fallback is `inherit`, invalid as a shorthand component |
| `--tachyon-ui-font` | 1 | `plugin-host.css:3` `font: var(--tachyon-ui-font)` | no fallback → whole `font` shorthand dropped |
| `--ds-color-scheme`, `--ds-editor-bg`, `--ds-font-ui`, `--ds-separator`, `--ds-surface-raised` | 8 | `design-mode-overlay/` | injected at runtime by `themeTokens.ts`; exist in no CSS file |

`agent-studio-shell.css:41` carries a comment stating that `--ds-danger` is not a defined token and
that the neighbouring fallback is therefore dead. The comment was written; the two live uses in
`rich-doc.css` and the two in `task-studio.css` were not fixed.

### 1.7 Declared and never used

`--ds-duration-1`, `--ds-duration-2`, `--ds-ease`, `--ds-z-overlay`, `--ds-control-h`,
`--tachyon-weight-bold` — six tokens, zero `var()` references in `src/webview/`.
(`--ds-control-h` is documented as derived-not-chosen; the other five are simply unused.)
All 19 `--color-*` names in `tailwind-theme.css` are consumed by the Tailwind compiler rather than by
`var()`, so their zero count is expected.

### 1.8 The TypeScript mirror

`ide-browser-bridge/themeTokens.ts` re-states the design system as a JS object literal (46 `--ds-*`/`--tachyon-*` keys). It is the only
declaration of `--ds-separator`, `--ds-sash-hover`, `--ds-surface`, `--ds-surface-raised`,
`--ds-editor-bg`, `--ds-sidebar-bg`, `--ds-font-ui`, `--ds-color-scheme` — eight roles the CSS system
does not name. It restates as literals `--ds-1…5`, `--ds-title`, `--ds-section`, `--ds-small`,
`--ds-micro`, `--ds-radius`, `--ds-border-width`, `--ds-icon-gap`, `--ds-control-pad-x/y`,
`--tachyon-weight-semibold`, `--tachyon-tracking-label`. Its header says it "mirrors design-system.css".

Where the mirror already diverges from the source:

| role | `design-system.css` / `quick-picker.css` | `themeTokens.ts` |
|---|---|---|
| `--ds-border` | `widget-border → editorWidget-border → color-mix(fg 22%)` | `widget-border → editorWidget-border → panel-border → rgba(128,128,128,0.35)` |
| `--ds-hover` | `toolbar-hoverBackground → color-mix(fg 12%)` | `toolbar-hoverBackground → rgba(128,128,128,0.15)` |
| `--ds-accent` | `button-background → focusBorder → textLink-foreground` | `button-background` only |
| `--ds-muted` | `descriptionForeground` (no literal) | `descriptionForeground → #9d9d9d` |
| `--ds-6`, `--ds-z-*`, `--ds-duration-*`, `--ds-ease`, `--ds-page-*`, `--ds-control-line` | present | absent |

---

## 2. Spacing

Method: every px literal appearing in a `padding`/`margin`/`gap`/`row-gap`/`column-gap` declaration in
`src/webview/**/*.{css,tsx,ts}`, comments masked.

| | count | share |
|---|---|---|
| `var(--ds-1…6)` references (all properties) | 513 | 38% |
| raw px literals in spacing properties | 838 | 62% |
| — of the raw px, ON the declared 4/8 grid (4, 8, 12, 16, 24, 32) | 327 | 39% of raw |
| — of the raw px, OFF the grid | **511** | **61% of raw** |

(Six negative offsets — `-1`, `-2`×2, `-4`, `-18`×2 — are excluded from both raw columns.)

Top raw values, with the number of files each appears in:

```
 6px ×155 (22 files)   8px ×123 (20)   4px ×100 (22)   12px ×86 (19)   10px ×77 (17)
 2px × 71 (23 files)   5px × 54 (17)   3px × 30 (12)   14px ×25 (13)    7px ×24 (11)
 1px × 21 (13)         9px × 12 ( 8)  18px × 11 ( 7)   16px ×10 ( 6)   20px × 8 (4)
```

Two facts inside that table:

- **`6px` is the most-used spacing value in the product (155 uses, 22 files) and is not a step of the scale.** It exists as `--ds-icon-gap: 6px`, a token named for one purpose (button/tab icon↔text) and used for six.
- `design-system.css:77` instructs: *"never raw odd values (7/10/14/18px)"*. Those four values account for **137 uses** across the product.

Radius, type and control paddings are declared but not scaled: `--ds-control-pad-y/x` (8/12) are read
by exactly one rule each — the shared control box.

---

## 3. Type

Method: every `font-size` declaration, comments masked. 35 distinct values.

| declared scale | value | uses via token | raw px uses of the same number |
|---|---|---|---|
| `--ds-title` | 16px | 5 | 3 |
| `--ds-body` | `var(--vscode-font-size, 13px)` | 12 | 12 (`13px`) |
| `--ds-small` | 12px | 129 | 52 |
| `--ds-micro` | 11px | 31 | 92 |
| `--ds-section` | 11px | 5 | — |

Values with **no token at all**:

```
10px ×76 (14 files)   9px ×16 (4)   14px ×10 (6)   12.5px ×6 (2)   28px ×3 (2)
18px ×2   22px ×2   24px ×2   9.5px ×2   26px ×1   17px ×1   13.5px ×1   10.5px ×1   30px ×1
plus 7 em-relative sizes (.92em, 1em, 1.05em, 1.12em, 1.25em, 1.4em, 1.2em)
```

**`10px` is used 76 times across 14 files and the scale's smallest step is 11px.** The product has a
step below `--ds-micro` that the token set refuses to name; every use of it is therefore raw by
construction.

`line-height`: 14 distinct values (1, 1.2, 1.25, 1.3, 1.35, 1.4, 1.45, 1.5, 1.55, 1.6, 1.65, 1.7, 0,
`var(--ds-control-line)`). One token exists, for the control box only.

`font-weight`: `600` raw ×52 (17 files) against `var(--tachyon-weight-semibold)` ×21 (5 files) and
`var(--tachyon-weight-semibold, 600)` ×5. Also `700` ×5, `500` ×2, `400` ×9, `650` ×1
(`pin-preview.css` — a weight the bundled font does not ship), `normal` ×1.

---

## 4. Radius

`STYLEGUIDE.md:46` — *"Radius: **`--ds-radius` only** (6px) | One radius"*. Measured, 21 distinct
values:

| value | uses | files |
|---|---|---|
| `var(--ds-radius)` | 88 | 19 |
| `4px` | 37 | 9 |
| `3px` | 27 | 9 |
| `6px` (raw — the token's own value) | 17 | 6 |
| `10px` | 11 | 5 |
| `5px` | 9 | 4 |
| `50%` | 8 | 6 |
| `8px` | 7 | 4 |
| `2px` | 3 | 2 |
| `999px`, `20px`, `16px`, `14px`, `12px`, `9px`, `7px`, `0`, `calc(--ds-radius - 2px)`, `var(--ds-radius-lg)` (undeclared), `var(--ds-radius, 4px)`, `var(--ds-radius, 6px)` | 1–2 each | |

Of **223 radius declarations, 88 use `var(--ds-radius)` plainly and 130 do not resolve to the single
token** (the remaining 5 are `var(--ds-radius, …)` / `calc(var(--ds-radius) − 2px)` variants). Three
of those variants restate the token's value as a fallback that disagrees with it — twice
`var(--ds-radius, 4px)` against a token that is 6px.

`design-system.css` itself uses four different radii: `--ds-radius` (buttons, cards), `5px`
(`.ds-input`, `[data-slot=select-trigger]`, `.ds-cf-preview`), `10px` (`.ds-badge`, `.ds-chip`,
`.ds-cf-panel`), `3px` (`:focus-visible`, `.ds-toast-dismiss`). The 6-vs-5 pair is documented at
line 158 as *"a real, separate design choice"*; the 10 and the 3 are not documented anywhere.

---

## 5. Elevation, motion, stacking

**Shadow.** `--ds-shadow-1` 1 use, `--ds-shadow-2` 6 uses. Six other box-shadows are written inline,
including `0 16px 40px color-mix(…)` twice (once in `design-system.css` `.ds-cf-panel`, once in
`quick-picker.css` `.ds-qp-panel` — the same value in two files) and `0 8px 24px rgba(0,0,0,.24)`
in `rich-doc.css`.

**Motion.** `--ds-duration-1` (120ms), `--ds-duration-2` (200ms), `--ds-ease`: **zero uses**. What is
actually written:

```
opacity .1s ×4      transform .12s ×2      background .09s, border-color .09s (+opacity) ×2
filter 120ms ease, opacity 120ms ease ×1    opacity 120ms ease ×1     none !important ×6
```

Six `@keyframes` under five names do the same thing — `to { transform: rotate(360deg) }`:
`spin` (`activity.css`), `spin` (`handoff.css`), `mc-spin` (`board.css`), `td-spin`
(`task-detail.css`), `mmd-spin` (`mermaid-block.css`), `ds-spin` (`design-system.css`). The
2026-07-20 audit in `shared/ui/README.md` recorded this as "4 surfaces own spin keyframes". It is 6
declarations across 6 files today.

**Stacking.** `--ds-z-popover: 20`, `--ds-z-dialog: 40`, `--ds-z-toast: 50`, `--ds-z-overlay: 60`.
Token uses: 6 total (`--ds-z-dialog` ×4, `--ds-z-toast` ×3, `--ds-z-popover` ×1, `--ds-z-overlay` ×0).
Raw integers, all outside the overlay: `2` ×6 (5 files), `3` ×4 (4), `20` ×3, `30` ×3, `5` ×2,
`40` ×2, `50` ×1, `100` ×1 — **22 raw**, against 6 token uses. Three of the raw values (20, 40, 50)
are the tokens' own integers written by hand.

---

## 6. Colour reaching past the token layer

Method: `var(--vscode-…)` occurrences in `.css`/`.tsx`, excluding the four files whose job is to mint
tokens (`design-system.css`, `quick-picker.css`, `vscode-theme.css`, `themeTokens.ts`).

**404 direct references across 26 files, touching 77 distinct VS Code variables.**

```
93 sidebar.css   69 activity.css   44 runtime-config.css   36 settings.css   20 rich-doc.css
17 agent-studio-shell.css   15 agent-pane.css   12 board.css   11 validations.css   11 handoff.css
10 probes.css    9 studio-frame.css   7 mermaid-block.css   7 engine-workspace.css   …
```

The most-referenced roles with **no `--ds-*` name in CSS**:

| VS Code variable | direct uses | note |
|---|---|---|
| `--vscode-editor-background` | 68 | the page background; named only in `themeTokens.ts` as `--ds-editor-bg` |
| `--vscode-editorWidget-background` | 27 | the raw source of `--ds-card`, used directly anyway |
| `--vscode-textCodeBlock-background` | 14 | code-block surface, unnamed |
| `--vscode-menu-*` (background/foreground/border/selection) | 23 | the entire menu family, unnamed |
| `--vscode-list-activeSelection*` / `inactiveSelection*` | 12 | selection role, unnamed |
| `--vscode-testing-iconPassed` / `iconFailed` / `iconQueued` | 17 | pass/fail, bypassing `--ds-ok` / `--ds-err` |
| `--vscode-badge-background` / `-foreground` | 6 | VS Code's own badge role, unnamed |
| `--vscode-inputValidation-*` | 4 | validation states, unnamed |
| `--vscode-charts-purple` | 3 | unnamed |
| `--vscode-gitDecoration-*` | 2 | unnamed |

**Raw hex**: 214 occurrences, 83 distinct values, in 23 files. `shared/ui/README.md`'s 2026-07-20
audit recorded "68 occurrences outside shared/vendor"; the same measure today (surface CSS only,
excluding `shared/`) is **109**.

```
45 ide-browser-bridge/themeTokens.ts   32 activity.css   26 sidebar.css   23 agent-pane/App.tsx
15 settings.css   14 agent-pane.css    9 probes.css    8 runtimeLogos.tsx    7 design-system.css
7 vscode-theme.css   6 quick-picker.css   3 runtime-config.css   3 rich-doc.css   3 ErrorBoundary.tsx  …
```

Most of these are the terminal literal of a `var(--vscode-x, #literal)` chain, which is the declared
pattern. The ones that are not:

- `agent-pane/App.tsx:135–154` — a **21-colour xterm.js theme with no theme read at all**. The pane's
  terminal renders `background: #1e1e1e`, `foreground: #cccccc` and a fixed ANSI-16 palette in every
  VS Code theme, including light ones. `themeTokens.ts` proves the host CAN sample
  `--vscode-terminal-ansi*` (it lists three of them among its probe vars); the pane does not.
- `agent-pane/agent-pane.css:232–233` — `#4ec9b0` written raw, duplicating `App.tsx:30`'s
  `stage: "#4ec9b0"`. One colour, two hand-kept copies.
- `board.css` `#0e70c0`, `settings.css` `#4443`/`#0002`, `CardTemplateBlock.tsx` `#4443` — carried in
  the lint's exception list with "replace with `--ds-…`" reasons.

**The lint's own exception list names the same missing token four times.** `human-inbox.css`,
`pin-preview.css`, `rich-doc.css` and `settings.css` each carry a `#fff` whose declared reason is a
plate behind an image/QR so it does not vanish on a dark theme; three of the four reasons literally
say a DS token should exist instead. `plugins.css`'s `#fff` reason asks for `--ds-on-err`.

---

## 7. Component census

### 7.1 The kit that exists

`src/webview/shared/ui/` exports 9 primitives (`Button`, `IconButton`, `Icon`, `Tabs`, `Chip`,
`Badge`, `Input`/`Textarea`/`Select`, `FieldRow`, `cx`), 5 product patterns (`PageChrome`, `ListRow`,
`DenseRow`, `EmptyState`, plus `QuickPicker`/`ConfirmForm`/`ToastProvider`) and 6 kit wrappers over
vendored shadcn/Radix. **29 of the 36 surface directories import from it.** The seven that do not:
`shared` (it *is* the kit), `probes`, `plugin-host`, `chat-bridge`, `design-mode-overlay`,
`ide-browser-bridge`, `task-prototype`. `agent-pane` counts as an importer on the strength of one
import — `QuickPicker` — and nothing else.

So the claim in this task's original body — "no component inventory" — is false at the level of the
directory. The inventory exists, is documented (`shared/ui/README.md`), and is imported nearly
everywhere. What is measured below is what surfaces build ANYWAY.

### 7.2 `.ds-*` classes with no markup using them

10 of the 95 `.ds-*`/`.kit-*` classes declared in the two shared sheets are referenced by no `.ts`,
`.tsx`, `.mjs`, `.js` or `.html` file in the repository:

```
.ds-wrap   .ds-head   .ds-head-row   .ds-title   .ds-sub   .ds-reading
.ds-link-btn   .ds-backlink-slot   .ds-page-chrome--ruled   .ds-danger
```

`.ds-title` is dead while `.ds-page-chrome-title` is live: the file carries two page-title rules and
only one of them is reachable. They also disagree — `.ds-title` writes
`font-weight: var(--tachyon-weight-semibold)` with no fallback, `.ds-page-chrome-title` writes
`var(--tachyon-weight-semibold, 600)`.

A further dead rule lives in a surface sheet: `agent-studio-shell.css:53` styles `.ds-button`, a class
that exists nowhere (the class is `.ds-btn`). And `Button.tsx:55` emits `.ds-btn-label`, which has no
rule in `design-system.css` at all — it is styled only by `sidebar.css:535`.

### 7.3 The Toast block is written twice

`design-system.css` declares 155 rules over 133 distinct selectors. The duplicates:

| selector | times |
|---|---|
| `.ds-toast-host`, `.ds-toast-stack`, `.ds-toast`, `.ds-toast > .codicon`, `.ds-toast-msg`, `.ds-toast-ctx`, `.ds-toast-dismiss`, `.ds-toast-dismiss:hover`, `.ds-toast--info`, `.ds-toast--info > .codicon`, `.ds-toast--ok`, `.ds-toast--ok > .codicon`, `.ds-toast--warn`, `.ds-toast--warn > .codicon`, `.ds-toast--err`, `.ds-toast--err > .codicon` | **2 each** |

Lines 325–341 and lines 701–782: the same 17 rules, once compactly and once expanded. They have
already drifted — the first copy writes `font-weight: 600` and `box-shadow: var(--ds-shadow-2)`, the
second writes `font-weight: var(--tachyon-weight-semibold, 600)` and
`box-shadow: var(--ds-shadow-2, 0 8px 24px rgba(0,0,0,0.28))`. The second wins by source order.

### 7.4 "A small bordered label" — 10 implementations

| class | file:line | font-size | padding | radius | border | fill |
|---|---|---|---|---|---|---|
| `.ds-badge` | `design-system.css:234` | 11px (`--ds-micro`) | `1px 9px` | `10px` | 1px `--ds-border` | none |
| `.ds-chip` | `design-system.css:253` | 12px (`--ds-small`) | `3px 10px` | `10px` | 1px `--ds-border` | `fg 8%` mix |
| `.ck-badge` | `settings.css:216` | **10px** | `1px 6px` | `4px` | **none** | tone at 22%/18% |
| `.ci-log-err-badge` | `engine-workspace.css:119` | **9px** | `0 5px` | **none** | 1px `--ds-err` | none |
| `.validation-pill` | `board.css:140` | 11px | `2px 6px` | `4px` | 1px `--ds-border` | `--ds-card` |
| `.next-tag` | `board.css:72` | **9px** | `0 var(--ds-2)` | `8px` | none | `--ds-btn-bg` |
| `.chip-pill` | `task-studio.css:39` | 12px | `1px 5px` | `--ds-radius` | 1px `--ds-border` | transparent |
| `.tag-pill` | `pin-studio.css:8` | 12px | `1px 5px` | `--ds-radius` | 1px `--ds-border` | transparent |
| `.pin-tag` | `sidebar.css:373` | **10px** | `0 5px` | `3px` | 1px `--ds-border` | transparent |
| `.hi-chip` | `human-inbox.css:423` | 12px | `--ds-1 --ds-2` | `--ds-radius` | `--ds-border-width` | `--ds-card` |

Four font sizes (9, 10, 11, 12px), six radii (none, 3, 4, 6, 8, 10px), five fills.
`.chip-pill` and `.tag-pill` are byte-identical except for `max-width` (`min(220px,100%)` vs `160px`)
— one is a copy of the other.

`settings.css:214` carries a comment naming the problem: *"Promote the subject; do not invent a second
chip language (`.ds-badge` is outline-style and has no `muted`)"*. It then declares the second chip
language, because the shared one has no `muted` tone.

### 7.5 "A status dot" — 4 implementations, 2 sizes

| class | file:line | size | states |
|---|---|---|---|
| `.sdot` | `sidebar.css:204` | **7×7** | 9 (`running`, `needs`, `throttled`, `idle`, `done`, `stopping`, `stop-failed`, `stopped`, `crashed`) — some with `box-shadow` glow, one with a border |
| `.dot` | `board.css:44` | **7×7** | colour set by callers |
| `.ck-wt-dot` | `worktrees.css:4` | **8×8** | 5 (`ready-to-remove`, `needs-review`, `occupied`, `record-only`, `locked`) |
| `.sf-dirty-dot` | `studio-frame.css:15` | **8×8** | 1 (dirty = `--ds-warn`) |

`shared/ui/README.md` lists `StatusDot` as a known gap from the 2026-07-20 audit ("sidebar, board,
attention cards" — three); it is four now.

### 7.6 "A card" — 7 implementations, 4 background anchors, 5 paddings

| class | file:line | background | radius | padding | border |
|---|---|---|---|---|---|
| `.ds-card` | `design-system.css:241` | `--ds-card` | `--ds-radius` | `--ds-4` (16) | 1px all round |
| `.card` | `board.css:61` | `--ds-card` | `--ds-radius` | `--ds-2 --ds-3` (8/12) | 1px all round |
| `.approval-card` | `approval.css:21` | `--ds-card` | `--ds-radius` | `--ds-3 --ds-4` (12/16) | 1px all round |
| `.validation-card` | `validations.css:52` | `--ds-card` | `--ds-radius` | none | 1px + **3px left rail** `--ds-info`→`--ds-ok` |
| `.rcp-card` | `runtime-config.css:9` | **`--vscode-sideBar-background`** | `--ds-radius` | `12px` | 1px all round |
| `.attention-card` | `sidebar.css:487` | **`list-hoverBackground` at 46%** | `4px` | `6px 7px` | 1px + **3px left rail** `--ds-info` |
| `.ci-card` | `engine-workspace.css:49` | none | none | `8px 10px` | **right + bottom hairlines only** |

Two independent "coloured left rail means status" inventions (`validations.css:54`,
`sidebar.css:487`) that do not agree on what the colour means: validations goes info → ok as work
closes, the sidebar's is always `--ds-info`. A third rail exists at
`agent-studio-shell.css:56` (`3px solid var(--vscode-focusBorder)`).

`validations.css` also writes fallbacks that contradict the tokens they back up:
`var(--ds-disabled-opacity, 0.86)` against a token whose value is `0.5`, and
`var(--ds-border, var(--vscode-panel-border))` against a token whose own chain never reaches
`panel-border`. A fallback is a second declaration of the same decision, and these two already
disagree with the first.

### 7.7 "A row"

| class | file:line | padding | separation |
|---|---|---|---|
| `.ds-list-row` | `design-system.css:407` | `--ds-2 --ds-3` (8/12) | full 1px border + `--ds-radius`, 8px gap between rows |
| `.row` (sidebar) | `sidebar.css:136` | `8px 12px` | none; hover fill only |
| `.runtime-ops-row` | `runtime-ops.css:202` | `--ds-3 --ds-2` (**12/8 — axes inverted**) | bottom hairline |
| `.type-row` | `activity.css:32` | `5px 6px` | radius 4px, no border |
| `.rtrow` | `plugins.css:88` | `5px 12px` | 1px border + `--ds-radius` |
| `.hi-row`, `.ash-row`, `.csh-row`, `.collrow`, `.dvrow`, `.kgrow`, `.ext-row`, `.tsh-row`, `.distill-row`, `.ck-device-row`, `.ck-pair-offer-row`, `.ps-stage-row`, `.td-ref-row` | 13 further row classes | | |

### 7.8 Buttons

| kind | count |
|---|---|
| the kit box (`.ds-btn` + `.ds-btn-primary` + `.ds-btn-danger`) | 1 |
| surface classes that build their own button box | 10 — `.agent-pane__btn` (+`--primary`, `--armed`), `.act` (sidebar 22×22), `.ps-icon-btn`, `.ck-metric-btn`, `.mmd-nav-btn`, `.init-btn`, `.handoff-btn`, `.prio-btn`, `.who-btn`, `.type-filter-btn` |
| surface sheets that restyle the bare `button` element | 4 — `runtime-config.css` (`.rcp-segmented button`), `runtime-ops.css` (`.runtime-ops-provider-control button`), `rich-doc.css` (`.rd-toolbar/​.rd-slash/​.rd-att-actions button`), `plugins.css` (`.seg button`) |
| surface sheets that override `.ds-btn` from outside | 8 — `runtime-config.css` ×2, `agent-studio-shell.css`, `inspector.css`, `settings.css`, `handoff.css` ×2, `sidebar.css` (`.act.ds-btn`) |
| raw `<button>` elements outside `shared/ui/` | **55** |

`STYLEGUIDE.md:65` — *"Never restyle bare `button` / `.ds-btn` in surface CSS"*. Measured: 12 sheets do.

The 55 raw `<button>`s against `shared/ui/README.md`'s 2026-07-20 audit of 37:

| file | raw `<button>` | vs 2026-07-20 |
|---|---|---|
| `rich-doc/toolbar.tsx` | 15 | 15 — unchanged |
| `sidebar/App.tsx` | 10 | 10 — unchanged |
| `design-mode-overlay/App.tsx` | 9 | new surface since the audit |
| `agent-pane/App.tsx` | 5 | — |
| `rich-doc/VisualsPanel.tsx` | 3 | — |
| 9 further files | 1–2 each | — |

The two files the audit named have not moved; the growth is entirely in surfaces built after it.

### 7.9 Empty states

`.ds-empty` (legacy, `design-system.css:310`) and `.ds-empty-state` (pattern, line 507) both live.
`.ds-empty` is applied directly by `plugins/App.tsx`, `runtime-config/App.tsx`, `task-detail/App.tsx`;
`.ds-empty-state` only by `patterns.tsx`'s `EmptyState`. Around them: `.ck-empty`,
`.attention-empty`, `.validation-empty`, `.rcp-capability-empty`, `.plugin-host-empty`,
`.ash-native-config-empty`, `.ci-log-empty`, `.ds-qp-empty` — **10 empty-state classes**.

### 7.10 The two overlay panels

`.ds-qp` (`quick-picker.css`) and `.ds-cf` (`design-system.css`) implement the same frosted scrim +
panel + head/body/foot. Their scrim rules, `@supports` fallbacks and `prefers-reduced-transparency`
blocks are identical text in two files. The panels disagree:

| | `.ds-qp-panel` | `.ds-cf-panel` |
|---|---|---|
| width | `min(480px, 100%)` | `min(520px, 100%)` |
| max-height | `min(70vh, 520px)` | `min(85vh, 640px)` |
| head padding | `10px 12px 6px` | `12px 14px 8px` |
| title size | 13px | 13px |
| subtitle size | 11px | 11px |

### 7.11 Hover and focus

**Hover background** — 13 distinct expressions in surface CSS:

```
var(--hover) ×8            var(--ds-hover) ×4         var(--ds-btn-hover) ×3
var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2))  ×3
var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.18)) ×2
var(--vscode-button-hoverBackground, var(--vscode-button-background)) ×2
var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.16)) ×1
var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)) ×1
var(--vscode-list-activeSelectionBackground) ×1     rgba(255,255,255,.28) ×1
color-mix(in srgb, var(--ds-fg) 8%, transparent) ×1
color-mix(in srgb, var(--ds-err) 6%, var(--ds-hover)) ×1
```

`--hover` is a sidebar-local token: `sidebar.css:7` defines it as `var(--vscode-list-hoverBackground)`,
while `--ds-hover` is `var(--vscode-toolbar-hoverBackground, …)`. **Two different VS Code roles for
one concept**, three files apart. The same block defines `--sel` and `--idle` — three private colour
tokens in the densest surface in the product.

**Focus ring** — `design-system.css:121` declares one globally
(`:focus-visible { outline: 1px solid var(--ds-focus); outline-offset: 1px }`). Thirteen surface rules
declare it again, with three colour sources (`--ds-focus`, `--vscode-focusBorder`,
`--agent-pane-focus`), two widths (1px, 2px) and four offsets (1px, −1px, 2px, none). Five of the
sidebar's are byte-identical to the global rule.

---

## 8. The agent pane, measured

The pane is the surface the original brief treated as constrained. What it actually does:

| | |
|---|---|
| `--ds-*` colour tokens used | **0** |
| `--ds-*` spacing tokens used | 4 — and it **re-declares all four itself** (`agent-pane.css:12–15`) |
| private tokens declared | 12 (`--agent-pane-bg/fg/muted/border/input-bg/input-fg/btn-bg/btn-fg/btn-primary-bg/btn-primary-fg/focus/pad`) |
| private button implementation | `.agent-pane__btn` + `--primary` + `--armed` |
| raw `<button>` | 5 |
| raw hex | 37 (21 of them the xterm palette) |

Where its private tokens and the shared ones disagree, **in the same document** (the pane DOES load
`quick-picker.css`, so both sets are live side by side):

| role | `quick-picker.css` (loaded) | `agent-pane.css` (also loaded) |
|---|---|---|
| foreground | `--ds-fg: var(--vscode-foreground)` | `--agent-pane-fg: var(--vscode-editor-foreground, #cccccc)` |
| muted | `--ds-muted: var(--vscode-descriptionForeground)` | `--agent-pane-muted: var(--vscode-descriptionForeground, #858585)` |
| border | `--ds-border: … color-mix(fg **22%**)` | `--agent-pane-border: … color-mix(fg **18%**)` |
| focus | `--ds-focus: var(--vscode-focusBorder)` | `--agent-pane-focus: var(--vscode-focusBorder, #007fd4)` |

`agent-pane.css:5` states the mechanism plainly: *"Spacing tokens below mirror design-system.css
`--ds-*` literals."* A hand-kept copy of a shared fact, which is the defect class this repository has
already paid for once (`t-0b7aa7`).

The font question is separable and is not the same question: the pane sets
`font-family: "DejaVu Sans Mono", …` on `#root` and `.agent-pane`, and passes its own font object to
`xterm`. Nothing about the four spacing values or the twelve colour roles is a font concern.

---

## 9. Contract documents against the tree

| claim | where | measured |
|---|---|---|
| "Values live in `src/webview/shared/design-system.css`" | `STYLEGUIDE.md:7` | 13 of the most-used values live in `quick-picker.css`; 45 more in `themeTokens.ts` |
| "Radius: `--ds-radius` only (6px). One radius" | `STYLEGUIDE.md:46` | 21 distinct radii; 128 of 216 declarations are not the token |
| "Space: `--ds-1…6` … not ad-hoc `12px 16px`" | `STYLEGUIDE.md:48` | 838 raw px spacing literals, 511 off the grid |
| "never raw odd values (7/10/14/18px)" | `design-system.css:77` | 137 uses |
| "Never restyle bare `button` / `.ds-btn` in surface CSS" | `STYLEGUIDE.md:65` | 12 sheets do |
| "Shell reset lives in `cockpit.css` (linked last)" | `STYLEGUIDE.md:120` | `cockpit.css` does not exist (deleted in SDD 485); `activity.css:5` still relies on it in prose |
| "Plan: `docs/plans/unified-webview-design-system.md`" | `STYLEGUIDE.md:9`, `:143`, `shared/ui/README.md:3` | `docs/plans/` does not exist |
| "there is always exactly ONE library" | `shared/ui/README.md` | true for Preact components; false for tokens (4 mints) and for CSS primitives (§7.4–7.9) |

The lint `scripts/check-webview-tokens.mjs` guards exactly two things: raw hex and numeric z-index.
It does not guard raw font-size, raw spacing, raw radius, raw duration, a `var()` on an undeclared
token, a duplicate rule, or a dead class. Everything in §2, §3, §4, §5 and §7 is invisible to it.
