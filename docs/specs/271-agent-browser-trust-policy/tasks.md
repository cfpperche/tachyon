# 271 — tasks

**Verify:** `env -u TMUX npx vitest run test/unit/pluginToolLauncher.test.ts test/unit/agentBrowserTrustPolicy.test.ts`
<!-- pin the exact new suite name once the policy module lands -->

## Implementation (launcher enforcement — spec-269 family)

- [ ] 1. **policy module** — `TrustPolicy`/`SiteRule` types + fail-closed schema validation (level enum, known
  normalized event names only, dedup patterns, size caps) + pure `decide(origin, category, policy)`; exhaustive
  unit tests (precedence: event > site > unlisted=confirm; readonly→deny; low-confidence origin never bypass;
  unknown event name rejected).
- [ ] 2. **env scrub** — launcher strips/neutralizes `AGENT_BROWSER_ACTION_POLICY` + `AGENT_BROWSER_CONFIG` +
  config-file discovery (`./agent-browser.json`, `~/.agent-browser/config.json`); e2e: a planted policy/config has
  **no effect** on posture. (Closes the spec-268 residual.)
- [ ] 3. **category map + origin preflight** — subcommand→read/write category (reuse spec-268 list); conservative
  current-origin resolution with a confidence signal; unit + e2e.
- [ ] 4. **launcher integration** — wire `decide(...)` into `runLauncher`: `bypass` drops the confirm env,
  `confirm` keeps forcing it, `readonly` write → refuse exec + stable
  `TACHYON_AGENT_BROWSER_POLICY_DENIED:` line. e2e per acceptance scenario.
- [ ] 5. **Tachyon-owned policy path + plugin config/docs** — fixed launcher-resolved policy path; agent-browser
  plugin declares `config` (= trust-policy schema) + `docsUrl` (→ plugins repo) per spec 270; post-install nav
  opens the policy; Config button opens the Tachyon-owned file.
- [ ] 6. **skill doc** — `SKILL.md`: `readonly` = hard stop (don't retry, ask the human); bypass/readonly are
  human-owned; reads always frictionless.
- [ ] 7. **Codex dueto** on the launcher diff + env-scrub completeness (highest-trust path); fold.

## Verification

- [ ] policy validates fail-closed; unknown event name rejected; precedence correct (scenario 1)
- [ ] bypass site runs writes frictionless, launcher-computed only (scenario 2)
- [ ] unlisted site keeps spec-268 held-for-confirm (no regression) (scenario 3)
- [ ] readonly site hard-denies writes with the stable deny line; reads frictionless (scenario 4)
- [ ] origin ambiguity falls back to confirm/deny, never bypass (scenario 5)
- [ ] planted policy/config env + files are scrubbed → no effect on posture (scenario 6)
- [ ] agent cannot author/repoint policy via args/env; same-user file-edit residual documented, not advertised
  away (scenario 7)
- [ ] Green gate: full vitest + tsc×2 + engine-boundary + esbuild + the agent-browser write-gate e2e fixture
  (bypass / readonly / scrub cases)

## Depends on

- [ ] spec 270 (configurable-plugins) — Config/Docs UX + lockfile metadata + post-install nav. Co-developed as one
  vertical slice.
