# 271 — plan

_Redesigned 2026-06-26 (owner-ratified): session-scoped, domain-pinned trust under sterile env + arg + command
allowlists. Supersedes the per-command origin-preflight plan (see `debate.md`)._

## The touch-points

- **First-party trust module (new, Tachyon-owned)** — the trust-profile type + JSON Schema + a pure resolver. NOT
  in the plugin manifest (debate: the security schema/path must be first-party). Pure + unit-tested (keep the trust
  decision out of the launcher I/O layer — logic in the vscode/launcher layer escapes CI).
  - `resolveProfile(session, namespace, profiles) → Profile | null`
  - `decide(profile, subcommand) → "run" | "confirm" | "deny"` (deny-by-default over a pinned **read allowlist**).
- `src/plugins/toolLauncher.ts` — the enforcement seam (`runLauncher` ~:220; env built ~:255; `spawnSync` ~:186
  sets no cwd). For the agent-browser tool, replace "inherit env + force one var" with:
  1. **Sterile env allowlist** — build the child env from a fixed allowlist; drop all `AGENT_BROWSER_*`
     policy/config/injection vars + `HOME`/`XDG_CONFIG_HOME`/`PWD` + loader env; set a known `cwd`/`HOME`.
  2. **Profile match** → forced `AGENT_BROWSER_ALLOWED_DOMAINS=<domains>` for trusted profiles.
  3. **Arg allowlist** — refuse anything outside the safe command+flag set (fail closed), superseding the
     5-entry denyArgs.
  4. **Category decide** → bypass: drop confirm env; readonly: refuse write/mutator with the stable deny line;
     confirm: force confirm env (today's behavior).
- **Tachyon-owned profile path + loader** — fixed first-party path; launcher reads + validates it; excluded from
  the install fingerprint. The spec-270 Config button for agent-browser opens this file.
- **agent-browser plugin** (`/home/goat/tachyon-plugins/agent-browser`) — declares `docsUrl` (→ plugins repo) +
  that it has first-party-managed config (per 270); the static manifest `launchPolicy` stays as the **default**
  (unlisted-session) confirm posture. Trust schema/path are NOT in the manifest.
- **Skill doc** (`skills/agent-browser/SKILL.md`) — document: sessions can be human-trusted (bypass) or locked
  (readonly); readonly is a hard stop (don't retry, ask the human); trusted sessions are domain-pinned.

## Data shape (first-party)

```ts
type Level = "bypass" | "readonly";              // absent profile ⇒ "confirm" (spec-268 default)
interface TrustProfile { session: string; domains: string[]; level: Level; }
interface TrustProfiles { profiles: TrustProfile[]; }
```

## Allowlists (derived empirically — OQ3/OQ4)

- **Read allowlist (run under any level):** open, snapshot, screenshot, pdf?, get *, read, find, is, count, wait,
  scroll, back/forward/reload?, title, url. Everything else = write. (pdf/back/forward/reload to be classified
  during build — some touch state.)
- **Arg allowlist:** the read/write subcommands above + `--session`/`--namespace` + benign render flags; **refuse**
  `--init-script`, `--extension`, `--auto-connect`, `connect`, `--cdp`, `--profile`, `--proxy`,
  `--allow-file-access`, `--allowed-domains`, `--action-policy`, `--config`, `--confirm-actions`, `mcp`, `batch`,
  any unknown flag.
- **Env allowlist:** PATH + a Tachyon-set HOME/cwd + `AGENT_BROWSER_SESSION`/`_NAMESPACE` + a Tachyon-owned
  `AGENT_BROWSER_SOCKET_DIR` + the launcher-forced `AGENT_BROWSER_ALLOWED_DOMAINS`/`_CONFIRM_ACTIONS`. Drop the rest.

## Build order (bottom-up, each tested)

1. **Verify OQ1 first** — empirically determine `AGENT_BROWSER_ALLOWED_DOMAINS` coverage (top-level vs
   iframe/popup/`about:blank`/sub-resource) with a real Chrome. The whole model's strength rests on this; if
   coverage is partial, adjust the bypass claim before building.
2. **trust module** — type + first-party schema + `resolveProfile` + `decide`; exhaustive unit tests (profile
   match; unlisted ⇒ confirm; readonly ⇒ deny over the full mutator set; read allowlist; deny-by-default for an
   unknown command).
3. **sterile env allowlist + cwd/HOME** — launcher builds an allowlisted child env; e2e: planted
   `AGENT_BROWSER_*`/`HOME`/`XDG`/`LD_PRELOAD` has **no effect**.
4. **arg allowlist** — refuse the dangerous flags/commands (fail closed); unit + e2e (`--init-script` refused).
5. **profile match + domain pin + category apply** — wire into `runLauncher`; e2e per acceptance scenario
   (bypass on-domain runs; off-domain blocked by the filter; readonly denies; unlisted held).
6. **Tachyon-owned path + plugin docs/config (270 UX)**; post-install nav opens the profiles file.
7. **skill doc**; **codex dueto** on the launcher diff + allowlist completeness (highest-trust path); fold.

## Co-development with 270 (vertical slice)

271 drives 270's real requirements. Build together: 270's first-party-only security-lane primitive + editor/docs/
nav + 271's launcher enforcement land as one slice.

## Verify (mechanical)

`env -u TMUX npx vitest run` over the trust module + launcher suites + the agent-browser e2e fixture extended with
bypass/readonly/off-domain/env-allowlist/arg-allowlist cases — exact list pinned in tasks.md once modules land.
