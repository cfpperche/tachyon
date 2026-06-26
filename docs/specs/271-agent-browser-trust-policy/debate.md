# 271 — debate

_Adversarial review, 2026-06-26. Participants: codex (repo-grounded red-team) + a Claude security red-team
(governance-bypass focus). Both ran in **adversarial** mode (the prior design review had largely agreed — a
confirmation-bias smell), and both converged independently on the same structural verdict._

## Verdict: **REDESIGN**

The committed design derives a **write authorization from a non-atomic observation of browser state** (per-command
`agent-browser get url` preflight) plus an **incomplete denylist** (env scrub + denyArgs). Both halves are
defeatable. The enforcement boundary is wrong, and the surface it must deny is far larger than the spec accounts
for.

## Strongest objection (both reviewers, independently)

**Per-command "current origin" preflight is not an authorization boundary.** The launcher preflights the top-level
URL, computes `bypass`, then the action's *effect* can land on a different origin — popup, iframe, redirected form,
a pending `confirm <id>`, or a JS path triggered by the click. The policy authorized "the top-level URL observed
before the action", not "the origin receiving the mutation". TOCTOU is intrinsic, not an edge case (spec OQ1
acknowledged the race but kept the model).

## Empirical confirmation (binary inspection, 2026-06-26)

`agent-browser` v0.31.0 (`strings` + `--help`) reads a **large env surface** and exposes **dangerous flags +
stateful commands** the committed design does not cover:

- **Env the binary honors (denylist can never be complete):** `AGENT_BROWSER_ALLOWED_DOMAINS`,
  `AGENT_BROWSER_INIT_SCRIPTS`, `AGENT_BROWSER_EXTENSIONS`, `AGENT_BROWSER_PLUGINS`, `AGENT_BROWSER_CDP`,
  `AGENT_BROWSER_AUTO_CONNECT`, `AGENT_BROWSER_PROFILE`, `AGENT_BROWSER_STATE`, `AGENT_BROWSER_ARGS`,
  `AGENT_BROWSER_PROXY`, `AGENT_BROWSER_ALLOW_FILE_ACCESS`, `AGENT_BROWSER_CONFIG`, `AGENT_BROWSER_ACTION_POLICY`,
  `AGENT_BROWSER_DOWNLOAD_PATH`, `AGENT_BROWSER_SOCKET_DIR`/`XDG_RUNTIME_DIR`, plus the OS `HOME`/`XDG_CONFIG_HOME`/
  `PWD` config-discovery inputs and loader env (`LD_PRELOAD`/`DYLD_*`/`NODE_OPTIONS` — the repo already treats
  these as dangerous when a plugin *sets* them, `manifest.ts:349`, but 271 does not scrub them on the *inherited*
  env).
- **Flags NOT in the plugin's denyArgs (`tachyon-plugin.json:16` blocks only confirm/policy/config/`mcp`/`batch`):**
  `--init-script <path>` (inject mutating JS before first navigation → a write through a "read" `open`),
  `--extension <path>`, `--auto-connect` (attach to a running Chrome, reuse its auth), `connect <port|url>` (CDP),
  `--profile`, `--proxy`.
- **Stateful commands outside the forced confirm list (`tachyon-plugin.json:14`):** `cookies set`,
  `storage <local|session>`, `route` (network intercept), `clipboard write/copy`, `pushstate`, `trace`, `record`,
  `auth save|login|delete`, `connect`, **`confirm <id>` (executes a pending held action)**, `state` save/load.

## The three confirmed bypass classes

1. **Env/path redirection — denylist far too narrow.** A planted `AGENT_BROWSER_ACTION_POLICY` /
   `AGENT_BROWSER_CONFIG`, a redirected `HOME`/`XDG_CONFIG_HOME`/`PWD` to a planted config, or
   `AGENT_BROWSER_INIT_SCRIPTS`/`LD_PRELOAD` all pass through the launcher's `env = { ...process.env, ...policy.env }`
   (`toolLauncher.ts:255`). → **Fix: a sterile env ALLOWLIST**, not a denylist. The launcher must pass only the env
   the tool needs, with policy-relevant vars launcher-set.
2. **Arg injection — denyArgs far too narrow.** `--init-script /tmp/mutate.js` (or its env) turns a `readonly`/`open`
   "read" into a mutation; `--auto-connect`/`connect`/`--cdp` reuse a logged-in Chrome. → **Fix: an arg ALLOWLIST**
   (or a denylist that covers the full dangerous-flag set), not the 5-entry denyArgs.
3. **Read-framed-write — incomplete command taxonomy.** The confirm list (`click..eval,download`) covers none of the
   stateful commands above; a security spec cannot punt this to "a canonical normalized list" (spec OQ5). → **Fix:
   deny-by-default category map** — every non-explicitly-read command is a write for policy purposes.

## Recommended redesign (codex, empirically feasible)

**Session-scoped trust, not per-command origin guessing.** The human creates a trusted (or readonly) browser
session/profile bound to a site; the launcher starts it under a **strict allowlist**: sterile env/cwd/HOME, forced
`AGENT_BROWSER_ALLOWED_DOMAINS=<site>` (the browser's own navigation allowlist — a real boundary, confirmed present
in the binary), **no** `--cdp`/`--auto-connect`/`--init-script`/`--extension`, and a **command allowlist**.
`bypass` applies only inside that domain-pinned session; `readonly` is a mode that denies all mutator command
families. This eliminates the `get url` TOCTOU entirely (the browser cannot navigate off the pinned domain) and
shifts enforcement from "Tachyon observes, then decides" to "the session is constrained by construction".

## The single change each reviewer most insists on

- **codex:** replace per-command origin preflight with session-scoped domain-pinned sessions under a strict
  env/arg/cwd allowlist.
- **Claude red-team:** the env scrub must be an allowlist (sterile env) — the highest-severity, deterministic,
  no-race bypass is policy/config/init-script injection through inherited env.

## What changes for the spec

- Enforcement model: **session-scoped + domain-pinned** (force `AGENT_BROWSER_ALLOWED_DOMAINS`), not per-command
  origin preflight.
- Env: **allowlist** (sterile), not denylist. cwd/HOME explicitly set on `spawnSync` (`toolLauncher.ts:186` sets
  no cwd today).
- Args: **allowlist** (or a complete dangerous-flag denylist) — add `--init-script`, `--extension`,
  `--auto-connect`, `connect`, `--cdp`, `--profile`, `--proxy`, `--allow-file-access` at minimum.
- Categories: **deny-by-default** over the full command surface; `confirm <id>` itself is policy-gated.
- Caveat to re-examine: even session-scoping does not stop a same-user raw-exec (accepted residual, spec 269 OQ1);
  the claim stays "enforced via the launcher".

**Status:** spec.md/plan.md/tasks.md to be rewritten to the session-scoped model — pending owner ratification of
the pivot (it materially changes the build).
