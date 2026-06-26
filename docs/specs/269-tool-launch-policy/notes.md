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

## OQ1 RESOLVED (2026-06-26, maintainer-approved): scope the claim, no file-mode hardening

Investigated closing the raw-path bypass. Two blockers, explained in plain terms to + approved by the maintainer:
1. **Infeasible without breaking exec.** The launcher execs via `/proc/self/fd/3` (the validated fd), which STILL
   requires the on-disk file to have its execute bit (`toolLauncher.ts:196-198`). Setting the binary `0400` would
   make the **launcher itself** fail `EACCES`. The only way to keep it non-executable on disk yet launcher-runnable
   is a `memfd_create`+`fexecve` loader, which Node does not expose (would need a cross-platform native addon).
2. **Insufficient even if feasible.** The agent runs **same-user with a shell**, so it can read the owner-readable
   bytes and `cp`+`chmod +x`+exec a copy, or just `npm i -g agent-browser` and run that — entirely outside Tachyon.
   No file permission stops a same-user shell from re-executing bytes it can read.

→ Decision: the binary **stays `0500`**; the feature ships the `launchPolicy` (forced env + `denyArgs` rejection)
enforced **on the launcher path** (where the agent operates by default), and the claim is honestly **"enforced via
the launcher"**, never "bypass-proof". True bypass-proofing = **sandboxing the agent** (its only path is the
launcher) — a separate containment layer, filed as future research, not built here. The `launchPolicy` is still a
real jump from v1's prose gate to a mechanical one on the path that matters.

## Codex dueto (2026-06-26) — NEEDS-REVISION, all 5 folded

No BLOCK. Five SHOULDs on the high-trust launcher, all folded:
1. **Forced args were neutralizable** (prepended → a last-wins CLI lets the agent re-pass the flag with a new
   value). Fix: the launcher now also REFUSES any agent arg whose flag-name matches a flag the policy forces
   (`forcedFlags` derived from `policy.args`), unioned with `denyArgs`. e2e test added.
2. **`{ env: {} }` inconsistency** (manifest accepted it → empty policy → the lockfile re-parse then rejected it).
   Fix: the "≥1 of env/args/denyArgs" check now runs on the PARSED result, so an empty env is rejected at the
   manifest, consistently. Test added.
3. **denyArgs completeness is the plugin author's burden** (aliases/short-forms/config-file flags). Accepted +
   documented honestly in the launcher comment + the scope: the gate is "enforced via the launcher for the
   DECLARED flags"; the launcher can't know an arbitrary tool's full grammar (consistent with the non-bypass-proof
   scope). Not over-engineered into a generic flag-grammar model.
4. **Fingerprint key-order instability** (reordered env keys hashed differently). Fix: `parseLaunchPolicy` now
   stores env with **sorted** keys (canonical), so the fingerprint + lockfile serialization are stable. Test added.
5. **High-risk forced env** (`LD_PRELOAD`/`PATH`/`NODE_OPTIONS`/loader vars could smuggle code past the
   content-addressed binary). Fix: `parseLaunchPolicy` **rejects** a denylist of loader/exec-hijacking env keys —
   a malicious plugin can't force them, so consent never has to reason about them. Tests added.

Re-validated: tsc clean; manifest/lockfile/launcher suites green.

## Decisions & deviations (build-time)

- `denyArgs` matching is exact-name or `--flag=value`; the launcher additionally auto-denies the flag-names in
  `policy.args`. Aliases/short-forms are the plugin author's responsibility (documented; honest scope).
- Forced env keys are validated + a loader/exec-hijack denylist is rejected; env is stored sorted (canonical).
- No host-provided lock build carries the policy yet (detect-first builds no lock in `toolProvisionRun`); the
  fetched path (agent-browser's) does. A follow-up if detect-first + policy is ever combined.
