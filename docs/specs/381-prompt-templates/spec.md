# 381 — prompt-templates

_Created 2026-07-14._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**UI impact:** flow
<!-- Palette + sidebar agent action inject named prose into a live agent composer.
     Visual QA: QuickPick labels, confirmation detail, sidebar overflow action label. -->

## Intent

Operators re-type the same human→agent prompts many times in a day ("review this
diff for auth risk", "status in 5 bullets + next step", "run the check and report
only failures"). That friction is not model amnesia — it is missing **operator
macros**: short, named, workspace-local prompt templates the human can inject into
the command bar (composer) of the agent they choose.

Tachyon already has the delivery channel (`tmux.sendKeys` / `write_input`) and
already has spawn-time **role** contracts and shell **commands:**. Neither is a
reusable mid-session human prompt library.

**Done** means: a workspace can keep named prompt templates under `.tachyon/`; a
human picks a template and a running AI agent; Tachyon stages (default) or
submits the body into that agent's live composer; busy recipients refuse submit
the same way direct delivery already does; templates are clearly not shell
commands, not role contracts, and not part of `tachyon.yml`.

## Storage (locked)

User/operator prompt snippets live in the workspace under:

```text
.tachyon/prompts/<id>.md
```

- **`<id>`** — stable slug (`[a-zA-Z][a-zA-Z0-9_-]*`), same naming spirit as
  agents/commands; used as the picker key and file stem.
- **Body** — the markdown file content after optional frontmatter is the exact
  text staged/submitted into the agent composer (no secret Tachyon wrapper
  unless the human put it in the file).
- **Optional YAML frontmatter** for display metadata only:

  ```markdown
  ---
  title: Review auth module
  ---
  Review only auth-related changes.
  Flag correctness + regression risk.
  Do not edit code unless I ask.
  ```

  - `title` (optional string) — QuickPick label; when absent, the picker uses `<id>`.
  - Unknown frontmatter keys are ignored (forward-compatible), not fatal.
  - Missing/empty body after frontmatter → template is skipped or surfaces as
    unloadable (honest empty-library path).

**Not stored in `tachyon.yml`.** Project process config (agents, shell commands,
schedules) stays in yml; operator macros are user/workspace runtime data under
`.tachyon/`, consistent with pins, tasks, roles, activity.

Whether `.tachyon/prompts/` is git-tracked is the team's call (same stance as
other `.tachyon/*` artifacts) — Tachyon does not force ignore or force commit.

## Acceptance criteria

- [ ] **Scenario: load templates from `.tachyon/prompts/`**
  - **Given** one or more `.tachyon/prompts/<id>.md` files in the workspace
  - **When** the inject flow lists templates
  - **Then** each valid file becomes a selectable template with id, optional title, and body; malformed names or unreadable files are skipped with a clear diagnostic, not a crash

- [ ] **Scenario: inject template into a chosen running agent (stage, default)**
  - **Given** at least one running AI agent and at least one loadable template
  - **When** the human runs **Tachyon: Inject Prompt Template…**, picks a template, then an agent, and confirms
  - **Then** the template body is pasted into that agent's live pane **without** submitting Enter, and a short notification confirms stage (not submit)

- [ ] **Scenario: optional submit now**
  - **Given** a running AI agent that is not busy (`working` / `throttled`) and whose composer is not occupied by a draft
  - **When** the human chooses the submit variant after picking template + agent
  - **Then** the body is delivered with submit, using the hardened submitted-line path when available

- [ ] **Scenario: busy agent refuses submit**
  - **Given** the target agent attention is `working` or `throttled` (or composer draft occupied when submit would clobber)
  - **When** the human chooses submit
  - **Then** Tachyon refuses with a clear message and does not paste+Enter into a live turn; stage-only remains available

- [ ] **Scenario: destination picker only offers valid targets**
  - **Given** stopped, dead, non-AI terminal entries, and running AI agents
  - **When** the agent picker is shown
  - **Then** only running AI agents are selectable

- [ ] **Scenario: empty library / no targets are honest**
  - **Given** zero loadable templates, or zero valid running agents
  - **When** the inject command runs
  - **Then** Tachyon notifies clearly (including that templates live under `.tachyon/prompts/`) and does not open a broken empty picker path that implies success

- [ ] **Scenario: sidebar action on a running AI agent**
  - **Given** a running AI agent row in the sidebar
  - **When** the human opens the overflow menu
  - **Then** an **Inject prompt template** action is available; it pre-selects that agent and only asks for the template (+ stage vs submit)

- [ ] **Scenario: templates are distinct from commands, roles, and yml**
  - **Given** `commands:` (shell one-shots), agent `role` / `instructions` (spawn contracts), and `tachyon.yml`
  - **When** a human uses prompt templates
  - **Then** injection never runs a shell command, never rewrites role/yml `instructions`, and never requires a `prompt_templates:` (or similar) key in `tachyon.yml`

- [ ] README (or operator docs) mentions `.tachyon/prompts/<id>.md` so discovery matches runtime
- [ ] i18n: new command titles / notifications in en + pt-BR with existing drift guards green

## Non-goals

- Storing templates in `tachyon.yml` (rejected — operator macros ≠ project process config).
- Placeholder / variable expansion (`{{module}}`) — v1 bodies are fixed prose from the file.
- Bridge tools (`list_prompt_templates` / `inject_prompt_template`) — v1 is human UI only.
- A full Studio CRUD tab for templates — v1 is file-based; create/edit as markdown under `.tachyon/prompts/`.
- Cloud sync, usage ranking, or auto-suggest from context.
- Replacing or extending `role` templates / re-anchoring (spec 216) or `.tachyon/roles/`.
- Replacing shell `commands:` (spec 199).
- Auto-submitting staged pastes on a timer.
- Multi-agent fan-out of one template in a single action.
- Watching prompts for live reload UI beyond re-reading on each inject (v1 can readdir on demand).

## Open questions

_None blocking v1 — locked in conversation 2026-07-14 / 2026-07-14 (storage flip):_

- **Storage:** `.tachyon/prompts/<id>.md` (not `tachyon.yml`).
- **Default delivery:** stage into composer (`submit: false`); submit is explicit.
- **Audience:** human operator UI only in v1.
