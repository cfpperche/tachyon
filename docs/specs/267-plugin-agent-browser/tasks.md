# 267 — tasks

**Verify:** _(plugin payload lives in the external plugins repo; proof is the dogfood transcript in notes.md, not a Tachyon test command)_

## Implementation (v1 — read-first)

- [ ] 1. **Pin the upstream binaries.** Download the 7 `agent-browser` v0.31.0 GitHub release assets, compute
  `sha256` each, record per spec-265 platform keys (`linux-x64-glibc`←`linux-x64`, `linux-x64-musl`←`linux-musl-x64`,
  arm64 ×2, `darwin-x64`, `darwin-arm64`; Windows omitted). Bare binaries → `binSha256 == sha256`.
- [ ] 2. **Author the plugin manifest** (external repo): `tools.agent-browser` with the pinned platforms +
  `versionCommand` (detect-first) + `runtimes [claude, codex]`.
- [ ] 3. **Doctor script** `scripts/doctor.sh` — `… agent-browser --version` + a non-destructive Chrome-detection
  probe → `BROWSER_RUNTIME_MISSING` + remediation on absence; success is silent.
- [ ] 4. **Thin skill** `skills/agent-browser/SKILL.md` (claude+codex): launcher invocation, doctor-first, the
  open→snapshot→act read loop, `--session tachyon-<workspace-hash>-<agent-id>` + idle-timeout + cleanup, the auth
  workflow (human headed-login → `.tachyon/browser-state/` → `--restore` validated), the v1 confirmation policy,
  and a deferral to `agent-browser skills get core` for the full surface.
- [ ] 5. **Local dogfood — core loop.** Install via the Plugins View into a clean `/home/goat/tachyon`; run the
  binary through the launcher; doctor passes; open + `snapshot -i` + screenshot a public page.
- [ ] 6. **Local dogfood — auth-gated read.** Human headed first-login to one host; state saved under
  `.tachyon/browser-state/`; agent reads the protected page headlessly via `--session … --restore`; prove the
  state file is gitignored + the LLM path never carries the credential; expiry surfaces a re-login signal.
- [ ] 7. **Per-agent isolation + write-confirmation checks.** Two concurrent sessions don't cross-talk; a
  state-mutating action prompts for confirmation under the v1 read-first policy.
- [ ] 8. **Codex dueto** on manifest + skill + doctor (the proven loop); fold findings.
- [ ] 9. **Tag the plugins repo** (new semver tag) so spec-266 detection can offer it; install into the Tachyon
  dev dogfood. Resolve OQ1–OQ6 (record answers in notes.md).

## Verification

- [ ] Binary provisions per-platform, installs content-addressed, runs only via the plugin-scoped launcher (scenario 1)
- [ ] No-Chrome → `BROWSER_RUNTIME_MISSING` + remediation; never a silent half-browse (scenario 2)
- [ ] Public page: open → snapshot(`@eN`) → screenshot/extract, identical on claude + codex (scenario 3)
- [ ] Auth-gated read via restored credential-class state; LLM never sees the credential; expiry → re-login signal (scenario 4)
- [ ] Per-agent `--session` isolation; idle self-close + explicit cleanup (scenario 5)
- [ ] Write/auth-extract/sensitive-domain actions are confirmation-gated in v1; plain reads are not (scenario 6)
- [ ] Consent copy names browser/network/auth-replay/credential-file risk (scenario 7)
- [ ] Tag-pinned → spec-266 surfaces a newer upstream release as an update (scenario 8)

## v2 (form-driving — next spec, not this one)

- [ ] First-class clicks/fills/uploads with dry-run defaults, write-confirmation, staging-URL preference, action log
- [ ] (v1.1) `agent-browser mcp` typed surface via the spec-254 MCP capability, command routed through the launcher
