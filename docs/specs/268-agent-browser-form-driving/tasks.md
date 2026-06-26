# 268 — tasks

**Verify:** _(plugin payload in the external repo; proof is the dogfood transcript in notes.md)_

## Implementation (v2 — form-driving)

- [ ] 1. **Pin the category vocabulary (OQ2).** Drive the provisioned binary to learn the real
  `--confirm-actions` category names + the command→category map for click/fill/type/press/select/check/upload/
  submit (+ eval/download), from the `confirmation_required` JSON responses.
- [ ] 2. **Decide + wire the default gate (OQ3).** Env categories (all write categories) +
  `AGENT_BROWSER_CONFIRM_INTERACTIVE=1`, set once per session; optional bundled `--action-policy` JSON.
- [ ] 3. **Manifest → 2.0.0** with the form-driving + mechanical-gate description.
- [ ] 4. **Skill v2 section** — the snapshot → target → (held) → `confirm <id>` → act → verify loop; mandate the
  session env up front; `AGENT_BROWSER_ALLOWED_DOMAINS` allow-list guidance; the action-log convention.
- [ ] 5. **Action log** — append each write's outcome (held/denied/confirmed/executed) to
  `.tachyon/browser-actions.log` (gitignored).
- [ ] 6. **Live dogfood** against a tiny local/staging form: a write is held + auto-denied headless; a human
  `confirm <id>` lets it through once; an off-allow-list nav is refused; reads stay frictionless; the log records it.
- [ ] 7. **Codex dueto** on the v2 skill + wiring; fold.
- [ ] 8. **Tag** the plugins repo `v0.8.0` (agent-browser 2.0.0) + push; re-source the dogfood (spec-266 then
  offers it as an update from v1.0.0).

## Verification

- [ ] A headless state-mutating action is held + auto-denied without confirmation (scenario 1)
- [ ] An explicit human `confirm <id>` executes it exactly once; deny/timeout blocks it (scenario 2)
- [ ] Reads/inspection require no confirmation — v1 loop unchanged (scenario 3)
- [ ] Off-allow-list navigation is refused (scenario 4)
- [ ] Every write is appended to the gitignored action log with outcome (scenario 5)
- [ ] The form-driving loop is taught + dogfooded against a real form, gate firing on submit (scenario 6)

## Deferred / engine follow-up

- [ ] OQ1 — a launcher-injected `tool.defaultEnv`/`tool.defaultArgs` (spec-265 family) to make the gate
  bypass-proof (engine change; not in this spec).
- [ ] v1.1 — the `agent-browser mcp` typed surface (separate).
