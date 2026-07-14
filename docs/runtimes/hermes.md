# Hermes Agent — runtime gap inventory (Tachyon)

**Status:** secondary (wired) · **not** fully active · **Owner:** maintainers  
**CLI measured:** Hermes Agent **v0.18.2** (2026.7.7.2), install method `git`, home `~/.hermes`  
**Measured on:** 2026-07-13 (WSL/Linux, Codex OAuth path `openai-codex` + `gpt-5.6-sol` / `reasoning_effort: ultra`)  
**Seams of record:** `docs/runtimes/parity.md` §2, `src/resume/adapters.ts`, `src/runtime/runtimeProfile.ts`, `src/config/loadConfig.ts`, `src/harness/HarnessManager.ts`, `src/agents/AgentManager.ts` (`withRuntimeBridge`)

This document is the **honest gap inventory + promotion log** for Hermes Agent as a Tachyon runtime.  
Code wins over this prose when they diverge.

---

## 1. Veredito

| Layer | Status |
|-------|--------|
| **Hermes CLI standalone** | Strong: sessions, resume/continue, MCP (HTTP + `${VAR}` headers), `HERMES_HOME`, worktree flag, oneshot brief (`-z` / `chat -q`), yolo, SQLite activity store |
| **Tachyon product discovery** | Present: quick-add chip, logo, `KNOWN_AI_CLIS`, `runtimeUsage` label |
| **Tachyon secondary runtime (2026-07-13)** | **Wired:** `ResumeRuntime: hermes`, resume adapter, `HERMES_TUI_QUERY` brief, Bridge via private `HERMES_HOME` + `config.yaml` `mcp_servers`, harness shape, `runtimeProfile.hermes` |
| **Still open** | Activity normalizer (`state.db` file-tail is not JSONL), gracefulStop measurement, `--yolo` spawn inject **reader**, live Bridge dogfood |

**Rule of thumb for implementers:** prefer native flags/env (`HERMES_HOME`, `config.yaml` MCP, `--resume` / `-c`, `HERMES_TUI_QUERY`) over inventing bypasses.

**Authoritative product path today:** install CLI → configure provider → spawn `cmd: hermes`. Secondary seams (Bridge private home, resume, brief env) apply when the Tachyon build includes this branch. Activity view still does not ingest Hermes turns.

---

## 2. What Tachyon knows (surface + secondary seams)

| Surface | Location | Notes |
|---------|----------|--------|
| Quick-add chip | `src/webview/formLogic.ts` (`bin: "hermes"`) | Always visible; install hint = official curl installer |
| Known AI CLI | `src/config/loadConfig.ts` `KNOWN_AI_CLIS` | Kind inference / attention defaults as generic agent |
| Display label | `src/runtimeUsage/model.ts` | `"Hermes Agent"` |
| Studio logo | `src/webview/agent-studio-shell/runtimeLogos.tsx` | Present |
| Resume adapter | `src/resume/adapters.ts` | **✓** `hermes` capture + harness shape |
| Instruction / brief | `INSTRUCTION_ARG` + `AgentManager.hermesBriefEnv` | **✓** env `HERMES_TUI_QUERY` |
| Bridge inject | `withRuntimeBridge` + `materializeBridgeMcpHermes` | **✓** `HERMES_HOME` private home |
| Harness | `HarnessManager` + adapter harness | **✓** seed auth + `config.yaml` |
| Activity | `src/activity/*Normalizer.ts` | **✗** still no hermes normalizer |
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
| 1 | **Brief / instructions** | **✓** TUI `HERMES_TUI_QUERY` / oneshot `-z` | **✓** `INSTRUCTION_ARG` + `composeCommand` leaves argv bare; `AgentManager.hermesBriefEnv` sets `HERMES_TUI_QUERY` | Unit: `config.test.ts`. Live dogfood still recommended |
| 2 | **Bridge MCP** | **✓** `mcp_servers` + `${VAR}` headers | **✓** `materializeBridgeMcpHermes` → private `HERMES_HOME` + `config.yaml` fold | Unit: `harness.test.ts` |
| 3 | **Attention** | **~** pane TUI | **~** shared patterns + assumed composer | Measure later |
| 4 | **Resume** | **✓** `--resume` / `-c` | **✓** adapter + `resolveHermesId` (`state.db`) | Unit: `resume.test.ts` |
| 5 | **Fork** | **✗** | **✗** | Wait for native CLI |
| 6 | **Harness / private home** | **✓** `HERMES_HOME` | **✓** adapter harness + seed auth/config | Same materialize path as peers |
| 7 | **Graceful stop** | **~** Ctrl+C ×2 | **~** declared profile, unverified | Measure in pane |
| 8 | **Activity ingest** | **✓** `state.db` | **✗** no normalizer | Next slice |
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

### 4.2 Model / auth (this workspace dogfood)

Configured 2026-07-13 for maintainer onboarding:

```yaml
# ~/.hermes/config.yaml (excerpt)
model:
  provider: openai-codex
  default: gpt-5.6-sol
  base_url: https://chatgpt.com/backend-api/codex
agent:
  reasoning_effort: ultra   # gpt-5.6 wire maps ultra → max on Codex transport
```

- Codex tokens: imported from `~/.codex/auth.json` into Hermes auth store (Hermes prefers its own copy; refresh conflicts with Codex CLI are a known OAuth hazard).
- Smoke: `hermes chat -Q -q '…' --provider openai-codex -m gpt-5.6-sol --max-turns 1` → session `20260713_185208_da5df2`, reply verified.

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

### 4.5 Activity data model (for a future normalizer)

From `state.db` (measured columns, abbreviated):

- `sessions`: `id`, `model`, `cwd`, `started_at`, `message_count`, `tool_call_count`, token/cost fields, `title`, …
- `messages`: `session_id`, `role`, `content`, `tool_calls`, `tool_name`, `reasoning*`, `timestamp`, …

This is **better structured** than many JSONL transcripts; Activity should prefer SQLite read with file-watch/polling, not TUI scrape.

### 4.6 Isolation / multi-agent

- **Declared simple** `cmd: hermes` without harness → shared `~/.hermes` (config, auth, state.db) across all Hermes panes — **same class of footgun as ungated OpenCode**.
- **Native mitigation:** `HERMES_HOME=<private>` per agent (mirrors `GROK_HOME` / `CODEX_HOME`).
- Hermes also has `--worktree` for its own git worktree isolation — orthogonal to Tachyon Delivery worktrees; do not conflate.

### 4.7 Permissions

| Flag / mode | Effect |
|-------------|--------|
| `--yolo` | Bypass dangerous command approval |
| `--safe-mode` | Disable customizations (troubleshoot) |
| `hermes tools` / toolsets | Per-platform tool enablement |

No Tachyon spawn path sets these yet.

---

## 5. Recommended promotion path (ordered)

Do **not** open a permanent “own Hermes matrix” task. Ship thin vertical slices; update this file + `parity.md` in the same PR.

| Phase | Deliverable | Exit criteria | Matrix impact |
|-------|-------------|----------------|---------------|
| **P0 — Discoverability honesty** | This inventory + secondary row in `parity.md` | Doc linked from parity §3.3 | Secondary listed, seams `—` |
| **P1 — Brief** | `INSTRUCTION_ARG.hermes` + unit | Spawn with instructions → oneshot or prefilled query observed | Secondary Brief ✓ |
| **P2 — Resume adapter** | `ResumeRuntime: "hermes"`, `RUNTIME_BY_BIN.hermes`, `resumeCommand` + capture id | Stop → Resume continues same session id | Secondary Resume ✓ |
| **P3 — Bridge** | `materializeBridgeMcpHermes` via `HERMES_HOME` + `config.yaml` mcp_servers fold; `withRuntimeBridge` branch | Agent lists Bridge tools / can `complete_node` or equivalent | Secondary Bridge ✓; path to active Cap 2 |
| **P4 — Harness** | Adapter `harness` + HarnessManager seed auth + Bridge fold | Parallel hermes agents do not share `state.db`/auth | Secondary Harness ✓ |
| **P5 — Activity** | `hermesNormalizer` + state.db reader | Activity view shows turns for hermes agent | Cap 8 path |
| **P6 — Profile / stop / permission** | `runtimeProfile.hermes`, measured gracefulStop, optional yolo inject with **actual reader** | Marks move from ✗/~ with verification tokens | Active table candidate |

**Promotion to active summary table (§3.1):** only after P1–P3 dogfooded and at least Brief + Bridge + Resume are ✓ with dates/tests. Harness + Activity can lag as `~`/`✗` like Grok historically did.

**Non-goals for v1:**

- Fork (no native API).
- Messaging gateway (Telegram/etc.) as Tachyon seams.
- Replacing Codex/Claude coordinators with Hermes.
- Claiming isolation without `HERMES_HOME` or worktree governance.

---

## 6. Hazards / gotchas

1. **Shared home default** — two `hermes` agents without `HERMES_HOME` share sessions DB and OAuth; Coordination bugs will look like “wrong session resumed”.
2. **Codex OAuth dual-client** — Hermes and Codex CLI both using ChatGPT OAuth can fight over refresh tokens; Hermes docs recommend separate login; import is convenience, not multi-client safety.
3. **Session id is not UUID** — mint adapters and UUID-only resolvers will break; use capture + string ids.
4. **Brief channel choice** — `-z` is oneshot (exits after answer); interactive TUI may need a different prefill if one exists; measure before locking `INSTRUCTION_ARG`.
5. **TUI vs classic** — `hermes` vs `hermes --tui` vs `hermes chat`; Tachyon `cmd` must pick one stable surface for attention/stop measurement.
6. **Auth under private home** — redirecting `HERMES_HOME` without seeding `auth.json` / provider config yields “looks spawned, cannot infer”. Follow Grok promote/symlink lessons (`parity.md` Grok auth note).
7. **PyYAML rewrite** — tooling that dumps whole `config.yaml` can strip comments; Bridge materializer should surgically merge `mcp_servers.tachyon_bridge` (ruamel or structured edit).

---

## 7. Minimal Tachyon usage today (no parity)

```yaml
# tachyon.yml
agents:
  hermes:
    cmd: hermes
    # instructions: ignored until INSTRUCTION_ARG.hermes exists
```

User must have:

1. `hermes` on PATH  
2. Provider configured (`hermes model` / auth)  
3. No expectation of Bridge, resume UI, or Activity  

Manual Bridge (user-owned, not product path):

```yaml
# under HERMES_HOME or ~/.hermes/config.yaml
mcp_servers:
  tachyon_bridge:
    url: "http://127.0.0.1:<bridge-port>/mcp"
    headers:
      Authorization: "Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}"
```

…and export `TACHYON_AGENT_BRIDGE_TOKEN` in the pane env (Tachyon does this for wired runtimes only).

---

## 8. Open questions (resolve during P1–P3)

| Q | Options | Bias |
|---|---------|------|
| Brief for interactive declared agents | `-z` oneshot only vs TUI prefill vs paste via `write_input` | Prefer native prefill if exists; else document oneshot for contracts and empty TUI for human agents |
| Capture session id | Parse banner / `sessions list` / poll `state.db` by cwd | Prefer `state.db` newest for cwd (deterministic) |
| Private home layout | `.tachyon/bridge-mcp/<agent>.hermes/` vs `.tachyon/harness/<agent>/` | Mirror Grok bridge-mcp for non-harness Bridge; harness dir for `def.harness` |
| Codex auth seed | Symlink `auth.json` vs copy | Measure refresh behavior; Grok taught “symlink + promote newer private file” |

---

## 9. Related

| Doc / code | Role |
|------------|------|
| [`parity.md`](./parity.md) | Living capability matrix |
| [`opencode.md`](./opencode.md) | Example of full promotion report (target shape after dogfood) |
| `src/resume/adapters.ts` | Where hermes adapter lands |
| `src/harness/HarnessManager.ts` | Grok/Claude/OpenCode Bridge materializers to mirror |
| Official Hermes docs | <https://hermes-agent.nousresearch.com/docs/> |

---

## 10. Changelog (this inventory)

| Date | Change |
|------|--------|
| 2026-07-13 | Initial inventory from install + Codex OAuth smoke + code/docs seam read. Hermes **not** first-class; native CLI strong; Tachyon wiring absent. |
| 2026-07-13 | Secondary promotion on branch `feat/hermes-runtime-parity`: Brief env, Resume, Bridge `HERMES_HOME`, harness, profile. Activity residual. |
