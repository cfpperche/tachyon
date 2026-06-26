# 268 — notes

## The key discovery that shapes v2

`agent-browser` ships a **native action-safety surface**, so v2 does not hand-roll a wrapper gate:
- `--confirm-actions <categories>` / `AGENT_BROWSER_CONFIRM_ACTIONS` — hold a write in `confirmation_required`.
- `confirm <id>` / `deny <id>` — resolve a pending action; **auto-deny after 60 s**, and **auto-deny when stdin
  is not a TTY** (verified from `confirm --help`). A Tachyon agent is non-TTY → a gated write is fail-closed.
- `--allowed-domains` / `AGENT_BROWSER_ALLOWED_DOMAINS` — restrict navigation (makes "prefer staging" enforceable).
- `--action-policy <json>` — static allow/deny/confirm file.
- Example from upstream: `--confirm-actions eval,download`; categories referenced include navigation, interaction,
  eval, download (exact strings TBD from the binary — OQ2).

This turns v1's prose "ask before writing" into a **mechanical** gate: a headless write is auto-denied unless a
human confirms by id.

## Why env-mandated, and the honest limit (OQ1)

There is no Tachyon mechanism today for a plugin to force default env/args onto a provisioned tool — the launcher
execs the binary with the agent's argv. So v2's gate is "on" only when the skill-mandated session env
(`AGENT_BROWSER_CONFIRM_ACTIONS` + `_CONFIRM_INTERACTIVE`) is exported. That is a real fail-closed improvement
(writes are actually held + auto-denied), but an agent could call the launcher without the env. Bypass-proof
enforcement wants a launcher that injects a tool's declared default env/args — a spec-265-family ENGINE change,
filed as OQ1, not built here. Flag it; don't ship a soft gate as if it were hard.

## Carry-overs from v1 (spec 267)

- Same provisioned binary + launcher (no engine change in v2 itself); same `.tachyon/` gitignored credential-class
  home (now also the action log); same dogfood → codex-dueto → tag rhythm; spec-266 update detection already
  governs the plugin (a `v0.8.0` carrying 2.0.0 will surface as an update from the installed 1.0.0).

## Sources

- `agent-browser` CLI `--help` / `confirm --help` (run via the launcher): the `--confirm-actions`,
  `--action-policy`, `--allowed-domains`, `--confirm-interactive` flags + the confirm/deny/60s/non-TTY semantics.
- DeepWiki vercel-labs/agent-browser (Security / Advanced features) + README.

## Decisions & deviations (build-time)

_(fill during build + dogfood + codex dueto)_
