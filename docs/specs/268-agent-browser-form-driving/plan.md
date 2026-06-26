# 268 — plan

## Strategy: reuse the CLI's native safety surface, don't reinvent it

v1's write gate was prose. v2's is the binary's own `--confirm-actions` / `confirm`/`deny` / `--allowed-domains`
machinery. The plugin's job is to **default it on** for write categories and teach the workflow — minimal new
code, maximal enforcement (a non-TTY agent's write is auto-denied unless a human confirms).

## Build order

1. **Pin the category vocabulary (OQ2).** Drive the provisioned binary: issue each write verb under
   `AGENT_BROWSER_CONFIRM_ACTIONS=<guess>` and read the `confirmation_required` JSON to learn the real category
   names + the command→category map (click/fill/type/press/select/check/upload/submit, plus eval/download).
2. **Decide the default gate (OQ3).** Lean: env categories (`AGENT_BROWSER_CONFIRM_ACTIONS` = all write
   categories) + `AGENT_BROWSER_CONFIRM_INTERACTIVE=1`, set once per session. Optionally bundle a stricter
   `--action-policy` JSON the skill can opt into.
3. **Manifest → 2.0.0.** No new tool (same binary); description gains the form-driving + mechanical-gate framing.
4. **Skill (v2 section).** Add the form-driving loop: snapshot → identify `@eN` → (the write is held →) surface
   the pending id → human `confirm <id>` → act → verify. Mandate the session env exports up front. Add the
   `AGENT_BROWSER_ALLOWED_DOMAINS` staging/allow-list guidance and the action-log convention.
5. **Action log (OQ4).** Append each write's `--json` result to `.tachyon/browser-actions.log` (gitignored) —
   either a thin `act.sh` wrapper the skill routes writes through, or capture per-call. Prefer the simplest that
   records held/denied/confirmed/executed.
6. **Dogfood (live).** Serve a tiny local form (a `file://` or `python -m http.server` page), drive it: prove a
   `click`/submit is held + auto-denied headless, a human `confirm <id>` lets it through once, an off-allow-list
   nav is refused, and the log captures it. Reads stay frictionless.
7. **Codex dueto** on the v2 skill + wiring; fold.
8. **Tag** the plugins repo (`v0.8.0`, agent-browser 2.0.0) + push; re-source the dogfood → spec-266 detection
   later offers it as an update from the installed v1.0.0.

## The enforcement honesty (OQ1)

Env/flag gating is only active if the mandated session env is exported. The agent *could* call the launcher
without it. True bypass-proof enforcement needs the **launcher** to inject default env/args for a tool — an
engine change in the spec-265 family (a manifest `tool.defaultEnv` / `tool.defaultArgs` the launcher always
applies). v2 ships the env-mandated gate (a real, fail-closed improvement over prose) and files the
launcher-injection idea as the long-term home. Flagging it explicitly, not silently shipping a soft gate as hard.

## Reuse / consistency

- Same provisioned binary + launcher; no engine change in v2 itself.
- Same dogfood-then-tag rhythm; spec-266 update detection already governs the plugin.
- The action-log + state files share the gitignored `.tachyon/` credential-class home from v1.

## Test / proof plan

Live dogfood transcript (in notes.md): held-and-auto-denied write, human-confirmed write executes once,
allow-list refusal, action-log entries, unchanged read path. Categories pinned from real `confirmation_required`
output.
