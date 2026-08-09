# Moved: Dev Host dogfood lane

This path is **kept on purpose** as a historical pointer — not as a second runbook.

## What happened

The isolated Extension Development Host dogfood lane started as **EDH palliative**
(`scripts/edh-palliative/`, `node scripts/dogfood/run.mjs edh-palliative` / `dogfood:edh`): a temporary
name for “dogfood without touching the live fleet while other work ran.”

It was renamed to **Dev Host** (`t-2d1810`, 2026-07-14): same isolation rules, clearer product
vocabulary, first-class F5 worktree pointer.

## Where to go

→ **[`docs/runbooks/dev-host.md`](./dev-host.md)** — full contract, lease, headless, F5 pointer, evolution table.

**CLI:** `scripts/dev-host/cli.sh`
**Task:** `t-2d1810`
