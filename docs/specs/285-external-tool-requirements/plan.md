# 285 — external-tool-requirements — plan

_Drafted from spec.md (D1–D8) on 2026-06-28._

## Approach

A THIRD dependency kind beside provisioned tools (265) and plugin deps (276): a plugin declares external system
binaries it needs (`externalTools`), and the engine DETECTS them (spoof-resistant), shows present/missing at the
install consent preview + doctor, and offers a consent-gated ASSISTED INSTALL that runs the author-declared per-PM
**argv** in a VISIBLE terminal where the OS's own sudo/polkit prompts for the password (Tachyon never touches it).
Looser non-pinned trust tier; never auto-uninstalls.

| Stage | Module | What |
|---|---|---|
| Manifest | `manifest.ts` | `ExternalToolDecl` + `parseExternalTools` (D1 `externalTools`; D2 install argv per PM; D8 `manual`; reject shell strings) |
| Detection | `externalTool.ts` (NEW) | `detectExternalTool` (D4: clean-PATH realpath + ancestry/owner trust + `execFile` detect, timeout, no shell) + PM detection (D3) |
| Guardrails | `externalTool.ts` | `validateInstallArgv` (D3: no control chars, capped, leading `sudo?` then a PM exe matching the declared family at a trusted realpath) |
| Resolver | `externalTool.ts` + `_tachyon-external` shim | `resolveExternalTool` → trusted abs path or fail-closed (D5); shim mirrors `_tachyon-data` |
| Assisted install | `externalInstall.ts` (NEW) | PTY runner spawning argv directly (no `sh -c`) in a visible terminal; lifecycle states (D6); never captures the password |
| Lockfile | `lockfile.ts` | `ExternalToolReq` lock entry (D7: the consented declaration; no pinning/refcount/uninstall) |
| Consent | `consentViewModel.ts` | `ConsentExternalTool` (present/missing + the exact argv) + `requiresExternalInstallAck` (D-OQ7 strongest ack) |
| Engine | `engine.ts` | preview surfaces external reqs; the assisted-install action; doctor; install records the req |

## Key decisions (from the design dueto, D1–D8)

- **argv, never shell** (D2/D3) — the install is a structured argv run argv-directly; the consent renders it shell-quoted for DISPLAY only.
- **Tachyon never handles the password** (hard line) — the visible terminal's `sudo`/polkit owns auth.
- **Spoof-resistant detect** (D4) — clean PATH + realpath + host-path ancestry trust (reuse `isTrustedExecPath`); detect via `execFile`.
- **No auto-uninstall, no pinning** (looser tier) — honest consent copy.

## Files touched
`manifest.ts`, `externalTool.ts` (NEW), `externalInstall.ts` (NEW), `externalToolEntry.ts` (NEW bundle), `esbuild.mjs`, `lockfile.ts`, `consentViewModel.ts`, `engine.ts`, `PluginsPanel.ts` + plugins webview, `test/unit/pluginExternal*.test.ts`.

## Risks
- The PTY runner in a VS Code/tmux terminal needs the sudo prompt reachable + the password never observed/logged — the security crux.
- Detection trust must reuse the proven `toolLauncher` host-path pattern, not a fresh impl.

## Verify
`npx vitest run test/unit && npm run typecheck && npm run build`
