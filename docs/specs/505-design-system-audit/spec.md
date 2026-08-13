# 505 — the design system, audited against the tree

_Created 2026-08-13 from t-749764. Measured on `bc6f5787`._

**Status:** draft — the route in §7 is a proposal; §8's questions are for the maintainer and several
slices depend on his answers.

Evidence: [`census.md`](./census.md) — every number in this document is a row there.
Questions for the maintainer: [`questions.md`](./questions.md).

---

## 1. Intent

Look at the Tachyon design system on the assumption that it can be **wrong**, and say — with numbers
and file names — which parts of it are decisions somebody made and which parts are residue nobody
chose. The maintainer's words: *"nao considere que o design system esta ok, nunca olhamos pra ele com
atencao, se estiver incorreto vamos refazer e refatorar tudo."*

**One constraint, and it is the only one:** colour comes from the VS Code theme, never from a Tachyon
palette. Tachyon lives inside the user's editor and must look like part of it.

Everything else is open — the spacing scale, the type scale, radius, control metrics, motion,
stacking, the split of tokens across files, and whether the set of tokens that exists is the set that
should exist. Two things this task's own brief had promoted to constraints were demoted by the
maintainer and are examined here like anything else: the agent pane not loading `design-system.css`,
and the Design Mode overlay not obeying `--ds-z-*`.

Out of scope by the maintainer's instruction: proposing a UI framework (Preact and esbuild stay) and
proposing a palette.

**This document changes no line of `src/`.**

## 2. Method

Every claim is a count over `src/webview/` with comments masked, or a computed style read from a real
browser. Where an earlier audit measured the same thing, both numbers and both dates appear, because
the delta is the finding. Where a claim is about what CSS *does* rather than what it says, it was
measured in headless Chrome (`census.md` §1.4) rather than reasoned about.

Three things this audit deliberately did NOT do: it did not treat the current files as a
specification to preserve, it did not accept a comment as evidence of behaviour, and it did not treat
"someone wrote a rule about this" as proof the rule holds. Six of the findings below are exactly a
written rule that the tree does not obey.

## 3. The verdict, in one page

**The design system is not one system. It is four token systems, two component systems and one
contract document, and none of the three layers agrees with the other two.**

That sentence is the whole finding, and it is measured:

- **Four places mint `--ds-*` tokens** — `design-system.css` (50), `quick-picker.css` (13),
  `agent-pane.css` (4 re-declared), `themeTokens.ts` (46, in TypeScript). A fifth and sixth mint
  parallel names for the same roles (`vscode-theme.css`'s 20 shadcn names, `tailwind-theme.css`'s 26
  `--color-*`). One concept — the card background — has four names: `--ds-card`, `--card`,
  `--color-card`, and `themeTokens`' `"--ds-card"` string.
- **`design-system.css` does not contain the design system.** It reads 13 tokens it never declares,
  121 times, 109 of those with no fallback. The tokens live in `quick-picker.css`, a file whose
  reason for existing is that the agent pane cannot load fonts.
- **That split is not merely confusing — on two surfaces it is broken.** `ui-gate` and `plugin-host`
  link `design-system.css` without `quick-picker.css`. Measured in Chrome: body text black, buttons
  with `border-width: 0`, badges with no status colour and no border, disabled buttons at full
  opacity, no focus ring. The mechanism is CSS-spec-level (invalid at computed-value time → `unset`),
  so no theme changes it.
- **Nothing detects that.** `SHELL_BASE_STYLESHEETS` — the constant that names the correct trio — has
  **zero consumers**. The test that "proves" it asserts the constant's *text* appears in `shell.ts`.
  The conformance test checks `design-system.css` only. A third test snapshots ui-gate's picker-less
  list as the correct order.
- **The scales govern a minority of the decisions they name.** 61% of raw spacing literals are off
  the declared 4/8 grid; the most-used spacing value in the product (`6px`, 155×) is not a step of it.
  10px is used 76× and the type scale stops at 11px. 130 of 223 radius declarations are not
  `--ds-radius`, under a styleguide that says "one radius". The motion tokens have zero uses.
- **The kit is real and is used** — 29 of 36 directories import `shared/ui`, which is more than the
  original task brief assumed. What surfaces build anyway is the measure: 10 implementations of a
  small bordered label, 7 cards, 4 status dots, 10 empty states, 6 spin keyframes, 55 raw `<button>`s.

The honest summary of "deliberate versus accumulated" is that **the decisions are almost all
deliberate and almost all under-enforced.** Someone chose 4/8 spacing, one radius, one button box, one
badge, and wrote each choice down with a reason. Nothing made the choice binding, so each surface's
author solved their own case locally, and after ~40 sheets the residue is larger than the rule. The
system does not need a new idea about spacing. It needs the ideas it already has to be the only way
to say the thing.

There is one exception to that pattern, and it is the reason a rewrite is on the table rather than a
cleanup: **the token layer's file structure was never designed at all.** It is the shape a sequence of
local fixes left behind, and it is the layer everything else rests on.

## 4. Finding by finding, with the verdict

Verdicts: **D** = deliberate (chosen, documented, still honoured) · **A** = accumulated (residue of
local fixes; nobody chose the current shape) · **B** = broken (it does not do what it says).

| # | finding | verdict | evidence |
|---|---|---|---|
| F1 | Colour comes from the VS Code theme, through fallback chains ending in a literal | **D** | all 20 colour tokens in the two shared sheets resolve through a `var(--vscode-*)` chain; the pattern is stated in three file headers |
| F2 | Tokens split across `design-system.css` + `quick-picker.css` by FONT, not by role | **A** | `quick-picker.css` was created for the pane's font problem (t-de3dfc) and became the home of every status colour by accident of what the pane needed |
| F3 | `design-system.css` reads 13 tokens it does not declare (121 refs, 109 no-fallback) | **B** | census §1.2 |
| F4 | `ui-gate` and `plugin-host` link half the pair | **B** | census §1.3–1.4; measured in Chrome |
| F5 | `SHELL_BASE_STYLESHEETS` has zero consumers; three tests lock the gap in | **B** | census §1.5 |
| F6 | `themeTokens.ts` is a 46-entry hand-written mirror of the CSS | **A** | census §1.8; already diverges on `--ds-border`, `--ds-hover`, `--ds-accent`, `--ds-muted` |
| F7 | The agent pane re-declares `--ds-1…4` and mints 12 private colour tokens | **A** | census §8; its own comment says "mirror … literals" |
| F8 | The pane's terminal palette is 21 hard-coded colours with no theme read | **B** (against the one constraint) | `agent-pane/App.tsx:135–154`; `themeTokens.ts` proves the vars are samplable |
| F9 | Spacing: 4/8 grid declared, 61% of raw literals off it, `6px` the most-used value | **A** | census §2 |
| F10 | Type: 35 distinct sizes; `10px` used 76× with no token; scale stops at 11px | **A** | census §3 |
| F11 | Radius: "one radius" declared, 21 in use | **A** | census §4 |
| F12 | Motion: `--ds-duration-1/2` and `--ds-ease` have zero uses; 6 spin keyframes, 5 names | **A** | census §5 |
| F13 | Stacking: 6 token uses against 22 raw integers, 3 of which are the tokens' own numbers | **A** | census §5 |
| F14 | The control box (`--ds-control-pad-*`, `--ds-control-line`, one shared rule) | **D** | `design-system.css:141–169`; written after two measured drifts, and it holds — one rule, three selectors, no copy |
| F15 | The Toast block is written twice in one file, and the copies have already drifted | **A** | census §7.3 |
| F16 | 10 dead `.ds-*` classes; `.ds-title` dead while `.ds-page-chrome-title` lives | **A** | census §7.2 |
| F17 | 10 implementations of a small bordered label; 7 cards; 4 status dots; 10 empty states | **A** | census §7.4–7.9 |
| F18 | 55 raw `<button>`s outside the kit — 37 at the 2026-07-20 audit | **A** | census §7.8; the two files that audit named have not moved, the growth is in newer surfaces |
| F19 | 404 direct `var(--vscode-*)` references over 77 distinct roles | **A** | census §6 — the token vocabulary is incomplete, so surfaces reach past it |
| F20 | `--ds-danger`, `--ds-radius-lg`, `--ds-large`, `--tachyon-ui-font` used, never declared | **B** | census §1.6 — four error affordances render in inherited colour |
| F21 | `STYLEGUIDE.md` cites `cockpit.css` (deleted) and `docs/plans/…` (never existed) | **B** | census §9 |
| F22 | The lint guards hex and z-index only | **D**, and correctly scoped | `check-webview-tokens.mjs` — it does exactly what it says; the finding is what is NOT guarded |

### 4.1 Two verdicts worth reading twice

**F14 is the counter-example that proves the rest is fixable.** The control box is the one place where
a shared fact is declared once and applied to all three consumers in a single rule. It exists because
the same 2px drift happened twice and the third fix stopped writing copies. Nothing about it is
cleverer than the badge or the card; it is only *unavoidable*. Every accumulated finding in this table
is a fact that stayed avoidable.

**F2 is the one to answer first, because it is upstream of F3, F4, F5 and F7.** The current split
asks: "does this rule need the font?" The split the product actually needs asks: "is this a value or a
face?" Those are different questions and the second one has never been asked.

## 5. Where two surfaces disagree, and which is right

Cited in full in `census.md`; the judgement is here.

| concept | side A | side B | which is right |
|---|---|---|---|
| **hover background** | `--ds-hover` = `var(--vscode-toolbar-hoverBackground, …)` — `design-system.css` via `quick-picker.css`, 4 uses | `--hover` = `var(--vscode-list-hoverBackground)` — `sidebar.css:7`, 8 uses | **B, for rows.** VS Code's own lists highlight with `list-hoverBackground`; a row that reads as a list row should match the editor's lists. `toolbar-hoverBackground` is right for icon hit targets. **Both are right and the token set is wrong** — it has one hover role where the product has two. |
| **status dot size** | `7×7` — `sidebar.css:204`, `board.css:44` | `8×8` — `worktrees.css:4`, `studio-frame.css:15` | **Neither is argued.** Two pairs, no reason recorded on either side. One value, chosen once, is right; which one is a maintainer call (see questions.md Q7). |
| **the same page title** | `.ds-title` — `font-weight: var(--tachyon-weight-semibold)`, no fallback, **dead** | `.ds-page-chrome-title` — `var(--tachyon-weight-semibold, 600)`, live | **B.** A has no markup and would render at weight 400 on any surface missing `quick-picker.css`. Delete A. |
| **`.chip-pill` vs `.tag-pill`** | `task-studio.css:39` | `pin-studio.css:8` | **Identical text but for `max-width`.** Neither is right; this is one component that was copied. |
| **card padding** | `--ds-4` (`.ds-card`) | `--ds-3 --ds-4` (`.approval-card`), `--ds-2 --ds-3` (`.card`), `12px` (`.rcp-card`), `6px 7px` (`.attention-card`) | **The scale is wrong, not the surfaces.** A board card and a settings card have genuinely different densities; the system offers one card and no density axis, so each surface invented one. |
| **left status rail** | `validations.css:54` — info → ok as work closes | `sidebar.css:487` — always `--ds-info`; `agent-studio-shell.css:56` — `focusBorder` | **A.** A rail that always shows one colour carries no information; the validations reading is the one that says something. |
| **error colour** | `--ds-err` (79 uses) | `--ds-danger` (4 live uses, **undeclared**) | **A**, trivially — and B's four rules are currently invisible. |
| **`--ds-border`'s fallback chain** | `quick-picker.css` — `widget-border → editorWidget-border → color-mix(fg 22%)` | `themeTokens.ts` — `… → panel-border → rgba(128,128,128,.35)`; `validations.css:53` — `… → panel-border` | **A is the source, and the other two are copies that already drift.** The disagreement is proof that a hand-kept mirror cannot hold. |
| **agent pane fg/border** | `--ds-fg` / `--ds-border` (loaded in the same document) | `--agent-pane-fg: var(--vscode-editor-foreground, …)`, `--agent-pane-border: … 18%` | **A.** The pane loads `quick-picker.css`, so both sets are live on one page; the private set differs on the anchor (`editor-foreground` vs `foreground`) and the mix (18% vs 22%) with no reason recorded. |
| **badge with a filled tone** | `.ds-badge` — outline only, 4 tones | `.ck-badge` — filled at 22%, tones `ok`/`muted` | **Both are legitimate and the system has room for one.** `settings.css:214`'s own comment says it did not want to invent a second chip language and did it because the shared one has no `muted`. The gap is real: a status label needs a *quiet* tone. |

## 6. The token set: what is missing, what is surplus, what is in the wrong file

### 6.1 Missing — roles the product demonstrably has and the system cannot name

Each row is backed by a count of what happens today instead.

| missing role | evidence | today |
|---|---|---|
| a step **below** `--ds-micro` (10px) | 76 uses, 14 files | raw `10px` |
| a **second hover** role (list-row vs toolbar-icon) | `--hover` invented in `sidebar.css`, 8 uses | a private token |
| a **page/editor background** name | `--vscode-editor-background` 68 direct uses | reaches past the layer; `--ds-editor-bg` exists only in `themeTokens.ts` |
| **menu** surface/foreground/selection | `--vscode-menu-*` 23 direct uses | 5 menu implementations, each anchoring itself |
| **selection** (active/inactive list selection) | `--vscode-list-activeSelection*` 12 uses | per-surface |
| **quiet/neutral status tone** (a `muted` badge) | `.ck-badge.muted` invented for it | a second badge language |
| **on-error foreground** (text on `--ds-err`) | `#fff` in `design-system.css:203` and `plugins.css`, the latter with a lint reason asking for the token | raw `#fff` |
| **inverted plate** (behind an image/QR so it survives a dark theme) | `#fff` in `human-inbox.css`, `pin-preview.css`, `rich-doc.css`, `settings.css` — **four lint exceptions, three of whose reasons ask for this token** | raw `#fff` ×4 |
| **code-block surface** | `--vscode-textCodeBlock-background` 14 uses | direct |
| **pass/fail testing roles** | `--vscode-testing-icon*` 17 uses | bypasses `--ds-ok`/`--ds-err` |
| **syntax/highlight roles** | ~30 raw hex in `activity.css` + `sidebar.css`, both with lint reasons saying "no `--ds` syntax roles" | raw hex |
| a **line-height scale** | 14 distinct values, one token (control-only) | raw |
| a **density axis** for cards/rows | 5 card paddings, 6 row paddings | per-surface |
| an **elevation** role beyond two shadows | 6 inline box-shadows, incl. one identical value in two files | raw |

### 6.2 Surplus — declared and doing nothing

| token / rule | why it is surplus |
|---|---|
| `--ds-duration-1`, `--ds-duration-2`, `--ds-ease` | zero uses; the product writes `.09s`, `.1s`, `.12s`, `120ms` by hand |
| `--ds-z-overlay` | zero uses |
| `--tachyon-weight-bold` | zero uses |
| `--ds-control-h` | zero uses (documented as derived; it is documentation, not a token) |
| `.ds-wrap`, `.ds-head`, `.ds-head-row`, `.ds-title`, `.ds-sub`, `.ds-reading`, `.ds-link-btn`, `.ds-backlink-slot`, `.ds-page-chrome--ruled`, `.ds-danger` | 10 dead classes, ~40 lines |
| the second Toast block (`design-system.css:701–782`) | a verbatim duplicate of lines 325–341, already drifted |
| `.ds-empty` | superseded by `.ds-empty-state`; still applied by 3 surfaces |
| `agent-studio-shell.css:53` `.ds-button` | targets a class that exists nowhere |

### 6.3 In the wrong file

| token(s) | is in | belongs in |
|---|---|---|
| `--ds-fg`, `--ds-muted`, `--ds-border`, `--ds-focus`, `--ds-ok`, `--ds-warn`, `--ds-err`, `--ds-hover`, `--ds-disabled-opacity`, `--ds-scrim`, `--tachyon-weight-medium`, `--tachyon-weight-semibold` (12) | `quick-picker.css` | the token file — none of them is a font |
| `--ds-z-dialog` | **both** files | one of them |
| `--ds-separator`, `--ds-sash-hover`, `--ds-surface`, `--ds-surface-raised`, `--ds-editor-bg`, `--ds-sidebar-bg`, `--ds-font-ui`, `--ds-color-scheme` (8) | `themeTokens.ts` only | the token file, if they are real roles (see questions.md Q4) |
| `--ds-1…4` | `agent-pane.css` (a copy) | the token file, reached by the pane instead of copied |
| `.ds-btn-label`'s rule | `sidebar.css:535` | with the component that emits it |

## 7. The route, in slices, in the order they pay

No rewrite. Each slice is independently landable and independently verifiable, and each one is
smaller because the one before it landed. Slices 1–3 are structural and do not change one rendered
pixel; that is deliberate — they are what makes the visual slices cheap and safe.

Every slice ends with a check that would have caught the thing it fixed, and no slice adds machinery
for a defect that has not happened (§4 F22 is the standing example of a guard that pays).

---

**Slice 1 — one token file, and prove it is reachable.** *(pays: unblocks everything; closes F3, F4, F5)*

Split the two shared sheets by what they *are* rather than by whether the pane can load them: one
sheet that declares tokens (no `@font-face`, no component rules), one that declares the type faces,
one that declares components. Every surface links the token sheet; the pane skips only the face
sheet. Then delete `SHELL_BASE_STYLESHEETS`'s zero-consumer status by making every host read it, and
extend the conformance test from "links `design-system.css`" to "links the token sheet".

Fail-before: a Chrome check like `census.md` §1.4 on `plugin-host`'s exact sheet list, red today.

Blocked on: questions.md **Q1** (is the pane's font restriction about faces or about tokens?).

**Slice 2 — one source for the tokens, no mirrors.** *(pays: closes F6, F7; removes a whole class of drift)*

Generate `themeTokens.ts`'s map from the token sheet instead of hand-writing it, or invert it — mint
in TypeScript and emit the CSS. Either direction is one source; the current arrangement is two.
Delete the pane's `--ds-1…4` copy in the same trail (Slice 1 makes them reachable) and put the pane's
12 private colour roles beside the shared ones, keeping only the ones that genuinely differ and
recording *why* for each survivor.

Blocked on: questions.md **Q2**, **Q3**.

**Slice 3 — delete what is dead.** *(pays: the file gets 15% smaller and stops teaching wrong things)*

The duplicate Toast block, the 10 dead classes, the 6 unused tokens, `.ds-button`, `.ds-empty`'s
three call sites migrated to `EmptyState`. Fix `STYLEGUIDE.md`'s two dangling references and
`--tachyon-mono`'s typo. Fix the four undeclared-token rules (F20) — they are currently invisible
error states.

Nothing here is a judgement call; it is the cheapest slice and it should not wait for an answer.

**Slice 4 — name the roles the product already uses.** *(pays: every later slice stops needing an exception)*

Add the missing tokens from §6.1 that are simply absent (10px step, second hover, editor background,
menu family, selection, quiet tone, on-error, inverted plate, code-block surface). Each one is
justified by a count, not by a design-system checklist. Then delete the lint exceptions those tokens
retire — the exception list shrinks as proof.

Blocked on: questions.md **Q5**, **Q6**.

**Slice 5 — one small-label component.** *(pays: the largest single duplication, 10 → 1)*

`Badge` grows the tones the product actually needs (including `muted`), and the 10 implementations in
`census.md` §7.4 migrate. Two of them (`.chip-pill`/`.tag-pill`) are literally one component copied.

**Slice 6 — one status dot, one card density axis, one row.** *(pays: closes F17's remainder)*

`StatusDot` has been on the promotion queue since 2026-07-20 and has grown from 3 to 4
implementations while it waited. The card needs a density axis rather than a second card
(§5, "card padding"). `ListRow` and `DenseRow` already exist; the 13 row classes get read against
them and either migrate or state what they need that the pattern lacks.

Blocked on: questions.md **Q7**, **Q8**.

**Slice 7 — the scales become the only way to say it.** *(pays: stops the regrowth)*

Extend the lint to the four dimensions it does not cover — raw `font-size`, raw spacing in
padding/margin/gap, raw `border-radius`, raw transition duration — in the same shape it already uses
for hex: existing debt listed per file with a reason, new values refused. The debt list IS the
migration backlog, and it shrinks by deletion.

This slice is last on purpose. Running it before Slices 4–6 would produce ~800 exception rows for
values that have no token to move to.

**Slice 8 — the surfaces, worst first.** *(pays: proportional to the counts)*

Order by measured debt, not by importance: `sidebar` (93 direct theme refs, 26 hex, 10 raw buttons,
4 private tokens), `activity` (69/32), `runtime-config` (44/3), `settings` (36/15), `rich-doc`
(20/3 + 18 raw buttons), `agent-pane` (§8), `board`, `agent-studio-shell`. Each is a separate task
with a before/after count and two-width visual evidence per the project's visual rule.

**Slice 9 — the two injected surfaces.** *(deferred on purpose)*

The Design Mode overlay and the IDE-browser bridge live in a third-party page, receive tokens by
injection, and are the only place `--ds-*` names exist that the CSS system never declares. They
should be reconciled *after* Slice 2 gives them one source to inject from, not before.

Blocked on: questions.md **Q9**.

---

### 7.1 What this route deliberately does not propose

- **No palette.** The constraint holds and it is right.
- **No framework change.** Out of scope by instruction.
- **No new spacing/type scale invented from taste.** §6.1 adds steps the product is already using
  76 and 155 times. If the maintainer wants a scale designed rather than discovered, that is
  questions.md **Q6**, and it changes Slice 4 only.
- **No "affected-file" tiering, partial caching, or a new gate.** Slice 7 extends the guard that
  exists, in the shape it already has.

## 8. Questions for the maintainer

Ten, each with the concrete case that raises it, in [`questions.md`](./questions.md). Slices 1, 2, 4,
6 and 9 are blocked on them. The rest can start.

## 9. Acceptance criteria for this SDD

- [x] The census exists as evidence, per primitive, with counts and file:line
- [x] Every finding carries a deliberate / accumulated / broken verdict
- [x] Every divergence cites both sides
- [x] Missing, surplus and misplaced tokens are listed with the count that justifies each
- [x] The route is slices in payment order, with the blocking question named per slice
- [x] The questions are separated from the answers
- [x] No line of `src/` changed
