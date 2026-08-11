# 228 — tachyon-harness-skills-rules-hooks

_Created 2026-06-16._

**Status:** in-progress
3 MAJOR + 2 MINOR); 578 unit tests + typecheck + build green. NOT yet shipped. Completes the isolated
harness (spec 226) beyond MCP — the rest of what dogfood pin `p-ea86ad` asked for. All three verified
live; `inherit: global` deferred.

## Dogfood fix (2026-06-17, → 0.23.1) — a fresh config home re-runs the first-run wizards
Spawning the researcher in the extension showed claude's **login/onboarding wizard** + then the
**"trust this folder?"** prompt, despite a valid token. Root cause: a redirected `CLAUDE_CONFIG_DIR`
is a FRESH config home — the token (symlinked `.credentials.json`) authenticates in `-p`, but the
INTERACTIVE TUI gates the wizard on `<home>/.claude.json` markers a fresh home lacks
(`hasCompletedOnboarding`) and gates folder access on `projects[<cwd>].hasTrustDialogAccepted`. FIX:
`materialize` seeds those into `<home>/.claude.json` — the onboarding/account markers copied from the
real `.claude.json` (allowlist; secret token stays in `.credentials.json`) + `hasCompletedOnboarding:
true` + `projects[<cwd>].hasTrustDialogAccepted: true` for the agent's cwd (threaded through
`applyHarness`). Verified live in a tmux PTY: the login wizard no longer appears.

## codex implementation review — 2026-06-17 (228+229) → CHANGES → all folded
- **B1 (BLOCKER)** — Studio could write a YAML-valid-but-loadConfig-invalid harness and leave the whole
  `tachyon.yml` broken (the form validates shallowly; the write ignored reload failure). FIX:
  `studioSubmit` runs `parseConfig` on the candidate text BEFORE persisting and returns the real config
  errors to the form; nothing is written on failure.
- **M2 (MAJOR)** — a rules/hooks/skills-only harness didn't scope MCP (no `--strict-mcp-config` → it
  read the project `.mcp.json`). FIX: a harness agent ALWAYS materializes an mcp.json + passes
  `--strict-mcp-config`; `inherit` alone decides the base (none = empty, workspace = snapshot).
- **M3 (MAJOR)** — rematerialize didn't clear rules/skills/hooks the user removed (a deleted hook kept
  firing in the reused home). FIX: CLAUDE.md / skills/ / settings.json-hooks are Tachyon-owned — written
  when declared, removed when not, every materialize.
- **M4 (MAJOR)** — `rules`/`skills` allowed absolute paths + `..` traversal + symlink escape (a committed
  config could read `/etc/passwd` into the agent's home). FIX: lexical reject in `loadConfig` (absolute/
  `..`) + a realpath containment check in `materialize`; skills must be a dir with `SKILL.md`, unique basename.
- **M5 (MINOR)** — "at least one" keyed off raw key presence, not accepted capability. FIX: gate on the
  accepted `harness.{mcp,rules,skills,hooks}`.
- **M6 (MINOR)** — schema only allowed an array for `rules`/`skills`; the parser accepts a string too.
  FIX: schema `oneOf` string | array.

**UI impact:** none (config/materialization only; the ⚙ badge is unchanged).

## Intent

Let an isolated-harness agent carry its own **skills**, **rules**, and **hooks** — not just MCP — all
private to that agent. A researcher with its own research skills + a CLAUDE.md of research rules + a
PreToolUse hook, none of which the rest of the fleet sees.

## Locked decision (maintainer, 2026-06-16)
**Bespoke inline** — declare `skills`/`rules`/`hooks` inline in `tachyon.yml` (consistent with `mcp:`);
Tachyon materializes each into the agent's config home. (Rejected: forcing the user to author a
claude `--plugin-dir` bundle.)

## Capability research — VERIFIED LIVE (2026-06-16, claude 2.1.179)
Everything loads **automatically from the redirected `CLAUDE_CONFIG_DIR`** — so this slice needs **no
new spawn args** (the 226 mechanism was kept for exactly this). Verified by running `claude -p` with a
redirected home:
- **hooks** — a `SessionStart` hook in `<home>/settings.json` (`hooks` key) **fired**.
- **rules** — a `<home>/CLAUDE.md` instruction was **loaded** (reply obeyed it).
- **skills** — a `<home>/skills/<name>/SKILL.md` resolved via `/<name>` (the `commands/*.md` form did
  NOT load headless; the `skills/`+SKILL.md form did — and it's the agentskills.io form the repo uses).

## Design
Extend `harness:` with three optional keys; `HarnessManager.materialize` writes more into the home
(no AgentManager/spawn-arg change):
- **`hooks`** — a claude settings.json `hooks` object → merged into `<home>/settings.json`.
- **`rules`** — a list of file paths → read + concatenated into `<home>/CLAUDE.md` (each under a
  `# === <relpath> ===` header). Resolved relative to the workspace root.
- **`skills`** — a list of skill DIR paths (each holding a `SKILL.md`) → copied into
  `<home>/skills/<basename>/`.
- Materialization is rebuilt every spawn/restart/resume (H6); copy, never symlink (no write-back).

## Non-goals (this slice — follow pass)
- **`inherit: global`** — seeding the home from `~/.claude` (personal skills/hooks/settings) has its
  own semantics; stays rejected for now (inherit remains `none|workspace`). Deferred.
- Per-agent `--plugin-dir` / `.zip` plugins.
- Deep validation of hook/skill internals — Tachyon validates the declared SHAPE (object / path
  lists) and writes them; claude validates the contents at load (a bad hook/skill is the user's).
- Secrets in rules/skills files — those are user-authored content (like any CLAUDE.md); the `${VAR}`
  no-literal rule stays scoped to `mcp.*.env` (226 H7). Hook commands may use `$VAR` at runtime
  (shell expansion in the agent's env) — not an on-disk-secret concern.
