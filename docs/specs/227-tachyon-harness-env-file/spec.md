# 227 — tachyon-harness-env-file

_Created 2026-06-16._

**Status:** in-progress
**Status detail:** in-progress — IMPLEMENTED 2026-06-16 — 559 unit tests + typecheck + build green. NOT yet shipped
(awaiting `vsce publish patch` → 0.22.1). Follow-pass to spec 226 (isolated harness). Surfaced in
dogfood: the v1 secret source (the ambient `process.env`) is clunky and fragile.

**UI impact:** none (config/resolution only; no UI surface change — the ⚙ badge is unchanged).

## Intent

Make an isolated-harness agent's `${VAR}` secrets come from a **project `.env` file** (gitignored),
not only the ambient shell env. Today (226) Tachyon resolves a referenced `${VAR}` from the extension
host's `process.env` and fails closed if it's missing — which means the human must `export VAR=…` in
the shell **before** launching the editor. That is:
- **not persistent** — re-export every session;
- **fragile** — a GUI-launched editor (dock/launcher) doesn't inherit the shell rc, so the var is
  simply absent and the agent won't start;
- **not per-project** — a profile export is global to everything.

A `.env` file is the conventional, persistent, per-project, never-committed home for exactly this.

## Decision

- **Resolution source = `<workspaceRoot>/.env`, with `process.env` precedence (dotenv semantics).**
  For each referenced `${VAR}`: use `process.env[VAR]` if set, else the value from `<ws>/.env`. An
  explicit ambient export still wins (least-surprising for anyone who knows dotenv); `.env` fills the
  gap so the common case needs no export. Missing in BOTH → the same fail-closed error as 226, now
  naming `.env` as the place to set it.
- **Only the referenced vars are read** — Tachyon resolves the `${VAR}`s the harness config names
  (`collectEnvRefs`), never dumps the whole `.env` into the agent. Minimal exposure.
- **No new dependency** — a small hand-rolled `.env` parser (matches Tachyon's dependency-light style:
  it hand-rolls YAML validation too). Handles `KEY=value`, quoted values, `export KEY=…`, `#` comments,
  blank lines.
- **`.env` stays the user's/project's** — Tachyon does NOT manage gitignoring it (it's not Tachyon
  state); the README reminds the user to gitignore it. The materialized `mcp.json` still only ever
  holds the literal `${VAR}` (226 H7) — the resolved value goes into the spawned process env only.
- **v1 source = the project `.env` only.** A configurable path / VS Code SecretStorage (prompt-once,
  encrypted) is a deliberate follow pass.

## Design

- `parseEnvFile(text): Record<string,string>` — pure (unit-tested with no fs).
- `HarnessManager` reads `<workspaceRoot>/.env` at materialize time (cheap; absent → `{}`), and the
  secret resolution becomes `procEnv[name] ?? envFile[name]`. Everything else (symlink auth, mcp.json
  write, fail-closed-on-missing) is unchanged — this only widens the resolution source.

## Non-goals (v1)
- A configurable env-file path (`settings`/per-agent) — `<ws>/.env` only for now.
- VS Code SecretStorage / OS keychain (follow pass — the nicer prompt-once UX).
- `.env` variable interpolation / `${OTHER}` expansion inside `.env` — plain `KEY=value` only.
