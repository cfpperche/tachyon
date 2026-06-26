# 271 — plan

## The touch-points (launcher + policy + agent-browser plugin)

- **Policy schema + loader (new pure module)** — define the trust-policy type, parse/validate fail-closed
  (level enum, known-event-name overrides, dedup patterns, size caps, explicit precedence), and a pure decision
  function `decide(origin, category, policy) → "bypass" | "confirm" | "deny"`. Pure + unit-tested (keep the
  trust decision out of the vscode/launcher I/O layer — logic in the vscode layer escapes CI).
- `src/plugins/toolLauncher.ts` — the enforcement seam (currently `runLauncher` → `launchTool`, env built at
  `:258`). Add, for the agent-browser tool:
  1. **Env scrub** — strip/neutralize `AGENT_BROWSER_ACTION_POLICY`, `AGENT_BROWSER_CONFIG`, and config-file
     discovery (`./agent-browser.json`, `~/.agent-browser/config.json`) from the child env (e.g. force
     `AGENT_BROWSER_CONFIG` to an empty/sentinel + run with a scrubbed cwd/HOME view as needed).
  2. **Category resolution** — map the subcommand to read vs write category (reuse the spec-268 list).
  3. **Origin preflight** — resolve current origin conservatively; on low confidence → treat as non-bypass.
  4. **Decision** — call the pure `decide(...)`; then either drop the confirm env (`bypass`), keep forcing it
     (`confirm`), or refuse the exec with the stable `TACHYON_AGENT_BROWSER_POLICY_DENIED` message (`readonly`).
- **Tachyon-owned policy path** — a fixed, launcher-resolved location (not plugin-chosen); the launcher reads
  **only** this path. The spec-270 Config button for agent-browser opens this same file (shared editing UX).
- **agent-browser plugin** (`/home/goat/tachyon-plugins/agent-browser`) — declare its `config` (= the trust-policy
  schema) + `docsUrl` (→ the plugins repo) per spec 270, so the card gets Config/Docs + post-install nav. The
  static manifest `launchPolicy.env.AGENT_BROWSER_CONFIRM_ACTIONS` stays as the **default/unlisted** posture; the
  launcher now *removes* it for confidently-resolved `bypass` sites only.
- **Skill doc** (`skills/agent-browser/SKILL.md`) — document the deny line + that `readonly` is a hard stop (don't
  retry; ask the human), and that bypass/readonly are human-owned.

## Decision function (pure)

```ts
type Level = "bypass" | "confirm" | "readonly";
interface SiteRule { pattern: string; level: Level; events?: Record<string, Level>; }
interface TrustPolicy { sites: SiteRule[]; }

// precedence: event-override > site default > unlisted = "confirm"; origin low-confidence ⇒ never "bypass".
function decide(origin: string | null, category: string, p: TrustPolicy): "bypass" | "confirm" | "deny";
```

`readonly` + write category → `"deny"`; `bypass` + confident origin → `"bypass"`; everything else → `"confirm"`.

## Build order (bottom-up, each tested)

1. **policy module** — schema validation + `decide(...)`; exhaustive unit tests (precedence, unknown event name
   rejected, unlisted = confirm, readonly→deny, low-confidence origin never bypass).
2. **env scrub** — launcher strips agent-browser policy/config env + config-file discovery; e2e: planted
   `AGENT_BROWSER_ACTION_POLICY`/`./agent-browser.json` has **no effect** on posture.
3. **origin preflight + category map** — resolve origin conservatively; map subcommand→category; unit + e2e.
4. **launcher integration** — wire `decide(...)` into `runLauncher`; bypass drops confirm env, confirm keeps it,
   readonly refuses with the stable deny line; e2e per acceptance scenario.
5. **plugin config/docs declaration** (spec 270 UX) + Tachyon-owned path wiring; post-install nav opens the policy.
6. **skill doc** update; **codex dueto** on the launcher diff (highest-trust component) + the env-scrub
   completeness; fold.

## Co-development with 270 (vertical slice)

271 is the first real consumer of 270. Build them together: 270's manifest/lockfile/editor primitives + 271's
launcher enforcement land as one slice so the policy proves the primitives are sufficient (path, schema
association, lockfile metadata, post-install nav).

## Verify (mechanical)

`env -u TMUX npx vitest run` over the policy module + launcher suites (`test/unit/pluginToolLauncher.test.ts` +
the new policy test) — exact list pinned in tasks.md once modules land. Plus the agent-browser write-gate
e2e fixture extended with bypass/readonly/scrub cases.
