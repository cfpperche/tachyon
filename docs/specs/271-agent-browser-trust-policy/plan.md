# 271 — plan

_v1 (owner-reduced 2026-06-26): expose agent-browser's native config via the spec-270 editor. The Tachyon
governance layer is v2 (deferred) — its plan is preserved in git history + `debate.md` + notes.md._

## v1 touch-points

- **agent-browser plugin** (`/home/goat/tachyon-plugins/agent-browser`) — declare, per spec 270:
  - `config` pointing at agent-browser's **native** config (`agent-browser.json` shape), `schema` = a **pinned
    copy** of agent-browser's published JSON Schema (`agent-browser.dev/schema.json`) for the tool version,
    `default` = a sane starter (keeps today's forced `confirmActions` as the default so behaviour is unchanged
    until the human relaxes it).
  - `docsUrl` → the plugins repo.
- `src/plugins/toolLauncher.ts` — feed the **human's config from the Tachyon-owned path** to the binary via the
  native `--config` (or env) that the **launcher** sets; keep the spec-269 `denyArgs` so the agent can't pass its
  own `--config`/`--confirm-actions`/`--action-policy`. Minimal change: source the forced settings from the human
  file instead of (only) the manifest hardcode.
- **270 config editor** — associate the pinned agent-browser schema with the native config file for live
  validation; surface the honest limit labels (esp. `allowedDomains` = open-verb-only, task 0).
- **Skill doc** (`skills/agent-browser/SKILL.md`) — note the config is human-owned + the native `allowedDomains`
  limitation; no Tachyon per-site trust in v1.

## Key decisions

- **Reuse agent-browser's published schema**, don't author a Tachyon one (the consumer is the tool's own native
  config — its schema is authoritative). Pin it per tool version (OQ1) for offline/reproducible validation.
- **Human config is the source of the forced value; the agent override lever stays closed** (denyArgs unchanged).
  This is the governance invariant with one change: the forced value is now human-configurable, not hardcoded.
- **No overselling:** the UI/docs label native-knob limits; native `allowedDomains` is not a security boundary.
- **env-scrub (OQ4):** decide whether to close the `AGENT_BROWSER_ACTION_POLICY`/`_CONFIG` env passthrough now
  (cheap, narrows the 268 residual) or defer to v2. Lean: close it in v1 — it's a real latent gap and small.

## Build order

1. Pin agent-browser's published JSON Schema to the tool version; vendor it with the plugin.
2. agent-browser plugin declares `config` (native shape + pinned schema + sane default) + `docsUrl` (spec 270).
3. Launcher sources the human config from the Tachyon-owned path; keep denyArgs; (OQ4) optionally close the env
   passthrough. Unit + e2e (human value applied; agent `--config` refused; agent env policy ignored if OQ4 done).
4. 270 editor schema association + honest limit labels.
5. Skill doc; codex dueto on the launcher change; fold.

## v2 (deferred)

The session-scoped, domain-pinned, allowlist-based governance design (per-site bypass/readonly, sterile env/arg/
command allowlists, env scrub, deny-by-default) lives in `debate.md` + notes.md. Build only on demand; gate on a
real need the native knobs can't meet, and likely an upstream agent-browser navigation-filter fix (task 0 showed
the current filter doesn't contain the browser).

## Verify (mechanical)

`env -u TMUX npx vitest run` over the launcher suite + the plugin-config wiring once it lands — exact list pinned in
tasks.md.
