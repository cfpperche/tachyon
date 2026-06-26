# 267 — notes

## Why a plugin (not a wrapper), and why now

The plugin engine now spans tools (265) + skills (251) + update detection (266). A browser capability is the
first plugin that proves the engine delivers **product value** beyond a commit gate: the same provisioning +
launcher machinery that gates a commit with `gitleaks` can give every agent eyes + hands on the web. It reuses
the engine end-to-end with **zero engine change** — the skill→tool link is just the stable repo-root launcher
path `.tachyon/bin/_tachyon-tool <plugin> <tool>` (the same launcher `secrets-guard` uses via `${tool:}`).

## Upstream research (agent-browser v0.31.0, 2026-06-25)

- Native Rust CLI; single per-platform prebuilt binary on GitHub releases: `agent-browser-{darwin-arm64,
  darwin-x64,linux-arm64,linux-x64,linux-musl-arm64,linux-musl-x64,win32-x64.exe}` → maps onto the spec-265
  platform matrix (musl included). No published sha256 → the plugin author pins them.
- Client–daemon: `--session <name>` → isolated daemon + Chrome per session (parallel-safe); IPC sockets
  auto-managed, no fixed port; `AGENT_BROWSER_IDLE_TIMEOUT_MS` auto-closes idle daemons.
- Needs Chrome (Chrome-for-Testing via `agent-browser install`, or host auto-detect of Chrome/Brave/Playwright/
  Puppeteer) — the binary is NOT self-contained.
- Native auth: `state save/load`, `--session --restore` (+ `--restore-check-url/-text/-fn`), `--profile`,
  encrypted **auth-vault** (`auth save`/`auth login`, "the LLM never sees passwords"), `AGENT_BROWSER_ENCRYPTION_KEY`
  (AES-256-GCM at rest), `--cdp`/`--auto-connect`.
- Two surfaces: the plain CLI (open/`snapshot -i` with `@eN` refs/click/fill/screenshot/…) and `agent-browser
  mcp` (typed MCP server, profiles core/network/state/debug/tabs/react/mobile/all).
- Skill pattern: a SKILL.md that loads runtime content via `agent-browser skills get core` to stay version-matched.

## Codex design discussion (2026-06-26) — consensus folded into the spec

Verdicts: (1) ship tool+skill in v1, **MCP deferred to v1.1**; (2) **don't** provision Chrome via 265 — host
Chrome + a loud `doctor`/`BROWSER_RUNTIME_MISSING`; (3) native state/vault, **no Tachyon login-broker** in v1;
(4) `--session tachyon-<workspace-hash>-<agent-id>` + idle-timeout + explicit cleanup, agent-kill wiring deferred;
(5) thin skill that defers to `skills get core`; (6) consent **louder than gitleaks**.

Codex risk additions folded into the spec/plan: LLM exfiltration boundary (the agent sees rendered private
text/screenshots, not just passwords) → confirmation policy + sensitive-domain limits; **profile contamination**
(default must be isolated state, never the human's real Chrome `--profile`); MCP "installed-but-unapproved" UX
(spec 254 doesn't auto-enable runtime approval) → keep MCP out of v1; CI lacks browser deps → v1 is local/dev;
encryption-key via env-indirection only (mirror spec-254 env rule); Windows excluded (spec-265 v1) despite the
upstream `win32-x64.exe`.

## Decisions ratified by the maintainer (2026-06-26)

- **v1 = read-first** (inspection + auth-gated extraction; form-driving confirmation-gated).
- **v2 = form-driving**, attacked immediately after v1.
- **Auth state lives in `.tachyon/browser-state/`** (per-workspace, gitignored, credential-class).
- **Confirmation policy = conservative** (my recommendation ratified): explicit human OK before submit/write,
  authenticated-page extraction, or sensitive domains; plain reads are free.

## Sources

- vercel-labs/agent-browser (GitHub README + skills/agent-browser/SKILL.md), agent-browser.dev, npm `agent-browser`.
- GitHub release v0.31.0 asset list (via `gh api`, 7 per-platform binaries).

## Build + dogfood (2026-06-26)

Plugin authored in the external plugins repo (`agent-browser/`): manifest (`tools.agent-browser`, 6 bare
per-platform pins — sha256 computed from the v0.31.0 GH-release assets, sizes cross-checked) + thin claude/codex
skill + `scripts/doctor.sh`. `loadPlugin` + `gatherToolPlan` validate clean (tool resolves to `linux-x64-glibc`,
bare → `binSha256 == sha256`). One fix: the SKILL.md frontmatter `description` can't contain a `: ` (YAML reads
it as a nested map) — rephrased `read-first:` → `read-first —`.

**Local dogfood into `/home/goat/tachyon` (engine install, both runtimes), live-proven:**
- **Provision** — binary installed content-addressed at `.tachyon/bin/agent-browser/<sha256>/agent-browser`;
  skill materialized into `.claude/skills/agent-browser/` + `.agents/skills/agent-browser/`; lockfile records
  `agent-browser 1.0.0`, runtimes `[claude, codex]`, tools `[agent-browser]`.
- **Doctor** — `agent-browser OK — binary: agent-browser 0.31.0; a usable Chrome was detected.` (exit 0).
- **Read loop through the launcher** (`.tachyon/bin/_tachyon-tool agent-browser agent-browser …`): `open
  example.com` → ✓; `snapshot -i` → `heading "Example Domain" [ref=e1]`, `link "Learn more" [ref=e2]`; `get
  title` → `Example Domain`; `close` → ✓. The full open→snapshot→extract primitive works end-to-end.

**Notable: a tool used only by a skill (no `${tool:}` git-hook ref) provisions fine** — provisioning is by
declaration, not by an argv reference, so the launcher-path invocation pattern works without an engine change.
This is the reusable pattern for the future `vuln-audit`/`unused-code` plugins too.

Not dogfooded headlessly (by nature): scenario 2's no-Chrome `BROWSER_RUNTIME_MISSING` branch (Chrome is present
here — covered by construction; the shell branch emits the exact string + remediation) and scenario 4's
auth-gated read (needs a human first-login). Per-agent `--session` isolation and the write-confirmation policy
are exercised by the skill contract.

## Codex dueto (2026-06-26) — SHIP-WITH-CHANGES, all folded

No BLOCK; manifest cleared (bare `{url,sha256}` valid, glibc/musl mapping correct). 6 SHOULD + 1 NITPICK, all
folded into the plugin:
1. `AB skills get core` is NOT available for the provisioned bare binary (ships only via npm; codex hit "Skills
   directory not found") → replaced all references with `AB --help` / `AB <command> --help` + `AB doctor`.
2. `sh scripts/doctor.sh` doesn't exist from the workspace root → gave the explicit per-runtime paths
   (`.claude/skills/…` / `.agents/skills/…`) + noted `AB doctor` works directly.
3. **Session stability bug** — `${TACHYON_AGENT_ID:-$$}`: `$$` differs per shell call, so `open` and `snapshot`
   (separate Tachyon processes) would hit different sessions. Rewrote to "pick ONE fixed session string for the
   whole task and reuse it verbatim".
4. doctor was presence-detection, not usability → **rewrote `doctor.sh` to delegate to the CLI's own
   `agent-browser doctor`** (real Chrome detection + a headless launch test; re-verified: 10 pass, launch in
   ~0.28s), mapping a Chrome/launch failure to `BROWSER_RUNTIME_MISSING`.
5. Headed-login example wasn't headed + used the default session → added `--headed`, a dedicated `login-<host>`
   session, `mkdir -p`.
6. "gitignored" was asserted, not verified → added `mkdir -p … && chmod 700` + a `git check-ignore` assertion
   before any state save.
7. (nit) "confirmation-gated" overstated enforcement → softened to "skill-gated (the agent must ask first)" in the
   manifest description.

Re-validated after the fold: `loadPlugin` clean; the new `doctor.sh` passes (delegates to `agent-browser doctor`).

## Release + tag-pin (2026-06-26)

Tagged the plugins repo **`v0.7.0`** (annotated, "agent-browser 1.0.0") and pushed `main` + the tag to
`origin` (push is fine for the Tachyon ecosystem — only Marketplace publish is gated). Re-sourced the dogfood
from the git tag `github:cfpperche/tachyon-plugins@v0.7.0#path=agent-browser` (was a local-dir install): loads
at commit `b45ff4b`, installs with git provenance, and `resolveEffectiveUpdateSpec` now governs it (returns the
same spec — up-to-date at the highest tag; a future `v0.8.0` carrying a newer agent-browser would surface as an
update via spec 266). Acceptance scenario "auto-detects a newer upstream release" is now met (detection active).

## Decisions & deviations (build-time)

- Bare binaries → no `archive` block; `binSha256`/`exeName` derived (`toolPlan.ts:72-73`).
- Windows (`win32-x64.exe`) omitted (spec-265 v1). `versionCommand`/detect-first omitted in v1 (always provision
  the verified copy — simpler/safer; detect-first is opt-in to add later).
- The CLI's built-in `agent-browser doctor` (env + Chrome + headless launch test) is far better than a hand-rolled
  probe — the plugin's doctor.sh is a thin wrapper that adds launcher discovery + the `BROWSER_RUNTIME_MISSING`
  Tachyon-convention signal.
- `agent-browser --help` (not `skills get core`) is the version-matched reference for the standalone binary.
