# 271 — agent-browser-config (v1) · trust-policy (v2, deferred)

_Created 2026-06-26. Scope reduced 2026-06-26 (owner): v1 exposes only agent-browser's **native** configuration via
the spec-270 editor. The Tachyon governance layer (per-site bypass/readonly, launcher allowlists, real containment)
is **deferred to v2** — see `debate.md` + notes.md for its full design, and § v2 below for why it's deferred._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

## Intent (v1)

Make the `agent-browser` plugin **configurable by the human** through the spec-270 config editor — exposing
**agent-browser's own native configuration surface**, nothing Tachyon-invented. The human owns the settings; the
agent cannot override them (the spec-268/269 launcher spine stays). This directly serves the owner's want — *"não
ficar confirmando a todo momento"* — by letting the human tune agent-browser's native confirmation/navigation knobs
(globally), without Tachyon building a per-site trust engine yet.

agent-browser ships a native config (`--config` → `~/.agent-browser/config.json` / `./agent-browser.json`, JSON
Schema at `agent-browser.dev/schema.json`) with knobs like `confirmActions`, `allowedDomains`, `downloadPath`,
`ignoreHttpsErrors`, `headed`, timeouts. v1 surfaces this file as the agent-browser plugin's config (spec 270): the
card gets **Config** (opens the native config with its published schema) + **Docs** (→ the plugins repo), and
post-install navigates to it.

**Governance invariant (unchanged):** the human configures; Tachyon respects; the agent cannot loosen the gate. The
launcher reads the **human's config from a Tachyon-owned path** and continues to **deny the agent's**
`--config`/`--confirm-actions`/`--action-policy` args + `mcp`/`batch` (spec 269 `denyArgs`). So v1 makes the
launcher-forced value **human-configurable** instead of hardcoded in the manifest — without handing the agent a new
lever.

**Honest scope (v1):** v1 exposes agent-browser's **native semantics, with their native limits** — it does NOT add
containment agent-browser doesn't already provide. In particular (measured, task 0): `allowedDomains` only gates the
CLI `open` verb; in-page JS navigation, iframes, popups, and sub-resource/`fetch` requests are **not** contained. v1
must surface these limits in the config UI/docs and must **not** describe native `allowedDomains` as a security
boundary. Per-site `bypass`/`readonly` with real enforcement is v2.

**Done (v1)** = the agent-browser plugin declares its config (= the native agent-browser config, schema = the
published/pinned agent-browser schema) + `docsUrl`; the human edits it via the 270 Config editor; the launcher
applies the human's config from a Tachyon-owned path while still denying the agent's override args; the native-knob
limits are honestly labelled.

## Acceptance criteria (v1)

- [ ] **Scenario: the agent-browser plugin is human-configurable via the 270 editor**
  - **Given** the agent-browser plugin installed
  - **When** the human clicks **Config**
  - **Then** the native agent-browser config opens in an editor with the published/pinned agent-browser JSON Schema
    associated (live validation); **Docs** opens the plugins repo; post-install navigated here.

- [ ] **Scenario: the human's native config is what the launcher applies**
  - **Given** the human set e.g. `confirmActions` / `allowedDomains` / `downloadPath` in the config
  - **When** the agent runs agent-browser through the launcher
  - **Then** the launcher applies the human's config from the **Tachyon-owned path** (via the native `--config`/env
    the launcher controls) — the human's values take effect.

- [ ] **Scenario: the agent still cannot override the human's config**
  - **Given** the human's config is in force
  - **When** the agent passes `--config` / `--confirm-actions` / `--action-policy` (or `mcp`/`batch`)
  - **Then** the launcher refuses (spec 269 `denyArgs`, unchanged) — the human-owned config is the only source.

- [ ] **Scenario: native limits are labelled, not oversold**
  - **Given** the config exposes `allowedDomains`
  - **Then** the UI/docs state plainly that it restricts only the CLI `open` verb (in-page nav/iframes/popups/
    sub-resources are not contained — task 0), so no one mistakes it for a security sandbox. Real per-site
    enforcement is v2.

## Non-goals (v1)

- A Tachyon-built per-site trust gate (`bypass`/`readonly` per domain) — **v2**.
- Launcher env/arg/command **allowlists**, env scrub, deny-by-default command map — **v2**.
- Any claim that native `allowedDomains` contains the browser — it does not (task 0).
- A Tachyon-authored config schema — v1 reuses agent-browser's **published** schema (pinned to the tool version).

## v2 (deferred) — Tachyon per-site trust governance

The full design is preserved in `debate.md` + notes.md (the session-scoped, domain-pinned model and the adversarial
findings). It is deferred, not abandoned. **Why deferred:** (1) the owner chose to ship v1 = native config and add
governance only on demand; (2) task 0 proved the native domain filter is not a containment boundary, so a safe
per-site `bypass` needs real Tachyon-side enforcement (sterile env **allowlist** + arg allowlist + deny-by-default
command map) and/or an upstream agent-browser navigation-filter fix — a substantial build to justify only when the
native knobs prove insufficient. **What v2 would add:** per-(session|site) `bypass`/`readonly`/`confirm` enforced by
the launcher, with the allowlist hardening the debate established and the env-scrub latent gap closed
(`toolLauncher.ts:255` passes `{...process.env, ...}` — a real gap worth closing regardless).

## Open questions (v1)

- **OQ1 — schema sourcing.** Pin a copy of agent-browser's published JSON Schema to the tool version (offline,
  reproducible) vs reference the live `agent-browser.dev/schema.json`. Lean: pin per tool version.
- **OQ2 — which native knobs to surface.** Expose the full native config, or a curated subset (hide
  daemon/socket/provider internals)? Lean: surface the safe/useful subset; document the rest as advanced.
- **OQ3 — config path + launcher wiring.** The Tachyon-owned config path and how the launcher feeds it to the
  binary (native `--config` that the launcher — not the agent — passes, vs a launcher-set env). Must not re-open an
  agent override lever.
- **OQ4 — env-scrub latent gap (carry-over).** Even in v1, the agent can set `AGENT_BROWSER_ACTION_POLICY`/`_CONFIG`
  env to point at its own file (the launcher passes `process.env` through). Decide whether v1 closes this now (cheap
  hardening, narrows the 268 residual) or leaves it documented for v2.
