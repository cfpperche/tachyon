# 271 — notes

## Why this exists (2026-06-26)

Spec 268 made the agent-browser write-gate **mechanical but total** — every write on every site is held for
confirmation. The owner's point: confirming every action is unproductive friction. The human should be able to
declare, per site, that a site is trusted (`bypass`, full write trust) or locked (`readonly`), and Tachyon must
respect that. This is the per-site evolution of the static spec-268/269 launch policy, and the first real consumer
of the spec-270 configurable-plugin UX.

## Governance invariant (owner, stated twice)

The human OWNS the actions. The agent never sets or loosens policy; if the human permits it, it is permitted;
Tachyon respects the human's decision. The owner's own framing of why the spec-269 `denyArgs` block each surface:
- `--confirm-actions` — the gate switch itself; Tachyon owns it, not the agent.
- `--action-policy` / `--config` — the agent could point at its own loosened rules.
- `mcp` / `batch` — side-channels where individual commands escape the per-command check.

271 keeps that spine and adds the missing **env** closure (below). `bypass` must be a **launcher-computed**
decision from the human's file + a confident origin — never anything the agent can supply.

## The enforcement fork: Tachyon-side, not delegate-to-binary (decided)

The upstream `vercel-labs/agent-browser` v0.31.0 binary has `--action-policy`/`AGENT_BROWSER_ACTION_POLICY` +
`--config`, but: (a) the action-policy file format is undocumented, and (b) a strings inspection of the binary
found **no per-origin/readonly policy schema** (only `el.readOnly` + zod's `ZodReadonly`) → it is almost certainly
a **global** (category-level) gate, not per-site. Since agent-browser is invoked **per-command** against a
persistent session and the launcher already wraps every call (force mode), Tachyon computes the per-site decision
**in the launcher** — keeping trust enforcement inside the product (governance-aligned), needing no upstream
change, and supporting per-site naturally. The binary's `--action-policy` is kept only as a research / possible
upstream-contribution path for a hardened `bypass` later.

## The central hardening: env scrub (verified latent gap, 2026-06-26)

`toolLauncher.ts:258` builds the child env as `env = { ...process.env, ...policy.env }`. It **forces**
`AGENT_BROWSER_CONFIRM_ACTIONS` (good) but does **not** remove `AGENT_BROWSER_ACTION_POLICY` /
`AGENT_BROWSER_CONFIG`, nor neutralize config-file discovery (`./agent-browser.json`,
`~/.agent-browser/config.json`). With agent-browser's precedence (CLI > env > config file), an agent that exports
`AGENT_BROWSER_ACTION_POLICY=/tmp/loose.json` passes its loosened policy straight through — the spec-269 `denyArgs`
only block the matching **args**, not the **env**. Spec 268 documents env/config override as an accepted residual;
per-site `bypass` makes it **central**, so 271 must scrub all agent-browser policy/config env + config-file
discovery so the binary sees only the launcher-computed posture. (Confirmed live by reading the launcher; this is a
real latent gap, worth closing regardless of the per-site feature.)

## Codex review (2026-06-26, independent second model — read /home/goat/tachyon)

Strong convergence; folded:
- **Fork 2 (Tachyon-side launcher policy engine) is right**; binary action-policy = research/upstream only, not the
  local enforcement dependency (cited `lockfile.ts:115`, `toolLauncher.ts:231`).
- **Current-URL = conservative preflight, not strong bypass proof.** Extra `get url` latency is fine; the TOCTOU
  race means: origin not confidently resolved ⇒ fall back to `confirm`/`deny`, **never** `bypass`. A hardened
  `bypass` would want origin in the binary's confirm/action payload or an upstream atomic resolve+exec.
- **Per-event overrides IN v1 but boring** — normalized known event names, no selectors/regex/DOM; unknown names
  fail validation; precedence explicit (event > site > unlisted=confirm).
- **`readonly` hard-denies before invoking the binary**, with a stable agent-readable line
  (`TACHYON_AGENT_BROWSER_POLICY_DENIED: …`) so no pending confirmation is created and the skill has a clear stop.
- **Trust policy at a Tachyon-owned fixed path**, read by the launcher after validation; the plugin declares
  schema/docs/default shape but must **not** choose the policy path or inject a runtime-readable policy file
  (manifest = untrusted marketplace boundary, `manifest.ts:7`).
- **Biggest risk:** turning human-owned trust config into agent-reachable policy relaxation — making `bypass`
  launcher-owned while preventing the agent from supplying alternate config/env/args that produce the same
  relaxation outside the human-authored policy. (This is why env scrub + fail-closed origin + Tachyon-owned path
  are non-negotiable.)
- **Co-develop 270 + 271 as a vertical slice.**

## Honest scope (mirrors spec 269 OQ1)

The guarantee is "enforced **via the launcher**", not bypass-proof. The agent can't repoint/loosen the policy via
args or env (denyArgs + env scrub), and the launcher reads only the Tachyon-owned path. A same-user shell agent
that edits the human's policy file directly, or runs the binary's bytes raw, is the **same accepted residual** as
spec 268/269 — true bypass-proofing needs agent sandboxing, a separate containment layer. Documented, not
advertised away.

## Sources

- codex review transcript (cwd /home/goat/tachyon): positions + tightenings above.
- `src/plugins/toolLauncher.ts:258` (env build — the scrub gap), `:231` (resolve seam); spec-268
  `docs/specs/268-agent-browser-form-driving/spec.md:93` (env/config residual accepted); spec 269
  (`launchPolicy` spine); `/home/goat/tachyon-plugins/agent-browser/tachyon-plugin.json:12-24` (static forced
  confirm env + denyArgs); upstream `vercel-labs/agent-browser` README + `agent-browser.dev/schema.json`
  (action-policy is a file path; no per-origin schema documented).

## REDESIGN ratified (2026-06-26) — session-scoped, domain-pinned trust

The adversarial debate (`debate.md`) returned **REDESIGN**; the owner ratified the pivot. The pre-debate model
(per-command `get url` origin preflight + env-scrub/denyArgs **denylists** + per-event overrides) is superseded.
New model: **trust is scoped to a domain-pinned session**, enforced via **allowlists**. spec.md/plan.md/tasks.md
rewritten accordingly.

Why the old model failed (both reviewers, independently): the observed top-level URL is not the origin that
receives a mutation (popup/iframe/redirect/pending-`confirm` confusion), the observe→act race is intrinsic, and a
denylist can never be complete against the binary's full env/flag/command surface.

### Empirical findings (binary inspection, 2026-06-26) — basis for the new model

`agent-browser` v0.31.0 (`strings` + `--help`):
- **Domain filter is real + enforcing:** `--allowed-domains <list>` / `AGENT_BROWSER_ALLOWED_DOMAINS` "Restrict
  navigation domains"; enforcement strings present ("`… is not allowed by domain filter`", "`… is not in the
  allowed domains list`", an HTML block page). → the load-bearing mechanism for domain-pinned `bypass`. **OQ1
  (must verify before build):** whether it covers iframes/popups/`about:blank`/sub-resources or only top-level nav.
- **Large env surface (why a denylist can't work):** `AGENT_BROWSER_ACTION_POLICY`, `_CONFIG`, `_INIT_SCRIPTS`,
  `_EXTENSIONS`, `_PLUGINS`, `_CDP`, `_AUTO_CONNECT`, `_PROFILE`, `_STATE`, `_ARGS`, `_PROXY*`, `_ALLOW_FILE_ACCESS`,
  `_DOWNLOAD_PATH`, `_SOCKET_DIR`, `_NAMESPACE`, `_SESSION`, … + OS `HOME`/`XDG_CONFIG_HOME`/`PWD` discovery + loader
  env. → **sterile env ALLOWLIST**, not a scrub list.
- **Dangerous flags outside the 5-entry denyArgs:** `--init-script <path>` (inject mutating JS before nav → a write
  via a "read" `open`), `--extension`, `--auto-connect` (reuse a running Chrome's auth), `connect`/`--cdp`,
  `--profile`, `--proxy`, `--allow-file-access`. → **arg ALLOWLIST**.
- **Stateful commands outside the confirm list:** `cookies set`, `storage`, `route`, `clipboard write`,
  `pushstate`, `auth save|login|delete`, `state`, **`confirm <id>` (executes a pending held action)**, `trace`,
  `record`. → **deny-by-default** category map over a pinned **read allowlist**.

### Debate participants

codex (repo-grounded adversarial review, cwd /home/goat/tachyon) + a Claude security red-team (governance-bypass
focus). Both converged on REDESIGN independently. codex's insisted change: session-scoped domain-pinned sessions
under a strict env/arg/cwd allowlist. Claude red-team's: env scrub must be an allowlist. Full findings in
`debate.md`.

## Task 0 (OQ1) RESULT — AGENT_BROWSER_ALLOWED_DOMAINS is NOT a containment boundary (2026-06-26)

Empirically tested agent-browser v0.31.0 with `AGENT_BROWSER_ALLOWED_DOMAINS=localhost` against a local logging
server reachable as both `localhost` (allowed) and `127.0.0.1` (disallowed). **Decisive: the native domain filter
only gates the CLI `open` verb. It does NOT contain the browser.** Disallowed-domain requests that REACHED the
server (proven by Host-header logging) + observed navigations:
- `location.href='http://127.0.0.1/…'` (in-page JS redirect) → **navigated** (`get url` confirmed 127.0.0.1).
- `<iframe src=127.0.0.1>` → **loaded** (server logged the request).
- `<img src=127.0.0.1>` / sub-resources → **loaded**.
- `fetch('http://127.0.0.1/…')` → **request sent** (only CORS blocked the response, not the filter).
- `window.open('http://127.0.0.1/…')` (popup) → **loaded**.
- Only `open http://127.0.0.1/…` (explicit CLI nav) → **blocked** ("Domain '127.0.0.1' is not in the allowed
  domains list"). `about:blank`/`data:` are rejected by `open` (no hostname).

**Consequence:** the redesign's load-bearing assumption — "a bypass write cannot land off-domain by construction
because the session is domain-pinned" — is **FALSE** with this binary. A bypass session can be driven off its
pinned domains via JS redirect / iframe / popup, after which a write would run unconfirmed on an untrusted origin.
`ALLOWED_DOMAINS` is at most **best-effort defense-in-depth on the `open` verb**, never the security boundary.

## Reframe (owner, 2026-06-26): trusted-sites is a TACHYON gate, not a native agent-browser feature

The owner flagged the conflation: `AGENT_BROWSER_ALLOWED_DOMAINS` is agent-browser's own (leaky) navigation
filter; the **trusted-sites-with-permission-levels** the owner asked for is **not** a native agent-browser
feature — it is a Tachyon governance concept built on the Tachyon confirm gate (specs 268/269). The enforcement
boundary is and must be the **Tachyon launcher confirm gate**, not the binary's domain filter. Robustness by level:
- **readonly** = deny-by-default on mutators → robust, origin-independent (no write ever runs).
- **confirm** (default) = hold → robust, origin-independent.
- **bypass** = the only level that relaxes → the hard case; the native filter does not make it safe.

Open design fork for bypass (owner to decide): (A) **session-scoped human trust** — the human marks a session
bypass = "I own every write the agent makes in this session"; Tachyon drops the confirm gate for that session only;
no origin detection, no TOCTOU, honest whole-session scope (site labels are how the human *thinks* of the session,
not an enforced constraint). (B) per-write current-origin re-check (the original preflight) — now the *only* lever,
with documented TOCTOU + off-domain-iframe residuals. Lean: (A) — cleanest expression of "human owns the actions",
no dependency on a leaky filter; keep ALLOWED_DOMAINS only as labelled best-effort defense-in-depth.

## Scope reduced to v1 = native config (owner, 2026-06-26)

After task 0 + the reframe, the owner chose to **reduce v1 scope**: v1 exposes only what agent-browser permits
**natively** (its `agent-browser.json` config — `confirmActions`, `allowedDomains`, timeouts, `downloadPath`, …,
schema at `agent-browser.dev/schema.json`), surfaced through the spec-270 config editor; the human owns it, the
agent can't override it (spec-268/269 spine unchanged). The Tachyon governance layer (per-site bypass/readonly +
launcher allowlists + real containment) is **v2, deferred** — built only on demand, and likely needs an upstream
navigation-filter fix since task 0 showed the native `allowedDomains` filter doesn't contain the browser. spec.md/
plan.md/tasks.md rewritten to v1; the full v2 design is preserved here + in `debate.md`. v1 must label the native
limits honestly (esp. `allowedDomains` = open-verb-only) and never sell native knobs as a security boundary.

## v1 BUILT + codex dueto folded (2026-06-26)

Spec 270 (generic configurable-plugin engine + UI) and spec 271 v1 (agent-browser native-config exposure) are
implemented on main. Mechanism: a generic `ToolLaunchPolicy.configArg` (the launcher prepends `--config <human
config path>` resolved from the lockfile) + `scrubEnv` (strips the agent's override env) + fail-closed
`CONFIG_MISSING` (configArg with an unresolved/absent config refuses — never an ungated fallback). The agent-browser
plugin (tachyon-plugins) swapped its static forced confirm env for configArg+scrubEnv, shipping a native config
(default = full confirmActions) + the pinned published schema + docsUrl. Net: the human owns the gate (edits the
native config via the Plugins Config editor); the agent cannot relax it.

**Codex security dueto on the launcher diff → BLOCK → folded:**
1. **Fail-OPEN (launcher, generic):** configArg declared but no config recorded in the lockfile → forcedConfig empty
   → ran ungated. Fixed: fail closed (CONFIG_MISSING) when configArg is set but the config is unresolved OR absent.
   (tachyon `d75af2f`)
2. **init-script injection (plugin):** `--init-script`/`AGENT_BROWSER_INIT_SCRIPTS` lets a "read" `open` register
   attacker JS that mutates page state without hitting confirmActions — a launcher-path bypass. Fixed by expanding
   the agent-browser denyArgs (+`--init-script`,`--extension`,`--cdp`,`--auto-connect`,`--args`,`addinitscript`,
   `connect`) + scrubEnv (+`_INIT_SCRIPTS`,`_EXTENSIONS`,`_PLUGINS`,`_CDP`,`_AUTO_CONNECT`,`_ARGS`).
   (tachyon-plugins `8edae4a`)

Honest v1 scope after folding: the confirmation GATE holds against launcher-path arg/env injection (the floor).
Still v2 (deferred): per-site bypass/readonly governance, the full sterile-env ALLOWLIST (v1 uses a targeted
denylist of the gate-defeating vectors, not an allowlist), and real navigation containment (native allowedDomains
is leaky — task 0). The same-user raw-exec / direct-config-edit residual remains accepted (spec 269 OQ1).
