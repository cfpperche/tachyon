# 269 — notes

## Why this exists (sequencing decision, 2026-06-26)

Building agent-browser v2 (form-driving, spec 268) needs a **mechanical** write gate. The CLI's native
`--confirm-actions` + non-TTY auto-deny is the gate, but a plugin can't *force* the enabling env onto the tool —
the launcher execs with inherited env, so the gate is only "on" if the agent exports the mandated env (a soft,
bypassable band-aid). The maintainer chose to fix the engine first rather than ship the band-aid.

**Codex consult (independent, POSITION: A — agreed):** don't ship the v2 write surface before the mechanical
enforcement exists; a "mechanical gate" doc with a "bypass by not exporting env" reality is too weak for
form-driving. Refinements folded into this spec:
- Name it a **launch POLICY** (`{ env, args, denyArgs, mode:"force" }`), not "defaults" (which read as advisory).
- It lives manifest → **lockfile** (launcher hot-path reads lockfile only) → launcher; **consent-surfaced +
  fingerprint-bound** (a policy change → re-consent). Unknown manifest fields already fail closed → forward-safe.
- Launcher-injected env alone is **not** bypass-proof: the agent can pass `--confirm-actions ""` / a different
  `--action-policy` → the launcher must **reject conflicting argv** (fail closed), not trust flag-vs-env precedence.
- **The raw-path hole (codex's key add):** the fetched binary is directly executable at
  `.tachyon/bin/<name>/<sha>/<exe>` (lockfile exposes `installPath`, mode `0500`) — a launch policy doesn't stop
  an agent from running it raw, outside the launcher. So the feature must NOT claim "bypass-proof" until that is
  closed (make the binary non-directly-executable so the validated-fd launcher is the only entrypoint — the
  launcher already does Linux procfd exec; assess `fexecve`@`0400`) or the claim is explicitly scoped to "launcher
  invocations." → OQ1.

This is a **general** spec-265-family feature (any tool that must always run with safety flags), not an
agent-browser one-off — which is part of why building it first is justified, not over-fitting.

## Sources

- codex consult transcript (read /home/goat/tachyon): POSITION A + the launchPolicy shape, argv-conflict +
  raw-path bypass findings, the minimal-change file map, and the acceptance-test list.
- `src/plugins/toolLauncher.ts` (resolve → hash-through-fd → `spawnSync` with inherited env — the gap),
  `src/plugins/manifest.ts` (`tools.*` schema + unknown-field fail-closed), `docs/specs/265-*`.

## Decisions & deviations (build-time)

_(fill during implementation + codex dueto; OQ1 raw-path decision must be recorded here)_
