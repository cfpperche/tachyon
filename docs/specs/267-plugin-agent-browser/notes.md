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

## Decisions & deviations (build-time)

_(fill during dogfood + codex dueto)_
