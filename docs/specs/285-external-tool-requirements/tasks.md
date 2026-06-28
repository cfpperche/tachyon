# 285 — external-tool-requirements — tasks

**Verify:** `npx vitest run test/unit && npm run typecheck && npm run build`

## Lane A — manifest + detection + guardrails
- [ ] A1. `manifest.ts`: `ExternalToolDecl` (name, detect? argv, install: per-PM { argv }, manual) + `parseExternalTools` (D1 key `externalTools`; reject shell strings / control chars; cap argv). `PluginManifest.externalTools`.
- [ ] A2. `externalTool.ts` (NEW): `detectExternalTool` (D4 clean-PATH realpath + ancestry/owner trust via the toolLauncher pattern + `execFile` detect w/ timeout/cap, no shell) + PM detection (D3 trusted absolute candidates).
- [ ] A3. `externalTool.ts`: `validateInstallArgv` (D3 guardrails: control chars, length cap, leading `sudo?` then PM exe matching the declared family at a trusted realpath).
- [ ] A4. Tests: parse (reject shell string, cap), detect (present/missing/spoofed-cwd rejected), validateInstallArgv (reject malformed/family-mismatch).

## Lane B — resolver + lockfile + assisted install
- [ ] B1. `externalTool.ts`: `resolveExternalTool` (D5 trusted abs path or fail-closed) + `_tachyon-external` shim (mirror `_tachyon-data`) + `externalToolEntry.ts` bundle + esbuild.
- [ ] B2. `lockfile.ts`: `ExternalToolReq` lock entry (D7; no pin/refcount/uninstall) + parse.
- [ ] B3. `externalInstall.ts` (NEW): the PTY runner — spawn argv directly in a visible terminal, OS auth, lifecycle states (D6 started|exited|canceled|timed-out|detected-present|still-missing), never capture the password.
- [ ] B4. Tests: resolver fail-closed; lock parse; assisted-install lifecycle (mocked spawn) incl. cancel/hang/nonzero-but-present.

## Lane C — engine + consent + UI
- [ ] C1. `consentViewModel.ts`: `ConsentExternalTool` (present/missing + exact argv) + `requiresExternalInstallAck` (D-OQ7 strongest copy).
- [ ] C2. `engine.ts`: preview surfaces external reqs (present/missing); install records the consented req in the lock; doctor reports.
- [ ] C3. The assisted-install action wired (PluginsPanel) — visible terminal, OS auth; decline non-terminal (D-OQ6).
- [ ] C4. Tests: consent shape; engine records req; unknown-platform → manual guidance, no crash.

## Close
- [ ] D1. Codex dueto on the built diff (technical review, no scope cuts) → fold.
- [ ] D2. Status → shipped + Closure; commit + push. Then the transcribe plugin consumes 284+285.
