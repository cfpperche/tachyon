# Hermes Agent — runtime integration status (Tachyon)

**Status:** secondary integrated runtime · **not yet promoted to the active summary** · **Owner:** maintainers
**CLI measured:** Hermes Agent **v0.18.2** (2026.7.7.2), install method `git`, home `~/.hermes`  
**Last verified:** 2026-07-16 (WSL/Linux; code + focused unit tests; Bridge exercised live)
**Seams of record:** `docs/runtimes/parity.md` §2, `src/resume/adapters.ts`, `src/runtime/runtimeProfile.ts`, `src/config/loadConfig.ts`, `src/harness/HarnessManager.ts`, `src/agents/AgentManager.ts` (`withRuntimeBridge`)

This document is the **current contract, honest gap inventory and promotion log** for Hermes Agent as a Tachyon runtime.
Code wins over this prose when they diverge.

---

## 1. Veredito

| Layer | Status |
|-------|--------|
| **Hermes CLI standalone** | Strong: sessions, resume/continue, MCP (HTTP + `${VAR}` headers), `HERMES_HOME`, worktree flag, oneshot brief (`-z` / `chat -q`), yolo, SQLite activity store |
| **Tachyon product discovery** | Present: quick-add chip, logo, `KNOWN_AI_CLIS`, `runtimeUsage` label |
| **Tachyon secondary runtime** | **Wired:** startup brief with forced TUI, Bridge/private `HERMES_HOME`, isolated harness, resume/live session follow, SQLite Activity, model provenance and `runtimeProfile.hermes` |
| **Still open** | composer/attention measurement, verified graceful stop, `--yolo` spawn reader, fork (native gap), token/cost usage projection, native profile/SOUL lifecycle and visual Activity dogfood |

**Rule of thumb for implementers:** prefer native flags/env (`HERMES_HOME`, `config.yaml` MCP, `--resume` / `-c`, `HERMES_TUI_QUERY` + `HERMES_TUI=1`) over inventing bypasses. Fail closed when a declared capability has no materializer.

**Authoritative product path today:** install CLI → configure a provider → spawn `cmd: hermes`. Tachyon creates a private operational home when Bridge/harness wiring is available, delivers the startup brief through the modern TUI and ingests the selected session from `state.db`.

---

## 2. What Tachyon knows (surface + secondary seams)

| Surface | Location | Notes |
|---------|----------|--------|
| Quick-add chip | `src/webview/formLogic.ts` (`bin: "hermes"`) | Always visible; install hint = official curl installer |
| Known AI CLI | `src/config/loadConfig.ts` `KNOWN_AI_CLIS` | Kind inference / attention defaults as generic agent |
| Display label | `src/runtimeUsage/model.ts` | `"Hermes Agent"` |
| Studio logo | `src/webview/agent-studio-shell/runtimeLogos.tsx` | Present |
| Resume adapter | `src/resume/adapters.ts` | **✓** `hermes` capture + harness shape |
| Instruction / brief | `INSTRUCTION_ARG` + `AgentManager.hermesBriefEnv` | **✓** `HERMES_TUI_QUERY` + `HERMES_TUI=1`; explicit `--cli` rejected when a brief exists |
| Bridge inject | `withRuntimeBridge` + `materializeBridgeMcpHermes` | **✓** `HERMES_HOME` private home |
| Harness | `HarnessManager` + adapter harness | **✓** private config/state; declared MCP/skills; optional auth; hooks rejected until supported |
| Activity | `hermesNormalizer` + `HermesStorageReader` | **✓** SQLite poll, live session follow, source timestamps, observed model and bounded cold backfill |
| Runtime profile | `runtimeProfile.ts` | **✓** `RUNTIME_PROFILES.hermes` |

---

## 3. Capability matrix — native CLI vs Tachyon

Legend (same spirit as `parity.md`):

| Mark | Meaning |
|------|---------|
| **✓** | Mechanism exists and is usable as measured |
| **~** | Partial / needs design choice or more measurement |
| **✗** | Missing on that side |
| **—** | N/A |

| # | Capability | Hermes native | Tachyon wiring | Gap / proposed seam |
|---|------------|:-------------:|:--------------:|---------------------|
| 1 | **Brief / instructions** | **✓** TUI `HERMES_TUI_QUERY` / oneshot `-z` | **✓** sets query + `HERMES_TUI=1`; refuses explicit classic `--cli` instead of dropping the brief | `agentManager.test.ts` (2026-07-16) |
| 2 | **Bridge MCP** | **✓** `mcp_servers` + `${VAR}` headers | **✓** `materializeBridgeMcpHermes` → private `HERMES_HOME` + `config.yaml` fold | Unit: `harness.test.ts` |
| 3 | **Attention** | **~** pane TUI | **~** shared patterns + assumed composer | Measure later |
| 4 | **Resume** | **✓** `--resume` / `-c` | **✓** adapter + activity-based `resolveHermesId`; live Activity re-resolves after in-TUI `/resume` | `resume.test.ts`, `agentManager.test.ts` |
| 5 | **Fork** | **✗** | **✗** | Wait for native CLI |
| 6 | **Harness / private home** | **✓** `HERMES_HOME` | **✓** private config/state, isolated MCP set and optional OAuth auth symlink; `hooks` rejected | `harness.test.ts`, `config.test.ts` |
| 7 | **Graceful stop** | **~** Ctrl+C ×2 | **~** declared profile, unverified | Measure in pane |
| 8 | **Activity ingest** | **✓** `state.db` | **✓** reader + normalizer; source timestamp/model; newest 4,000-message cold backfill | `hermesNormalizer.test.ts`, `hermesStorageReader.test.ts` |
| 9 | **Permission inject** | **✓** `--yolo` | **~** profile records flag; **no spawn reader** | Follow-up |
| 10 | **Label / profile** | N/A | **✓** `runtimeProfile.hermes` | Unit: `runtimeProfile.test.ts` |
| 11 | **Restart** | **✓** | **✓** Bridge re-inject + brief env | Same as spawn path |

\* Cap numbers match `parity.md` §2.

---

## 4. Native mechanism detail (measured)

### 4.1 Install / layout

| Path | Role |
|------|------|
| `~/.local/bin/hermes` | Launcher |
| `~/.hermes/hermes-agent/` | Code + venv |
| `~/.hermes/config.yaml` | Non-secret settings (model, tools, mcp_servers, agent.reasoning_effort, …) |
| `~/.hermes/.env` | Secrets template / keys |
| `~/.hermes/auth.json` | OAuth stores (Codex, Nous, …) — created on login |
| `~/.hermes/state.db` | Canonical sessions + messages |
| `~/.hermes/skills/` | Bundled + user skills |
| `HERMES_HOME` | Full home redirect (profiles / multi-agent isolation candidate) |

### 4.2 Model / auth

Tachyon does not choose a Hermes provider or model. Private-home materialization preserves the user's
model/provider settings while adding only Tachyon-owned runtime wiring.

- `auth.json` is optional: OAuth users get an isolated copy in the private home when it exists; API-key
  users can rely on `.env` or process environment without a false preflight failure.
- A newer valid private OAuth file is promoted before refreshing the copy, so refresh does not silently
  revert and Hermes cannot write through to the canonical real-home credential.
- `harness.inherit: none` removes ambient `mcp_servers` before adding only the declared servers and Bridge;
  model/provider settings remain available.
- Hermes can use the same OAuth provider as another CLI, but independently refreshed token stores can still
  conflict. That is a provider/runtime concern, not something Tachyon should hide by copying stale auth.

### 4.3 Session identity

- **Id format:** timestamp + suffix, e.g. `20260713_185208_da5df2` (not UUID).
- **Strategy for Tachyon:** almost certainly **capture**, not mint (CLI assigns id). No evidence of caller-supplied session id at spawn in the measured help surface.
- **Continue without id:** `-c` / `--continue` resumes most recent (or named) — usable as `resumesWithoutId` fallback like antigravity/qwen.
- **cwd** stored on session row → capture resolvers can filter by workspace.

### 4.4 MCP (Bridge candidate)

Native shape (HTTP):

```yaml
mcp_servers:
  tachyon_bridge:
    url: "http://127.0.0.1:<port>/mcp"
    headers:
      Authorization: "Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}"
    enabled: true
```

`${VAR}` expansion is first-class in Hermes MCP tooling — **do not** write the bearer into disk; inject env at spawn (same contract as Grok/Claude).

### 4.5 Activity data model

From `state.db` (measured columns, abbreviated):

- `sessions`: `id`, `model`, `cwd`, `started_at`, `message_count`, `tool_call_count`, token/cost fields, `title`, …
- `messages`: `session_id`, `role`, `content`, `tool_calls`, `tool_name`, `reasoning*`, `timestamp`, …

This is **better structured** than many JSONL transcripts. Tachyon polls SQLite rather than scraping the
TUI, preserves source timestamps and observed model, follows internal session switches, and bounds a cold
session import to the newest 4,000 active messages.

### 4.6 Isolation / multi-agent

- A Tachyon-managed Hermes agent with Bridge materialization receives a per-agent private operational
  `HERMES_HOME`; harness agents receive their own private harness home.
- A manually launched Hermes process, or a launch outside the supported materialization path, still defaults
  to shared `~/.hermes` and therefore shares config, auth and `state.db`.
- Isolation is fail-closed for declared harness capabilities: user hooks are rejected until a Hermes hook
  adapter exists, and `inherit: none` cannot leak global MCP servers.
- Hermes `--worktree` is its own git isolation feature. It is orthogonal to Tachyon Delivery/worktree
  governance and must not be treated as equivalent evidence.

### 4.7 Permissions

| Flag / mode | Effect |
|-------------|--------|
| `--yolo` | Bypass dangerous command approval |
| `--safe-mode` | Disable customizations (troubleshoot) |
| `hermes tools` / toolsets | Per-platform tool enablement |

No Tachyon spawn path sets these yet.

---

## 5. Promotion status and remaining criteria

The thin vertical slices for discovery, brief, resume, Bridge, harness, Activity and profile metadata are
implemented. Hermes remains in the secondary table because the following dimensions are intentionally not
promoted:

1. measure composer/attention and graceful stop in a real pane;
2. decide and implement permission posture instead of merely recording `--yolo` in a profile;
3. visually dogfood Activity session switching and model provenance;
4. decide whether native Hermes profiles/SOUL and ACP should become managed Tachyon seams;
5. ingest session token/cost totals only if RuntimeOps needs them and provenance remains explicit.

Fork remains `✗` until Hermes exposes a stable native fork mechanism. Promotion must not invent one.

---

## 6. Hazards / gotchas

1. **Shared home outside materialization** — manual/unwired `hermes` processes without `HERMES_HOME` share
   sessions and OAuth. Do not attribute a shared global DB to one agent without an ownership signal.
2. **Codex OAuth dual-client** — Hermes and Codex CLI both using ChatGPT OAuth can fight over refresh tokens; Hermes docs recommend separate login; import is convenience, not multi-client safety.
3. **Session id is not UUID** — mint adapters and UUID-only resolvers will break; use capture + string ids.
4. **TUI is part of the brief contract** — Tachyon forces `HERMES_TUI=1` when delivering a brief and rejects
   explicit `--cli`; do not remove that env as cosmetic launch configuration.
5. **Auth is provider-dependent** — absence of `auth.json` is valid for API-key setups. Presence of a malformed
   OAuth file is still a hard failure because silently linking it would create a misleading private home.
6. **Harness hooks are unsupported** — parser rejection is deliberate. Accepting and dropping hooks is worse
   than a capability marked `✗`.
7. **Generated YAML is not the user's source file** — private config may be reserialized; Tachyon must preserve
   settings and isolation semantics but does not promise comments in generated homes. The real config is not rewritten.

---

## 7. Tachyon usage today

```yaml
# tachyon.yml
agents:
  hermes:
    cmd: hermes
    instructions: Coordinate through the Tachyon Bridge and keep the task journal current.

    # Optional stronger isolation. Global MCP servers are not inherited here.
    harness:
      inherit: none
```

The user must have:

1. `hermes` on PATH
2. A provider configured through Hermes config, OAuth, `.env` or process environment

Tachyon owns Bridge registration, private-home wiring, brief delivery, resume and Activity for managed
sessions. `Connect Agent Runtime` remains for supported manually started runtimes; users should not paste a
Tachyon bearer into Hermes config.

---

## 8. Open work

| Gap | Current position |
|-----|------------------|
| Attention/composer | Shared pane patterns only; measure modern TUI regions and throttling before adding identity-specific heuristics |
| Graceful stop | Declared Ctrl+C sequence remains unverified in a real pane |
| Permission posture | `--yolo` exists natively but no Tachyon spawn/harness reader applies it |
| Usage | Session token/cost columns exist but are not projected into RuntimeOps |
| Identity/profile | Private operational home exists; native Hermes profile/SOUL lifecycle is not Tachyon-owned |
| ACP | Hermes exposes an editor protocol, but Tachyon currently uses CLI + MCP + SQLite |
| Fork | No stable native fork mechanism measured |

---

## 9. Related

| Doc / code | Role |
|------------|------|
| [`parity.md`](./parity.md) | Living capability matrix |
| [`opencode.md`](./opencode.md) | Example of full promotion report (target shape after dogfood) |
| `src/resume/adapters.ts` | Hermes resume/harness descriptor |
| `src/harness/HarnessManager.ts` | Hermes private-home, auth, MCP and skills materialization |
| Official Hermes docs | <https://hermes-agent.nousresearch.com/docs/> |

---

## 10. Changelog (this inventory)

| Date | Change |
|------|--------|
| 2026-07-16 | Contract hardening: startup brief forces TUI and rejects `--cli`; `inherit:none` strips ambient MCPs; missing OAuth auth is valid; unsupported hooks fail closed; session selection follows live message activity; Activity preserves timestamp/model and bounds cold backfill. Engine-first docs aligned. |
| 2026-07-13 | Initial inventory from install + Codex OAuth smoke + code/docs seam read. Hermes **not** first-class; native CLI strong; Tachyon wiring absent. |
| 2026-07-13 | Secondary promotion on branch `feat/hermes-runtime-parity`: Brief env, Resume, Bridge `HERMES_HOME`, harness, profile. Activity residual. |
| 2026-07-13 | Agent Studio Isolated harness form: show for grok/hermes/opencode (was claude/codex-only); loadConfig accepts harness on grok/hermes. |
| 2026-07-14 | Activity Cap 8: `HermesStorageReader` polls `$HERMES_HOME/state.db`; `hermesNormalizer` maps messages → NormalizedEvent; logWriter + transcriptPathOf sessionId. |
