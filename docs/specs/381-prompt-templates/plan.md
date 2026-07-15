# 381 — prompt-templates — plan

_Drafted from `spec.md` on 2026-07-14. Update this file if implementation reveals the plan is wrong; do NOT silently diverge._

## Approach

Add a small **PromptStore** that readdir's `.tachyon/prompts/*.md` on demand (no
config reload, no yml key). Human entry points: command palette
(`tachyon.injectPromptTemplate`) and a sidebar overflow action on running AI
agents (`tachyon.injectPromptTemplateItem`). Both funnel into one pure-ish inject
flow: pick template → pick agent (skipped when preselected) → pick stage|submit →
confirm preview → deliver via existing `tmux.sendKeys` / `sendSubmittedLine`.

Submit reuses the busy gate spirit of `write_input` (refuse `working` /
`throttled` / occupied composer). Stage always pastes without Enter.

## Key decisions

- **Storage under `.tachyon/prompts/<id>.md`** — operator macros, not process
  config; rejected `tachyon.yml` `prompt_templates:` (maintainer lock).
- **On-demand readdir** — no file watcher in v1; each inject reloads the library.
- **Optional YAML frontmatter `title` only** — unknown keys ignored; body after
  frontmatter is the inject payload. Files without frontmatter: whole file is body,
  title = id.
- **Default stage** — matches Activity internal share (spec 324) and the approved
  prototype; submit is an explicit second QuickPick option.
- **No Bridge tools / Studio CRUD in v1** — file edit is the authoring surface.
- **Sidebar action next to reanchor / reinjectContinuity** — same “mid-session ops
  on running AI” family.

## Files touched

**Create:**
- `src/prompts/PromptStore.ts` — list/parse templates from `.tachyon/prompts/`
- `src/prompts/injectFlow.ts` — pure helpers: valid targets, submit refusal, preview cap
- `test/unit/promptStore.test.ts` — parse + list + skip malformed
- `test/unit/injectFlow.test.ts` — target filter + busy gate

**Modify:**
- `src/extension.ts` — register palette + item commands; orchestrate QuickPicks + delivery
- `src/sidebar/actions.ts` — `injectPrompt` action id + matrix gate
- `src/webview/SidebarPrototype.ts` — ACTION_CMD map
- `package.json` / `package.nls.json` / `package.nls.pt-br.json` — commands + palette visibility
- `test/unit/sidebarActions.test.ts` — gate for injectPrompt
- `README.md` — short operator note under roles/instructions neighborhood

## Risks & unknowns

- **extension.ts has embedded NULs** (pre-existing) — edit carefully via exact
  string replace / scripted splice so we don't corrupt the file further.
- **Composer race** — stage can still land next to a draft; v1 accepts that (same
  as Activity share); submit refuses occupied composer.
- **i18n drift** — package.nls keys must exist in en + pt-BR (`test/unit/i18n.test.ts`).

## Visual impact

QuickPick labels, confirm modal detail, sidebar overflow label “Inject prompt
template”. Prototype already validated the flow
(`docs/specs/381-prompt-templates/prototype.html`). Product chrome is native VS
Code QuickPick/notification — no new webview.

## Sources consulted

- `docs/specs/381-prompt-templates/spec.md` + approved `prototype.html`
- `src/activity/activityShare.ts` / `ActivityPanel.shareToAgent` — stage-only paste pattern
- `src/bridge/tools.ts` `write_input` — busy / composer refuse
- `src/continuity/ContinuityStore.ts` — markdown frontmatter parse pattern
- `src/sidebar/actions.ts` — action matrix
- `src/pins/PinStore.ts` — `.tachyon/` store layout conventions
