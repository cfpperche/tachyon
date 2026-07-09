# Runtime capability parity (living document)

**Status:** living · **Owner:** Tachyon maintainers · **Last verified:** 2026-07-09  
**Seams (code of record):** `src/resume/adapters.ts`, `src/runtime/runtimeProfile.ts`, `src/agents/AgentManager.ts` (`withRuntimeBridge`), `src/harness/HarnessManager.ts`, `src/activity/*Normalizer.ts`, `src/attention/patterns.ts`, `src/config/loadConfig.ts` (`INSTRUCTION_ARG`)

This document is the **source of truth** for how Tachyon treats AI CLIs as first-class runtimes.  
It is **not** a board task and is **not** a shippable SDD spec — it is continuous product/engine documentation.

Historical seed: board task `t-4891dd` (meta-tracker) — **superseded** by this file.

---

## 1. Principle

**Parity means equal *capabilities* inside Tachyon, not identical CLI protocols.**

| We optimize for | We do **not** optimize for |
|-----------------|----------------------------|
| Same product outcomes (spawn, resume, Bridge, stop, activity, …) | Byte-identical flags, paths, or transcript formats |
| Each runtime’s **native** mechanisms | Workarounds that bypass the CLI (manual HTTP MCP, one-off patches, “ask Claude to reload for me” as the permanent path) |
| Adapters that map native surface → Tachyon ports | Forking or reselling agent runtimes |

**Rule of thumb:** if the CLI already has a flag, config home, hook, or MCP shape for the job, Tachyon should use that. If it doesn’t, either the runtime cannot be first-class on that dimension yet, or Tachyon must stay honest with `parcial` / `✗` until the CLI grows.

**Consequence for agents:** when implementing runtime work, update **this file in the same PR** as `adapters` / `runtimeProfile` / Bridge / activity / attention changes. Open a board task only for a **concrete gap** you are about to implement — never for “owning the matrix.”

---

## 2. Capability dimensions

What “first-class” means in Tachyon (ordered for reading, not strict priority):

| # | Capability | What “✓” means |
|---|------------|----------------|
| 1 | **Brief / instructions** | Spawn can deliver a role/task brief via the runtime’s native instruction channel (`INSTRUCTION_ARG` or typed pane with known semantics). |
| 2 | **Bridge MCP** | Every Tachyon-spawned agent reaches the workspace Bridge without committing secrets; injection on spawn/restart/resume/fork. |
| 3 | **Attention** | Monitor classifies idle/working/needs-input/throttle using **runtime-appropriate** pane (and optional log) patterns — not only a generic default. |
| 4 | **Resume** | Adapter can rebuild the CLI command to continue a prior conversation (`resumeCommand` / mint id). |
| 5 | **Fork** | Adapter can branch a new session from an existing one without destroying the source (`forkCommand`). |
| 6 | **Harness / private home** | Optional isolated config/auth/state home so multi-agent and gated worktrees don’t share ambient credentials/transcripts unsafely. |
| 7 | **Graceful stop** | Documented key/sequence per runtime that requests a clean exit before kill-session (profile-driven). |
| 8 | **Activity ingest** | Durable Activity view from the runtime’s native transcript/event store (normalizer + reader). |
| 9 | **Permission policy** | Spawn/harness can set the runtime’s native permission/auto-approve posture for delegated work. |
| 10 | **Label / profile** | `runtimeProfile` entry: label, isolation mechanism, measured notes (UI + governance). |
| 11 | **Restart** | Kill + respawn with same definition; Bridge re-injected (lifecycle path, all managed agents). |

**Host-only policies** (e.g. `run_host_action` allowlists) are **product governance**, not runtime capability. They are noted under [§5](#5-host-governance-not-runtime-parity) so they are not confused with “Grok can’t do X.”

---

## 3. Matrix (active runtimes)

Legend:

| Mark | Meaning |
|------|---------|
| **✓** | Native runtime mechanism + Tachyon path wired; dogfooded or unit-covered at last verification |
| **~** | Partial: mechanism exists, wiring incomplete or weaker than peers |
| **✗** | Not first-class yet (gap is intentional backlog, not a secret) |
| **—** | Not applicable / not pursued |

### 3.1 Summary table

| Capability | Claude | Codex | OpenCode | Grok |
|------------|:------:|:-----:|:--------:|:----:|
| 1 Brief | ✓ | ✓ | ✓ | ~ |
| 2 Bridge MCP | ✓ | ✓ | ✓ | ✓ |
| 3 Attention | ✓ | ✓ | ✓ | ✗ |
| 4 Resume | ✓ | ✓ | ✓ | ✓ |
| 5 Fork | ✓ | ✗ | ✓ | ✓ |
| 6 Harness | ✓ | ✓ | ✓ | ✓ |
| 7 Graceful stop | ✓ | ✓ | ✓ | ✓ |
| 8 Activity | ✓ | ✓ | ✓ | ✗ |
| 9 Permission inject | ✓ | ~ | ✓ | ~ |
| 10 Label / profile | ✓ | ✓ | ✓ | ✓ |
| 11 Restart | ✓ | ✓ | ✓ | ✓ |

*Secondary / thin adapters (resume-only or incomplete profile): Gemini, Antigravity, Qwen, Continue — see [§3.3](#33-secondary-runtimes).*

### 3.2 Per-runtime: native mechanism → Tachyon seam

#### Claude (reference)

| Cap | Native mechanism | Tachyon seam | Verified |
|-----|------------------|--------------|----------|
| Brief | system/role composition + prompt delivery | `composeInstructions` + spawn brief paths | ongoing |
| Bridge | `--mcp-config` (+ harness `--strict-mcp-config`) | `withRuntimeBridge` → `materializeBridgeMcp` | ongoing |
| Attention | TUI/API pane patterns | `attention/patterns.ts` (claude rate-limit etc.) | ongoing |
| Resume | `--resume <id>`; named session `-n` | `resume/adapters.ts` claude | ongoing |
| Fork | `--resume <id> --fork-session` | `forkCommand` | measured (spec 225 era) |
| Harness | `CLAUDE_CONFIG_DIR` + MCP file | `HarnessManager` | specs 226+ |
| Stop | C-c / C-d sequences | `runtimeProfile` + `stopGracefully` | ongoing |
| Activity | `~/.claude/projects/.../*.jsonl` | `claudeNormalizer` | specs 238–240 era |
| Permission | `--permission-mode` | profile + spawn flags | measured |
| Profile | full | `runtimeProfile.claude` | ongoing |

#### Codex

| Cap | Native mechanism | Tachyon seam | Verified |
|-----|------------------|--------------|----------|
| Brief | CLI arg / prompt composition | `INSTRUCTION_ARG` + briefs | ongoing |
| Bridge | `-c mcp_servers.tachyon_bridge={…}` or harness `config.toml` | `codexBridgeCmd` / harness fold | ongoing |
| Attention | Codex TUI / usage strings | `patterns.ts` (codex) | ongoing |
| Resume | `codex resume <id>` | `resumeCommand` afterBinary | ongoing |
| Fork | — (no adapter `forkCommand`) | ✗ | 2026-07-09 code read |
| Harness | `CODEX_HOME` + `config.toml` | harness home-config | specs 298/357 era |
| Stop | interrupt + EOF path | `runtimeProfile` + stop | ongoing |
| Activity | rollout / session files | `codexNormalizer` | specs 305+ |
| Permission | flags / config | ~ partial vs Claude | ongoing |
| Profile | full | `runtimeProfile.codex` | ongoing |

#### OpenCode

| Cap | Native mechanism | Tachyon seam | Verified |
|-----|------------------|--------------|----------|
| Brief | `--prompt` (TUI prefill) | `INSTRUCTION_ARG` | 2026-07-07/08 (docs/runtimes/opencode.md) |
| Bridge | `OPENCODE_CONFIG` + `opencode.json` MCP | `materializeBridgeMcpOpencode` | 2026-07-08+ |
| Attention | empirical API/error strings | `patterns.ts` (opencode) | 2026-07-08 |
| Resume | `-s <sessionId>` | adapter | pre-existing + dogfood |
| Fork | `-s <id> --fork` | `forkCommand` | adapter present 2026-07-09 |
| Harness | XDG_CONFIG/DATA/STATE | `HarnessManager` opencode XDG | t-e2ebe3 |
| Stop | C-d (measured) | profile | t-bae032 era |
| Activity | OpenCode storage | `opencodeNormalizer` + reader | t-0b2f30 |
| Permission | config `permission` block | harness / delegated permission | t-fb19bd era |
| Profile | full (incl. GLM label) | `runtimeProfile.opencode` | ongoing |

Detail dump: [`docs/runtimes/opencode.md`](./opencode.md).

#### Grok

| Cap | Native mechanism | Tachyon seam | Verified |
|-----|------------------|--------------|----------|
| Brief | positional prompt / pane paste | contract brief + `sendKeys`/paste; `INSTRUCTION_ARG` weaker than Claude/OpenCode | ~ 2026-07-09 |
| Bridge | `GROK_HOME` + `[mcp_servers.tachyon_bridge]` (`headers` + `${VAR}`) | non-harness: `materializeBridgeMcpGrok`; harness: `buildGrokHarnessConfig` | **2026-07-09 dogfood** (t-843576) — `grok mcp list` shows server; native Grok tools after stop/resume |
| Attention | generic only | no grok-specific patterns | ✗ |
| Resume | `-r` / `-c` | adapter `resumeCommand` | **2026-07-09** live stop/resume |
| Fork | `-r <id> --fork-session` | `forkCommand` | adapter 2026-07-09 |
| Harness | `GROK_HOME` + hooks dir | harness + lifecycle hooks materialization | t-4891dd / cxGrokHooks era |
| Stop | C-c, C-c (measured) | `runtimeProfile.grok` | t-bae032 |
| Activity | `sessions/.../chat_history.jsonl` (+ sqlite) | **no** `grokNormalizer` | ✗ |
| Permission | `--permission-mode`, `--always-approve` (Claude-shaped, measured) | profile notes; inject on spawn still follow-up | ~ |
| Profile | label + isolation + stop | `runtimeProfile.grok` | 2026-07-08+ |

**Grok Bridge note (important):** Tachyon injects a **private** `GROK_HOME` (e.g. `.tachyon/bridge-mcp/<agent>.grok`) so multi-agent tokens never require mutating the user’s real `~/.grok/config.toml`. That is still the runtime’s native config surface — just a redirected home.

### 3.3 Secondary runtimes

| Runtime | Resume | Bridge | Harness | Activity | Notes |
|---------|:------:|:------:|:-------:|:--------:|-------|
| Gemini | ✓ adapter | — | — | — | Legacy-thin; not first-class |
| Antigravity | ✓ (`--conversation` / `--continue`) | — | — | — | Thin |
| Qwen | ✓ (`--continue` style) | — | — | — | Thin |
| Continue | thin | — | — | — | Thin |

Promoting a secondary runtime means walking the dimensions in §2 with **native** measurements, then filling the summary table — not bolting Claude-shaped lies into the adapter.

---

## 4. How to update this document

1. **When:** any PR that changes adapters, runtime profiles, Bridge injection, harness materialization, activity normalizers, or attention patterns for a runtime.  
2. **What:** update the cell mark, the “native mechanism → seam” row, and `Last verified` (and CLI version if you measured one).  
3. **How to mark ✓:** either (a) unit/integration coverage that pins the wiring, or (b) a dated dogfood note (task journal / this file’s verification line) with observable proof (`grok mcp list`, resume works, etc.).  
4. **Gaps:** open a **normal** board task (`inbox` → implement) linked from the cell or a short “Open gaps” list below — do **not** re-open a permanent matrix task.  
5. **Disputes:** code wins over stale prose; fix the doc in the same PR that fixes the bug.

### Open gaps (as of 2026-07-09)

Prefer one task per gap when prioritized:

| Gap | Suggested focus |
|-----|-----------------|
| Grok Activity | `grokNormalizer` + session path under `GROK_HOME/sessions` |
| Grok Attention | measure TUI strings; extend `patterns.ts` / rate-limit typing |
| Grok permission inject | apply `--permission-mode` / profile at spawn for delegated agents |
| Codex fork | only if Codex CLI gains a stable native fork; then `forkCommand` |
| Grok brief | strengthen `INSTRUCTION_ARG` / spawn brief path if pane-only proves weak |
| Release hygiene | versioned VSIX that includes Bridge Grok path (avoid patching installed `dist` by hand) |

---

## 5. Host governance (not runtime parity)

Examples that look like “runtime gaps” but are **Tachyon policy**:

- `run_host_action` / `reloadWindow` allowlist (`allowedAgents`, currently Claude-centric in the pinned external policy).
- Publish gates, plugin consent, Bridge auth modes.

Document those in host-action / security docs; mention here only to avoid mis-scoring a runtime as ✗.

---

## 6. Related reading

| Doc | Role |
|-----|------|
| [`docs/system-design.md`](../system-design.md) | Engine vs shell; Bridge as control surface |
| [`docs/runtimes/opencode.md`](./opencode.md) | Deep OpenCode measurement report |
| `src/runtime/runtimeProfile.ts` | Machine-readable profile fragments |
| `src/resume/adapters.ts` | Resume/fork/harness descriptors |

---

## 7. Changelog (doc only)

| Date | Change |
|------|--------|
| 2026-07-09 | Initial living matrix; supersedes board task `t-4891dd`. Grok Bridge non-harness marked ✓ after t-843576 dogfood + stop/resume native MCP tools. |
