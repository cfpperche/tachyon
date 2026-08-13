# 505 — questions for the maintainer

_Ten questions. Each one is a place where the audit found something that could be a product
requirement or could be the shape one person's fix left behind, and the difference changes the
work. The instruction that produced this file: **"se ficar duvida do que e requisito e o que pode ser
refatorado me pergunte"** — so nothing below is decided here._

Each question states the concrete case, what the two (or three) answers cost, and which slice of
`spec.md` §7 is waiting on it. Where I have a recommendation I say so and why; the recommendation is
an argument, not an answer.

---

## Q1 — Does the agent pane's font problem justify the pane having no TOKENS, or only no FACES?

**The case.** `agent-pane.css:3` says: *"Do NOT load design-system.css (Tachyon Mono `@font-face`
breaks cell metrics)"*. That is a statement about **type faces**. What the pane actually lost is
**tokens**, and it rebuilt them:

- `agent-pane.css:12–15` re-declares `--ds-1: 4px; --ds-2: 8px; --ds-3: 12px; --ds-4: 16px` under a
  comment that says *"Spacing tokens below mirror design-system.css `--ds-*` literals"* — a hand-kept
  copy of a shared fact.
- `agent-pane.css:17–27` mints 12 private colour tokens (`--agent-pane-fg`, `--agent-pane-border`, …).
- `.agent-pane__btn` + `--primary` + `--armed` is a fourth button implementation.
- The pane **already loads `quick-picker.css`**, so `--ds-fg`, `--ds-border`, `--ds-focus`,
  `--ds-ok/warn/err` are live on that page right now — and its private set disagrees with them:
  `--ds-fg` anchors to `--vscode-foreground` while `--agent-pane-fg` anchors to
  `--vscode-editor-foreground`; `--ds-border` mixes at 22% while `--agent-pane-border` mixes at 18%.

Nothing in the four spacing values or the twelve colour roles is a font concern. The pane is already
proof that a sheet can carry tokens without carrying `@font-face` — that is exactly what
`quick-picker.css` does.

**The two answers.**

- **(a) The restriction is about faces.** Then the fix is to split the token declarations out of
  `design-system.css` into a face-free sheet the pane links, and the pane's 16 private declarations
  mostly disappear. Cost: Slice 1 + Slice 2. Benefit: the pane rejoins the system and one class of
  hand-kept copy dies. *(This is my recommendation — the evidence is that the pane wanted tokens and
  built its own rather than that it wanted independence.)*
- **(b) The restriction is about the pane being its own thing.** Then the private tokens are correct
  and should be *documented as a second, deliberate design language*, with the differences (18% vs
  22%, `editor-foreground` vs `foreground`) stated as choices rather than left as accidents.

**Blocks:** Slice 1, Slice 2.

---

## Q2 — Is the terminal's hard-coded palette a decision, or the one place the constraint is broken?

**The case.** `agent-pane/App.tsx:135–154` gives xterm.js 21 literal colours — `background: "#1e1e1e"`,
`foreground: "#cccccc"`, and a fixed ANSI-16 set — with no theme read anywhere. In a light VS Code
theme the agent terminal renders as a dark box inside a light editor.

This is the only measured place where the product's single stated constraint — *a cor vem do tema do
VS Code* — does not hold. And it is not a capability gap: `ide-browser-bridge/themeTokens.ts:45–47`
already lists `--vscode-terminal-ansiGreen/Yellow/Red` among the variables it samples, and VS Code
exposes the full `--vscode-terminal-ansi*` family.

**The two answers.**

- **(a) A terminal is not product chrome.** Agent output is a terminal, terminals are conventionally
  their own colour world, and a stable palette makes agent output comparable across users. Then this
  stays, and the lint exception's reason (*"terminal cells are not product chrome"*) is the final
  word — but it should say "decided", not "no `--ds` equivalent".
- **(b) It is the constraint, and it applies.** Then the pane samples `--vscode-terminal-ansi*` and
  the editor background/foreground, and the light-theme case stops being a dark rectangle.

I do not have a recommendation here; it is genuinely a product call about what a terminal *is*. What I
can say is that the current state is not a decision anyone recorded — the reason written in the lint
describes a gap, not a choice.

**Blocks:** Slice 8 (agent-pane).

---

## Q3 — `themeTokens.ts` mirrors the CSS by hand. Which direction should the one source run?

**The case.** `ide-browser-bridge/themeTokens.ts` is a 46-entry TypeScript object that re-states the
design system so Design Mode can inject it into a third-party page. Its header says it *"maps them to
`--ds-*` exactly like design-system.css"*. It already does not:

| role | CSS | the mirror |
|---|---|---|
| `--ds-border` | `widget-border → editorWidget-border → color-mix(fg 22%)` | `… → panel-border → rgba(128,128,128,0.35)` |
| `--ds-hover` | `toolbar-hoverBackground → color-mix(fg 12%)` | `toolbar-hoverBackground → rgba(128,128,128,0.15)` |
| `--ds-accent` | `button-background → focusBorder → textLink-foreground` | `button-background` only |
| `--ds-6`, `--ds-z-*`, `--ds-duration-*`, `--ds-page-*` | present | absent |

This repository has already paid for a hand-kept copy once (`t-0b7aa7`), and the project guidance
names that defect class.

**The three answers.**

- **(a) CSS is the source; generate the TS.** A build step parses the token sheet's `:root` into the
  map. Familiar direction, no runtime cost, one more build step.
- **(b) TS is the source; emit the CSS.** The tokens become data, and both the sheet and the injector
  are outputs. Strongest guarantee, biggest change, and it makes the design system a build artifact
  rather than a file a designer can open. *(My recommendation is (a), for exactly that last reason —
  someone should be able to read and edit the design system as CSS.)*
- **(c) Neither; a test asserts they match.** Cheapest, and the weakest — a test that compares two
  hand-written lists still lets them be written twice.

**Blocks:** Slice 2.

---

## Q4 — Eight `--ds-*` roles exist only in `themeTokens.ts`. Are they real, or overlay-only?

**The case.** `--ds-separator`, `--ds-sash-hover`, `--ds-surface`, `--ds-surface-raised`,
`--ds-editor-bg`, `--ds-sidebar-bg`, `--ds-font-ui`, `--ds-color-scheme` are injected into the Design
Mode overlay and are declared in **no CSS file**. Two of them look like roles the whole product wants
and lacks: `--ds-editor-bg` (`--vscode-editor-background` is referenced directly **68 times** across
26 files) and `--ds-surface`/`--ds-surface-raised` (the card/nested-card distinction that §6.1 shows
every surface inventing).

**The two answers.**

- **(a) They are real product roles.** Then they move into the token sheet, and 68 direct theme
  references get a name to use. *(Recommended for `--ds-editor-bg`, `--ds-surface`,
  `--ds-surface-raised`, `--ds-separator` — each is backed by a count. `--ds-sash-hover` and
  `--ds-color-scheme` look genuinely overlay-specific.)*
- **(b) They are overlay-specific.** Then they should be namespaced as such (`--dm-*`), so nobody
  reads `--ds-` and assumes the design system declares it — which is exactly the confusion that
  produced the `--ds-danger` and `--ds-ok` mistakes already on record.

**Blocks:** Slice 4, Slice 9.

---

## Q5 — Is a literal white plate behind an image an exception to "colour comes from the theme"?

**The case.** Four files carry a raw `#fff` for the same reason, and three of the lint's own
exception reasons ask for a token that does not exist:

- `human-inbox.css` — *"QR/image plate background so a dark-on-dark code does not vanish; no `--ds`
  inverted-plate token yet — add one to the DS rather than keep extending this."*
- `pin-preview.css` — *"Sketch-image plate so a transparent PNG does not sit on the editor background;
  same inverted-plate gap."*
- `rich-doc.css` — *"Sketch-node plate, same inverted-plate gap."*
- `settings.css` — the card-template QR plate.

A QR code and a transparent sketch PNG need a light surface to be legible, in every theme. That is a
functional requirement of the content, not a style preference — which is why it may be a legitimate
exception rather than a violation.

**The two answers.**

- **(a) It is an exception, and it deserves a name.** Add `--ds-plate` / `--ds-plate-fg` (a literal
  light surface plus its foreground), document *why* it is the one non-theme colour, and delete four
  lint exceptions. *(Recommended — four independent authors reached the same conclusion, which is the
  definition of a role.)*
- **(b) It is a violation.** Then the answer is a theme-derived plate (e.g. always the lighter of
  editor background and foreground) and the QR/PNG rendering changes to match. More correct in
  principle; needs a legibility check on real content.

**Blocks:** Slice 4.

---

## Q6 — Should the scales be *discovered* from what the product uses, or *designed* and migrated to?

**The case.** The declared spacing scale is 4/8/12/16/24/32 with a comment forbidding 7/10/14/18.
Measured across `src/webview/`:

- **511 of 838 raw spacing literals (61%) are off that grid.**
- **`6px` is the most-used spacing value in the entire product — 155 uses across 22 files — and is
  not a step.** It exists only as `--ds-icon-gap`, a token named for one purpose and used for six.
- The four forbidden values account for **137 uses**.
- The type scale is 16/13/12/11. **`10px` is used 76 times across 14 files** and there is no step
  below 11.

So the real grid in use is a **2px grid** (2, 4, 6, 8, 10, 12, 14, 16, 20, 24), and the real type
ramp has a 10px step. The declared scales describe a product that does not exist.

**The two answers.**

- **(a) Discover.** Make the scale the values the product actually uses — spacing `2 4 6 8 12 16 24
  32`, type `10 11 12 13 16` — and the migration is mostly mechanical: raw `6px` becomes a token
  named for 6px. Cheap, honest, and it makes Slice 7's guard enforceable immediately. *(Recommended.)*
- **(b) Design.** Decide the scale you want the product to have, then migrate ~800 call sites to it.
  This is a real design act with a real cost, and it is the only path if the answer to "is 6px right?"
  is "no, it should have been 8 all along". If you want this, it is one focused design pass and then
  Slice 8 grows considerably.

The same question applies to the **type ramp**: 5 sizes for 36 surfaces is tight, and the product
answered by inventing 30 more. Whether the answer is "add 10px" or "the ramp is wrong" is yours.

**Blocks:** Slice 4, and the size of Slice 8.

---

## Q7 — One status dot or none? (And 7px or 8px?)

**The case.** Four implementations, two sizes, no reason recorded on any of them:

| | size | states |
|---|---|---|
| `sidebar.css:204` `.sdot` | **7×7** | 9 — `running`, `needs`, `throttled`, `idle`, `done`, `stopping`, `stop-failed`, `stopped`, `crashed`; some with a `box-shadow` glow, one with a border, one hollow |
| `board.css:44` `.dot` | **7×7** | caller-coloured |
| `worktrees.css:4` `.ck-wt-dot` | **8×8** | 5 |
| `studio-frame.css:15` `.sf-dirty-dot` | **8×8** | 1 |

`shared/ui/README.md` has listed `StatusDot` as a known gap since **2026-07-20**, when it counted
three implementations. It is four now — the queue is losing.

The size question is trivial. The real question is underneath it: **the sidebar's nine dot states with
glows and hollows are a status LANGUAGE**, not a component variant. Either that language is the
product's status vocabulary and everything else should speak it, or the dot is a sidebar-only device
and the rest of the product should use `Badge`.

**The three answers.** (a) One `StatusDot`, sidebar's 9-state language promoted. (b) One `StatusDot`
with 4–5 states; the sidebar keeps its extra states as documented local density. (c) No shared dot;
`Badge` everywhere except the sidebar. I lean (b) — nine states is a lot to ask every surface to
learn, and the sidebar has a density nothing else has.

**Blocks:** Slice 6.

---

## Q8 — Does Tachyon have ONE density or TWO?

**The case.** `STYLEGUIDE.md:119` says *"Default density: sidebar-like (11–13px labels, tight gaps).
Control matches sidebar mono stack."* But the product also has genuine reading surfaces, and they
already behave differently:

- `--tachyon-font-reading` exists (8 uses, 6 files) and `.ds-reading` (line-height 1.55) is declared —
  and is **dead**, applied by no markup.
- `rich-doc.css:40` sets `font-size: 14px; line-height: 1.55; font-family: var(--tachyon-font-reading)`
  for the editor body — by hand, not through the dead class.
- `activity.css` and `handoff.css` carry 7 em-relative font sizes (`.92em` … `1.4em`) that appear
  nowhere else.
- Card padding ranges from `6px 7px` (sidebar attention card) to `--ds-4` (16px, `.ds-card`) — a 2.5×
  spread that no token names.

So the product behaves as if it has two densities and the token set describes one.

**The two answers.**

- **(a) Two densities, named.** A `dense` / `comfortable` axis on the shared primitives, with the
  reading surfaces (activity, task detail, rich-doc, handoff) declaring themselves comfortable. Then
  `.ds-reading` gets revived or replaced, and the card gets a density prop instead of a seventh card.
  *(Recommended — the surfaces already diverged; naming it is cheaper than fighting it.)*
- **(b) One density.** Then activity/rich-doc/handoff are wrong and Slice 8 tightens them to the
  sidebar ramp, which is a visible change to the surfaces people read the most.

**Blocks:** Slice 6.

---

## Q9 — Is the Design Mode overlay part of the design system, or a guest in a foreign page?

**The case.** The overlay is injected into a third-party page, lives in a shadow root, uses
`z-index: 2147483647`, and consumes six `--ds-*` names that exist in no CSS file (Q4). The lint
carries five z-index exceptions for it, each with a reason arguing that the product `--ds-z-*` scale
*cannot* name that layer — *"the product `--ds-z-*` scale describes our chrome, not a page we do not
control"*.

That argument is good for the `:host` value (2147483647 against a page whose stacking we do not own).
It is weaker for the **internal** 1/2/3 the overlay uses inside its own shadow root — those are its
own chrome, and `--ds-z-*`'s absence there is not a foreign-page problem, it is that the scale starts
at 20 and has no names for local layering.

This one was on my own list of "constraints" until you removed it, so I am asking rather than assuming.

**The two answers.**

- **(a) A guest.** Its stacking and its private tokens are correct; namespace them (`--dm-*`) so they
  stop reading like design-system tokens, and the exception list keeps its reasons.
- **(b) A surface.** Then it obeys the scale *inside its own root*, and the scale grows the low names
  it lacks (`--ds-z-local-1/2/3`, or a documented "inside a component, use 1/2/3").

**Blocks:** Slice 9.

---

## Q10 — Three token namespaces exist. Which one is the future?

**The case.** This is not a proposal to change framework — both of these are already in the tree. It
is a question about which one is being migrated *to*.

| namespace | file | props | consumers |
|---|---|---|---|
| `--ds-*` | `design-system.css` + 3 others | **70 distinct names across 4 mints** | every surface |
| shadcn unprefixed (`--background`, `--primary`, `--card`, …) | `vscode-theme.css` | 20 | vendored shadcn source; 13 hosts link the sheet |
| `--color-*` + `--radius-*` + `--font-*` | `tailwind-theme.css` `@theme` | 26 | Tailwind utilities; 5 surfaces ship a `tailwind.css` entry |

One concept — the card background — has four names. `vscode-theme.css:48` bridges `--radius` back to
`--ds-radius` with a comment saying they *"MUST"* agree; nothing enforces it. Spec 342's kit is real
and used (`KitSelect`, `KitDropdown`, `KitPopover`, `KitFilePicker`), but `KitTooltip`/`KitDialog` are
still gated on the preact/compat check and `shared/ui/README.md` still records that gate as open.

**The three answers.**

- **(a) `--ds-*` is the system; shadcn/Tailwind is an implementation detail behind the kit.** Then the
  bridge is generated from `--ds-*` rather than written beside it, and no surface writes a Tailwind
  colour utility. *(Recommended — it keeps one vocabulary for the people writing the product, and it
  is closest to where the tree already is.)*
- **(b) shadcn is the system; `--ds-*` becomes a legacy alias layer.** Coherent, and much larger — it
  would mean the design system's names come from an upstream library rather than from Tachyon.
- **(c) The Tailwind pilot is stalled and should be closed.** 5 of 36 surfaces after three specs is a
  fact worth reading. If the answer is (c), Slice 3 grows to include removing the sheets.

**Blocks:** nothing immediately — but it decides whether Slice 4's new tokens need a shadcn twin, so
answering it before Slice 4 saves doing that twice.
