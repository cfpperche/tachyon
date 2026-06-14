# 215 — tachyon-terminals-block

_Created 2026-06-14._

**Status:** draft

**UI impact:** flow
<!-- The Agent Studio's Terminal tab writes to a new `terminals:` block; hand-written
`terminals:` round-trips. Verified by creating/editing a terminal in the Studio and
reading the resulting yml, plus a fresh `Tachyon: Init`. -->

## Intent

**Make `tachyon.yml` read the way people think: terminals go under `terminals:`, not `agents:`.**

Today every entry — AI CLIs *and* servers/shells/builds — lives under one `agents:` map,
distinguished by `kind`. The engine is right to unify them (one lifecycle: tmux session, tab,
restart, watch, worktree, layout, rename, reattach — see the README "kind taxonomy"). But the
**config key is a UX wart**: you read `agents:` and expect AIs, then find `npm run dev` there.
This confused an experienced user hard enough to file it twice (pin `p-e191d4`). The UI already
separates them (sidebar **Agents** / **Terminals** groups, Studio tabs); only the yml doesn't.

This spec adds a top-level **`terminals:`** block so the config matches that mental model — a
pure surface change. The engine keeps its single kind-tagged agent map; `terminals:` entries are
merged in as `kind: terminal`. **Fully backward compatible**: `agents:` with `kind: terminal`
keeps working; nothing auto-migrates.

## Confirmed design (decisions locked 2026-06-14, with the maintainer)

1. **`terminals:` is a top-level mapping**, each entry the same shape as an agent entry but with
   **kind forced to `terminal`**. An explicit `kind:` inside `terminals:` is **rejected** (it's
   implied — a contradiction otherwise); `instructions` is **rejected** (no AI to deliver it).
   All other fields apply: `cmd` (required), `cwd`, `env`, `autostart`, `watch`, `restart`,
   `worktree`, `branch`, `worktreeSetup`, `verify`, `attention` (default off, as today).
2. **The parser merges `terminals:` into the single `config.agents` record** with
   `kind: "terminal"`. The whole engine downstream (AgentManager, Sidebar, MCP, worktree, …) is
   **unchanged** — it already keys off `agents` + `kind`.
3. **Name collision between `agents:` and `terminals:` is a config error** (one namespace).
4. **Backward compatible**: a terminal declared the old way (`agents:` + `kind: terminal`) stays
   valid and coexists. **No auto-migration** — hand-written configs are never rewritten.
5. **Agent Studio**: the **Terminal tab writes NEW terminals to `terminals:`**; editing a
   terminal rewrites it **in whichever block it currently lives** (new `terminals:` or legacy
   `agents:`), never moving it. The Agent tab is unchanged (`agents:`). Rename + layout-ref
   updates are preserved for both blocks.
6. **`Tachyon: Init`** emits detected stack terminals under a `terminals:` block (not `agents:`).
7. **Docs**: README "kind taxonomy" section + the Init starter comment reflect the new block.

## Behavior (proposed)

- Hand-write `terminals: { dev: {cmd: npm run dev, watch: src/**} }` → `dev` shows under the
  sidebar **Terminals** group, attention off, exactly like `agents: { dev: {..., kind: terminal} }`.
- Studio "Terminal" tab → Save → the entry lands in `terminals:` (created if absent).
- Editing a legacy `agents:`-with-`kind:terminal` entry in the Studio rewrites it in `agents:`
  (no surprise move); editing a `terminals:` entry rewrites it there.
- A name in both blocks, or `kind:`/`instructions:` inside `terminals:`, is a clear parse error.

## Non-goals

- Renaming the `agents:` key or the "agent" brand (it's the product's name; the wart is only
  terminals living under it).
- Auto-migrating existing `agents:`+`kind:terminal` entries into `terminals:` (non-destructive).
- Any engine/runtime change — this is config-surface + Studio-write + docs only.

## Open questions

- **OQ1** — Studio: when editing a legacy `agents:` terminal, offer to *move* it to `terminals:`?
  → **No for v1** (decision 5: edit in place; a move is surprising and risks layout-ref churn).
- **OQ2** — should `kind: terminal` under `agents:` emit a soft "you can use terminals: now"
  advisory? → **No** (noisy; the README explains it; both are first-class).

## Acceptance

- `terminals:` parses: entries merge into `config.agents` as `kind: terminal`, all agent fields
  supported; `kind:`/`instructions:` inside `terminals:` rejected; agents↔terminals name
  collision rejected. Backward compat: `agents:`+`kind:terminal` still parses identically.
- The Studio Terminal tab creates entries under `terminals:`; editing rewrites in the entry's
  current block; renames + layout refs preserved.
- `Tachyon: Init` produces a `terminals:` block for stack terminals; the generated yml is valid.
- README + starter comment document the block.
- Pure parse/merge/collision + the section-resolution logic are unit-tested; the Studio write
  path is unit-tested through YamlConfigEditor; round-trip (`parseConfig(buildStarterYaml)`) green.
