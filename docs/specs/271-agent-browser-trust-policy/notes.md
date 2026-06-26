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
