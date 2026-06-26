# 271 — tasks

_Redesigned 2026-06-26 (owner-ratified): session-scoped, domain-pinned trust + allowlists._

**Verify:** `env -u TMUX npx vitest run test/unit/pluginToolLauncher.test.ts test/unit/agentBrowserTrust.test.ts`
<!-- pin the exact new suite name once the trust module lands -->

## Implementation (launcher enforcement — spec-269 family)

- [ ] 0. **Verify OQ1 (gating research)** — empirically test what `AGENT_BROWSER_ALLOWED_DOMAINS` restricts
  (top-level nav vs iframe / popup / `about:blank`/`data:` / sub-resource) against a real Chrome. Record findings
  in notes.md; if coverage is partial, narrow the bypass claim **before** building.
- [ ] 1. **trust module (first-party)** — `TrustProfile`/`TrustProfiles` types + Tachyon-owned JSON Schema +
  `resolveProfile(session, namespace, profiles)` + `decide(profile, subcommand)`; exhaustive unit tests (match;
  unlisted⇒confirm; readonly⇒deny across the full mutator set incl. cookies/storage/route/clipboard/pushstate/
  auth/state/`confirm <id>`/trace/record; read allowlist runs; unknown command ⇒ deny-by-default).
- [ ] 2. **sterile env allowlist + cwd/HOME** — launcher builds the child env from a fixed allowlist; drop all
  `AGENT_BROWSER_*` policy/config/injection vars + `HOME`/`XDG_CONFIG_HOME`/`PWD` + loader env; set known
  `cwd`/`HOME` on `spawnSync`. e2e: planted env/configs have **no effect**.
- [ ] 3. **arg allowlist** — refuse `--init-script`/`--extension`/`--auto-connect`/`connect`/`--cdp`/`--profile`/
  `--proxy`/`--allow-file-access`/`--allowed-domains`/`--action-policy`/`--config`/`--confirm-actions`/`mcp`/`batch`
  + any unknown flag (fail closed). Supersede the 5-entry denyArgs. Unit + e2e (`--init-script` refused).
- [ ] 4. **profile match + domain pin + category apply** — wire `resolveProfile`+`decide` into `runLauncher`:
  trusted ⇒ force `AGENT_BROWSER_ALLOWED_DOMAINS`; bypass ⇒ drop confirm env; readonly ⇒ refuse write with the
  stable `TACHYON_AGENT_BROWSER_POLICY_DENIED:` line; unlisted ⇒ force confirm env. e2e per scenario.
- [ ] 5. **Tachyon-owned path + plugin docs/config (270 UX)** — fixed first-party profiles path; agent-browser
  plugin declares `docsUrl` + first-party-managed config; post-install nav opens the profiles file; Config button
  opens it.
- [ ] 6. **skill doc** — `SKILL.md`: trusted (bypass, domain-pinned) vs locked (readonly hard-stop) sessions;
  reads always frictionless; don't retry a readonly deny.
- [ ] 7. **Codex dueto** on the launcher diff + env/arg/command allowlist completeness (highest-trust path); fold.

## Verification

- [ ] OQ1 domain-filter coverage recorded; bypass claim matches the measured coverage (task 0)
- [ ] trust schema validates fail-closed; first-party (not manifest-derived) (scenario 1)
- [ ] bypass session runs writes on-domain, frictionless, launcher-computed (scenario 2)
- [ ] bypass session cannot act off its pinned domains — filter blocks (scenario 3)
- [ ] readonly hard-denies all mutators (deny-by-default) with the stable line; reads frictionless (scenario 4)
- [ ] unlisted session keeps spec-268 held-for-confirm (no regression) (scenario 5)
- [ ] sterile env allowlist: planted env/configs/loader-env have no effect (scenario 6)
- [ ] arg allowlist: dangerous flags/commands refused, fail closed (scenario 7)
- [ ] agent cannot author/repoint/widen a profile; same-user residual documented, not advertised away (scenario 8)
- [ ] Green gate: full vitest + tsc×2 + engine-boundary + esbuild + agent-browser e2e (bypass / off-domain /
  readonly / env-allowlist / arg-allowlist cases)

## Depends on

- [ ] spec 270 (configurable-plugins) — first-party-only security lane + Config/Docs UX + post-install nav.
  Co-developed as one vertical slice.
