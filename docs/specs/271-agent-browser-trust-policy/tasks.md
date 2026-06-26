# 271 — tasks

_v1 (owner-reduced 2026-06-26): expose agent-browser's native config via the spec-270 editor. Governance = v2,
deferred._

**Verify:** `env -u TMUX npx vitest run test/unit/pluginToolLauncher.test.ts`
<!-- extend with the plugin-config wiring suite once it lands -->

## Implementation (v1)

- [ ] 1. **Pin agent-browser's published JSON Schema** (`agent-browser.dev/schema.json`) to the tool version;
  vendor it with the agent-browser plugin (offline, reproducible validation).
- [ ] 2. **agent-browser plugin declares config + docs** (spec 270): `config` → native `agent-browser.json` shape,
  `schema` → the pinned copy, `default` → a sane starter that keeps today's forced `confirmActions` (no behaviour
  change until the human relaxes it); `docsUrl` → plugins repo.
- [ ] 3. **Launcher sources the human config** from the Tachyon-owned path via a launcher-set native `--config`/env;
  keep spec-269 `denyArgs` (agent can't pass its own `--config`/`--confirm-actions`/`--action-policy`/`mcp`/`batch`).
  Unit + e2e (human value applied; agent override refused).
- [ ] 4. **(OQ4) env passthrough** — decide + (lean) close `AGENT_BROWSER_ACTION_POLICY`/`_CONFIG` env passthrough
  (`toolLauncher.ts:255`); narrows the spec-268 residual. Test.
- [ ] 5. **270 editor** — associate the pinned schema for live validation; surface honest limit labels (native
  `allowedDomains` = open-verb-only, task 0 — not a security boundary).
- [ ] 6. **Skill doc** — config is human-owned; native `allowedDomains` limitation; no Tachyon per-site trust in v1.
- [ ] 7. **Codex dueto** on the launcher change; fold.

## Verification (v1)

- [ ] agent-browser plugin is human-configurable via the 270 Config editor; Docs opens; post-install nav (scenario 1)
- [ ] launcher applies the human's native config from the Tachyon-owned path (scenario 2)
- [ ] agent cannot override (denyArgs unchanged; env passthrough closed if OQ4 done) (scenario 3)
- [ ] native-knob limits labelled, not oversold (esp. `allowedDomains`) (scenario 4)
- [ ] Green gate: full vitest + tsc×2 + engine-boundary + esbuild

## Depends on

- [ ] spec 270 (configurable-plugins) — the Config/Docs editor UX + post-install nav (reuses the published-schema
  association; no Tachyon-authored schema needed for v1, reinforcing 270 OQ6).

## Deferred — v2 (Tachyon per-site trust governance)

- [ ] Per-(session|site) `bypass`/`readonly`/`confirm` enforced by the launcher (sterile env allowlist + arg
  allowlist + deny-by-default command map + env scrub). Design preserved in `debate.md` + notes.md. Gate on demand
  + likely an upstream agent-browser navigation-filter fix (task 0).
