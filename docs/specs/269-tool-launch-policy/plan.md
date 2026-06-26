# 269 — plan

## The gap (codex-located)

`toolLauncher.ts` resolves the lockfile tool, validates the content-addressed path, hashes through an open fd,
then `spawnSync`s with passthrough argv and **inherited env** (no `env` passed). The four touch-points:

- `src/plugins/manifest.ts` — `tools.*` currently accepts only `version`/`versionCommand`/`allowedHostSha256`/
  `platforms`; unknown fields fail closed. Add + validate `launchPolicy`.
- `src/plugins/toolPlan.ts` — carry the policy into `ToolPlanItem` so `previewInstall` can show it + the
  fingerprint can bind it.
- `src/plugins/lockfile.ts` — add `launchPolicy?` to `ToolLock`, fail-closed parse (the launcher hot path reads
  the lockfile only).
- `src/plugins/toolLauncher.ts` — return the policy from the resolve step; in the launch step build an explicit
  `env = { ...process.env, ...policy.env }`, validate/reject conflicting argv (`denyArgs`), apply policy `args`,
  then `spawnSync` with that env.
- `src/plugins/consentViewModel.ts` — render the enforced env/args/denyArgs in the per-tool consent section.

## Data shape

```ts
interface ToolLaunchPolicy {
  env?: Record<string, string>;     // forced; overrides parent env for these keys
  args?: string[];                  // always applied, in a position the agent can't neutralize
  denyArgs?: string[];              // agent argv containing any of these → refuse to exec
  mode: "force";                    // only mode in v1 (room for "default"/"warn" later)
}
```

Validation (fail-closed): env keys match `^[A-Z_][A-Z0-9_]*$`, values + args are control-char-free, all lists +
the env map are size-capped, `mode` ∈ {"force"}, no duplicate denyArgs. Unknown sub-fields rejected.

## Build order (bottom-up, each tested)

1. **manifest.ts** — parse + validate `ToolLaunchPolicy`; unit tests (valid, malformed env key, control char,
   oversize, unknown field, bad mode).
2. **lockfile.ts** — `ToolLock.launchPolicy` round-trip + fail-closed parse; unit tests.
3. **toolPlan.ts** — thread the policy into `ToolPlanItem`; **fingerprint binds it** (a policy change → new
   fingerprint); unit tests (drift changes fingerprint).
4. **consentViewModel.ts** — a visible per-tool line ("always launches with … ; refuses …"); pure unit test.
5. **toolLauncher.ts** — the enforcement: explicit env build + `denyArgs`/conflict rejection + `args` application,
   then spawn. Unit + an e2e that EXECS the launcher: env injected when parent omits it, hostile parent env
   overridden, `--<deniedflag>` refused, normal passthrough still works.
6. **OQ1 — RESOLVED: no file-mode hardening.** The binary stays `0500` (the validated-fd exec needs the execute
   bit; Node lacks `memfd`/`fexecve`), and a same-user shell agent can copy+exec or install upstream regardless —
   so the claim is scoped to "enforced via the launcher" in docs + consent, never "bypass-proof". Nothing to build
   here beyond keeping the wording honest.
7. **Codex dueto** on the launcher change (highest-trust component — do not skip); fold.

## Acceptance tests (codex list)

- manifest rejects malformed policy + unknown fields
- preview fingerprint changes when policy changes
- lockfile round-trips policy; corrupted policy fails closed
- launcher injects env even when parent env omits it; overrides a hostile parent env
- launcher rejects `--confirm-actions ""` / a conflicting `--action-policy`
- agent-browser fixture: a headless write is `confirmation_required`/denied under the launcher policy and cannot
  be made ungated through argv
- raw-path: prove raw exec is impossible, OR the claim is explicitly scoped to launcher invocations

## Consistency / safety

- The launcher stays the single trust boundary; the policy comes from the **lockfile** (consented + fingerprinted),
  never re-read from the manifest at exec time.
- Forward-safe: a pre-269 Tachyon rejects the unknown `launchPolicy` manifest field (fail closed), so an old
  install never silently drops the gate.
- After 269 ships, spec 268 (agent-browser v2) declares its `launchPolicy` and the form-driving gate is mechanical.
