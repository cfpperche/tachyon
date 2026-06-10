# 192 — tachyon-pins-notes — plan

_Drafted from `spec.md` on 2026-06-10. Update this file if implementation reveals the plan is wrong; do NOT silently diverge._

## Approach

_One or two paragraphs. The strategy in plain language — what we'll build, in what order, and why this shape (not just any shape)._

`src/pins/PinStore.ts` (vscode-free, sync fs, lazy .tachyon/ creation, precise errors) → 5 Bridge tools in tools.ts (deps.pins + onPinsChanged callback) → sidebar PinsProvider (Notes shortcut item + checkbox TreeItems, completed sink) + package.json contributions (view, ✚/notes/🗑 commands, menus) → extension wiring (createTreeView + onDidChangeCheckboxState → setDone; .tachyon/* watcher; addPin accepts an optional text arg for automation; `tachyon._pins` internal command for integration asserts). Validation pyramid as established: unit → host integration → live claude -p E2E.

## Files to touch

_Concrete list of files to be created, modified, or deleted. Group by category if it helps._

**Create:** `src/pins/PinStore.ts`, `test/unit/pins.test.ts`.

**Modify:** `src/bridge/tools.ts` (+5 tools, deps.pins), `src/presentation/Sidebar.ts` (PinsProvider/PinTreeItem), `package.json` (view/commands/menus), `src/extension.ts` (wiring), `test/unit/{bridge,auth}.test.ts` (deps + 12-tool expectations + pins round-trip), `test/e2e/bridge-host.ts`, `test/integration/extension.test.js`, `README.md`.

**Delete:** none.

## Alternatives considered

_At least one rejected approach with its reasoning. If there genuinely was no alternative, state that explicitly ("no real alternative — only viable approach is X because Y")._

### Extension globalStorage for pins/notes

Rejected: right for secrets (the token), wrong for knowledge — invisible, unversionable, unreadable to MCP-less agents. Workspace files give four doors.

### Single markdown file (pins parsed out of notes.md)

Rejected: parsing markdown to render sidebar checkboxes is fragile; JSON for the machine, markdown for prose.

### Cancel ("an agreed NOTES.md does it")

Genuinely weighed (does ~80%); user chose to buy the remaining 20% (sidebar, convention-free tools, UI pinning).

## Risks and unknowns

_What could go wrong, what we're not sure about, what assumptions we're making. Spell them out — surprises during implementation are usually pre-implementation risks that weren't named._

- set_notes replaces (lost-update if two agents write concurrently) — tool description mandates get-then-merge; acceptable at this scale.
- Bridge has no caller identity — `agent` authorship on create_pin is self-declared.
- TreeItem checkbox API requires VSCode >= 1.80 (engines pin 1.96, fine).

## Research / citations

_Sources consulted (docs, blog posts, code references) that informed this plan. Satisfies `.agent0/context/rules/research-before-proposing.md`._

- VSCode TreeItemCheckboxState/onDidChangeCheckboxState API; HiveTerm pins reference; F4 discussion 2026-06-10.
