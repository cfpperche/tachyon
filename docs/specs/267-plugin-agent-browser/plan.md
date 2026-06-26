# 267 — plan

## Shape

The plugin payload lives in the external plugins repo (alongside `secrets-guard` / `sdd` / `hello-marker`), NOT
in Tachyon. It reuses the shipped engine end-to-end — no Tachyon engine change is required (confirmed: a skill
references the provisioned binary through the **stable repo-root launcher path** `.tachyon/bin/_tachyon-tool
<plugin> <tool> …`, the same launcher `secrets-guard`'s git-hook uses via `${tool:}` — so "skill → tool" needs no
new mechanism).

```
agent-browser/
  tachyon-plugin.json        # manifest: tools.agent-browser (7 platforms) + runtimes [claude, codex]
  skills/agent-browser/
    SKILL.md                 # thin, runtime-neutral: invocation, doctor, session naming, auth, confirmation policy
    scripts/doctor.sh        # `… --version` + non-destructive Chrome-detection probe → BROWSER_RUNTIME_MISSING
```

## Manifest — the tool declaration

`tools.agent-browser` mirrors `secrets-guard`'s `gitleaks`:
- `version: 0.31.0`, `versionCommand` for detect-first.
- `platforms`: the spec-265 keys → the GitHub release asset URLs + **author-pinned `sha256`** computed by
  downloading each asset once (no upstream checksum file). Bare binaries (no archive), so `binSha256 == sha256`.
  Keys: `linux-x64-glibc`/`linux-x64-musl`/`linux-arm64-glibc`/`linux-arm64-musl`/`darwin-x64`/`darwin-arm64`.
  (Map upstream `linux-x64` → glibc, `linux-musl-x64` → musl; Windows omitted per non-goals.)
- The binary is the launcher target; every agent call is `.tachyon/bin/_tachyon-tool agent-browser agent-browser …`.

## Skill — thin + version-matched

`skills/agent-browser/SKILL.md` (claude + codex, neutral payload, spec 251). Deliberately small; the full,
version-matched command surface is loaded at runtime via `agent-browser skills get core`. The skill teaches:

1. **Doctor first** — `scripts/doctor.sh` runs `… agent-browser --version` + a non-destructive browser probe;
   on no-Chrome it prints `BROWSER_RUNTIME_MISSING` + the remediation and stops. Never browse before doctor-OK.
2. **The loop** — `open <url>` → `snapshot -i` (accessibility tree + `@eN` refs) → `read`/`screenshot`/`get text`.
   Inspection + extraction only in v1.
3. **Session naming** — always `--session tachyon-<workspace-hash>-<agent-id>` (per-agent isolation, no
   cross-workspace collision). Set a default `AGENT_BROWSER_IDLE_TIMEOUT_MS`; expose an explicit cleanup command.
4. **Auth** — protected reads: human does a headed first-login, state is saved under `.tachyon/browser-state/`
   (gitignored, credential-class, optionally `AGENT_BROWSER_ENCRYPTION_KEY`-encrypted); the agent reuses with
   `--session … --restore` + `--restore-check-url/-text`. Default profile is **isolated agent-browser state**,
   never the human's real Chrome `--profile`. On expiry → surface a re-login signal, never silent-retry.
5. **Confirmation policy (v1 read-first)** — free: navigate/read/screenshot on ordinary pages. Requires explicit
   human OK: submit/any write-click, extract-from-authenticated-page, sensitive domain. v2 owns form-driving.
6. **Consent-aligned framing** — the skill restates the capability's reach so the agent self-limits.

## Build order

1. **Pin the assets.** Download the 7 v0.31.0 release binaries, compute sha256, record per-platform `{url,sha256}`.
2. **Manifest + doctor skill**, minimal, installable.
3. **Local dogfood** in a clean `/home/goat/tachyon`: install via the Plugins View → provisioned binary runs via
   the launcher → doctor passes (Chrome present) → open+snapshot a public page → screenshot.
4. **Auth dogfood**: human headed-login to one host → state under `.tachyon/browser-state/` → agent reads the
   protected page headlessly with `--restore`; prove the credential file is gitignored and the LLM path never
   carries the secret.
5. **Codex dueto** on the manifest + skill (the proven loop), fold.
6. **Tag the plugins repo** (a new semver tag) so the spec-266 detection can later offer it; install into the
   Tachyon dev dogfood.

## Reuse / consistency

- Exactly the `secrets-guard` provisioning + launcher path — no new engine surface (validates the engine again).
- spec-266 update detection comes for free once tag-pinned.
- Hygiene: the plugin + this spec name **no** originating harness; generic "a browser-automation plugin".

## Risks / fail-closed

- **No Chrome → loud stop** (doctor), never a half-working browse.
- **Credential-class state** under `.tachyon/browser-state/` gitignored; default isolated profile (never the
  human's real Chrome); env-indirected encryption key (never a committed value).
- **Exfiltration boundary** — the agent sees rendered private text/screenshots, not just passwords → the
  confirmation policy + skill framing constrain authenticated extraction + sensitive domains.
- **Orphaned daemons/Chromes** — idle-timeout + explicit cleanup in v1; agent-kill wiring deferred.
- **Consent louder than gitleaks** — browser control + network + auth-replay + credential-files spelled out.

## Test / proof plan

v1 is a plugin (no Tachyon unit tests). Proof = the local dogfood transcript: provision → doctor → public
read/snapshot/screenshot → auth-gated read via restored state → per-agent session isolation → write-action
confirmation prompt fired. Captured in `notes.md`.

## v2 preview (form-driving — the next slice, designed but not built here)

First-class clicks/fills/uploads that mutate state, with: dry-run/read-only defaults, mandatory write-confirmation
(promoted from prose to a clearer mechanism if warranted), staging-URL preference, and a recorded action log. v2
also is the natural moment to add the `agent-browser mcp` typed surface (v1.1) if dogfood demands it.
