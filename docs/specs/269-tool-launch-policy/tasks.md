# 269 — tasks

**Verify:** `env -u TMUX npx vitest run test/unit/pluginManifest.test.ts test/unit/pluginLockfile.test.ts test/unit/pluginToolPlan.test.ts test/unit/pluginToolLauncher.test.ts test/unit/pluginConsentViewModel.test.ts`

## Implementation (engine — spec-265 family)

- [ ] 1. **manifest.ts** — `ToolLaunchPolicy` type + parse/validate `tools.<name>.launchPolicy` (env-key regex,
  control-char-free values/args, size caps, `mode: "force"`, dedup denyArgs, reject unknown sub-fields). Tests.
- [ ] 2. **lockfile.ts** — `ToolLock.launchPolicy?` round-trip + fail-closed parse (corrupt → refuse). Tests.
- [ ] 3. **toolPlan.ts** — carry the policy into `ToolPlanItem`; bind it into the install fingerprint. Tests
  (policy change → fingerprint change).
- [ ] 4. **consentViewModel.ts** — a visible per-tool line: enforced env / args / refused args. Pure unit test.
- [ ] 5. **toolLauncher.ts** — build explicit `env = {...process.env, ...policy.env}`; reject agent argv that
  contains any `denyArgs` (fail closed, auditable); apply policy `args` in a non-neutralizable position; spawn.
  Unit + e2e (exec the launcher: env injected when parent omits; hostile parent env overridden; denied flag
  refused; normal passthrough unaffected).
- [x] 6. **OQ1 — RESOLVED: scope the claim, no file-mode hardening.** Binary stays `0500` (exec bit needed for
  the validated-fd exec; same-user shell can bypass regardless) → docs/consent say "enforced via the launcher",
  never "bypass-proof". Recorded in notes.
- [ ] 7. **Codex dueto** on the launcher diff (highest-trust component); fold.

## Verification

- [ ] manifest rejects malformed policy + unknown fields (scenario 1)
- [ ] consent shows the forced policy; fingerprint binds it (scenario 2)
- [ ] lockfile round-trips; corrupt policy fails closed; launcher reads lockfile policy (scenario 3)
- [ ] launcher injects env even when parent omits/contradicts it (scenario 4)
- [ ] launcher refuses a conflicting agent arg (scenario 5)
- [x] raw-path residual explicitly scoped — docs/consent say "enforced via launcher", no "bypass-proof" overclaim (scenario 6 / OQ1)
- [ ] agent-browser fixture: headless write held/denied under the launcher policy, un-ungate-able via argv (scenario 7)
- [ ] Green gate: full vitest + tsc×2 + engine-boundary + esbuild

## Unblocks

- [ ] spec 268 (agent-browser v2 form-driving) declares its `launchPolicy` → the write gate becomes mechanical.
