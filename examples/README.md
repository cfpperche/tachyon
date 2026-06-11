# Tachyon examples

Real, runnable demo workspaces — the same ones used for the screenshots.

## `orbit-api/` — a single-project fleet

A tiny Express API (real routes + vitest tests). Its [`tachyon.yml`](orbit-api/tachyon.yml)
declares a fleet: **claude** (orchestrator), **codex** (reviewer), a **dev** server with
watch-restart, a **shell**, real `test`/`lint` commands and a `ship` runbook.

```bash
cd examples/orbit-api
npm install
code .          # Tachyon activates and boots the autostart agents
```

## `orbit-worker/` — the companion service (multi-root)

A second project ([`tachyon.yml`](orbit-worker/tachyon.yml)) so you can see **workspace
isolation**: open [`orbit.code-workspace`](orbit.code-workspace) and each folder gets its
own Bridge (different port), its own agents, commands and pins — status bar shows
`⚡ Tachyon ×2`.

```bash
code examples/orbit.code-workspace
```

> These power the F5 launch configs (`Run Tachyon (demo)` / `Run Tachyon (multi-root demo)`).
