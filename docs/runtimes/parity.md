# Runtime capability parity (living document)

**Status:** living · **Owner:** Tachyon maintainers · **Last verified:** 2026-07-12 (t-9874be Grok Activity)  
**Seams (code of record):** `src/resume/adapters.ts`, `src/runtime/runtimeProfile.ts`, `src/agents/AgentManager.ts` (`withRuntimeBridge`, `effectiveCmd`), `src/harness/HarnessManager.ts`, `src/activity/*Normalizer.ts`, `src/attention/patterns.ts`, `src/config/loadConfig.ts` (`INSTRUCTION_ARG`)

This document is the **source of truth** for how Tachyon treats AI CLIs as first-class runtimes.  
It is **not** a board task and is **not** a shippable SDD spec — it is continuous product/engine documentation.

Historical seed: board task `t-4891dd` (meta-tracker) — **superseded** by this file.  
Adversarial reviews (folded in): `.tachyon/reviews/parity-doc-claude.md`, `.tachyon/reviews/parity-doc-codex.md` (2026-07-09).

---

## 1. Principle

**Parity means equal *capabilities* inside Tachyon, not identical CLI protocols.**

| We optimize for | We do **not** optimize for |
|-----------------|----------------------------|
| Same product outcomes (spawn, resume, Bridge, stop, activity, …) | Byte-identical flags, paths, or transcript formats |
| Each runtime’s **native** mechanisms | Workarounds that bypass the CLI (manual HTTP MCP, one-off patches, “ask Claude to reload for me” as the permanent path) |
| Adapters that map native surface → Tachyon ports | Forking or reselling agent runtimes |

**Rule of thumb:** if the CLI already has a flag, config home, hook, or MCP shape for the job, Tachyon should use that. If it doesn’t, either the runtime cannot be first-class on that dimension yet, or Tachyon must stay honest with **`~` / `✗`** until the wiring or the CLI grows.

**Consequence for agents:** when implementing runtime work, update **this file in the same PR** as `adapters` / `runtimeProfile` / Bridge / activity / attention changes. Open a board task only for a **concrete gap** you are about to implement — never for “owning the matrix.”

**Code wins over prose.** If a cell cannot be justified from the seams above, demote the mark; do not invent a path.

---

## 2. Capability dimensions

What “first-class” means in Tachyon (ordered for reading, not strict priority):

| # | Capability | What “✓” means |
|---|------------|----------------|
| 1 | **Brief / instructions** | On **fresh spawn/restart**, the role/task brief is delivered via the runtime’s native channel listed in `INSTRUCTION_ARG` (or an equally automatic pane path). Metadata-only storage does **not** count. |
| 2 | **Bridge MCP** | Every Tachyon-spawned agent reaches the workspace Bridge without committing secrets; injection on spawn/restart/resume/fork (harness: folded into private config; non-harness: `withRuntimeBridge`). |
| 3 | **Attention** | Monitor classifies idle/working/needs-input/throttle from the pane. Shared global patterns apply to all runtimes; **extra** credit when the runtime has composer-region and/or rate-limit **identity** in `runtimeProfile` / `RateLimitRuntime`. |
| 4 | **Resume** | Adapter can rebuild the CLI command to continue a prior conversation (`resumeCommand` / mint id). |
| 5 | **Fork** | Adapter can branch a new session from an existing one without destroying the source (`forkCommand`). **UI may hide fork for harness agents** (see §3.4). |
| 6 | **Harness / private home** | Materialized private config/auth/state home so multi-agent work does not share ambient credentials unsafely. Distinct from `runtimeProfile.isolation` (governance gate) — both should be stated when they diverge. |
| 7 | **Graceful stop** | Profile-driven key/sequence for clean exit before kill-session. Prefer `runtimeProfile.*.gracefulStop.verified === true` for `✓`; `source: "declared"` without measurement is at most `~`. |
| 8 | **Activity ingest** | Durable Activity view from the runtime’s native transcript/event store (**named normalizer** + reader). |
| 9 | **Permission inject** | Spawn/harness **actually sets** the runtime’s native permission/auto-approve posture (a measured profile with **zero readers** is `✗`, not `~`). |
| 10 | **Label / profile** | `runtimeProfile` entry with enough for UI/governance: at least isolation + stop; `label` when present. “Full” means the sections peers use (composer, permission, model aliases) — not a marketing adjective. |
| 11 | **Restart** | Kill + respawn with same definition; Bridge re-injected. |

Also real, uneven seams (not full matrix rows yet — see open gaps): **session-id strategy** (mint vs capture), **deterministic `transcriptPath`** (Claude-only), **session-ownership hooks** (Claude `--settings`), **model-label normalization** (Claude/Codex).

**Host-only policies** (e.g. `run_host_action` allowlists) are **product governance**, not runtime capability — [§5](#5-host-governance-not-runtime-parity).

---

## 3. Matrix (active runtimes)

Legend:

| Mark | Meaning |
|------|---------|
| **✓** | Native runtime mechanism + Tachyon path wired; justified by a **dated** dogfood or a **named** unit/integration test path |
| **~** | Partial: mechanism or wiring incomplete, weaker than peers, or declared-but-unmeasured |
| **✗** | Not first-class yet (honest backlog) |
| **—** | Not applicable / not pursued |

Avoid the word `ongoing` as a verification token — use a date, CLI version, test file, or task id.

### 3.1 Summary table

| Capability | Claude | Codex | OpenCode | Grok |
|------------|:------:|:-----:|:--------:|:----:|
| 1 Brief | ✓ | ✓ | ✓ | ✓ |
| 2 Bridge MCP | ✓ | ✓ | ✓ | ✓ |
| 3 Attention | ✓ | ✓ | ~ | ~ |
| 4 Resume | ✓ | ✓ | ✓ | ✓ |
| 5 Fork | ✓ | ✗ | ✓ | ✓ |
| 6 Harness | ✓ | ✓ | ✓ | ✓* |
| 7 Graceful stop | ~ | ~ | ✓ | ✓ |
| 8 Activity | ✓ | ✓ | ✓ | ✗ |
| 9 Permission inject | ~ | ~ | ~ | **✗** |
| 10 Label / profile | ✓ | ✓ | ~ | ✓ |
| 11 Restart | ✓ | ✓ | ✓ | ✓ |

\* **Grok harness materialization exists** (`GROK_HOME`, hooks, Bridge fold), but `runtimeProfile.grok.isolation` is still **`project-scoped`** for governance. Non-harness **parented** Grok spawns still require an isolated worktree (`assertVerifiedTranscriptIsolation`). See Grok section + §3.4.

*Secondary adapters: [§3.3](#33-secondary-runtimes).*

### 3.2 Per-runtime: native mechanism → Tachyon seam

#### Claude (reference)

| Cap | Native mechanism | Tachyon seam | Verified |
|-----|------------------|--------------|----------|
| Brief | CLI arg = prompt (positional) | `INSTRUCTION_ARG.claude` + `composeCommand` / `effectiveCmd` | code `loadConfig.ts` |
| Bridge | `--mcp-config` (+ harness `--strict-mcp-config`) | `withRuntimeBridge` → `materializeBridgeMcp` | code + dogfood ongoing |
| Attention | TUI pane + rate-limit strings | shared patterns + `RateLimitRuntime` + **composer** profile | code `patterns.ts` / `runtimeProfile.claude` |
| Resume | `--resume <id>`; named session `-n` | `resume/adapters.ts` claude (`mintsId` / `nameMint`) | code |
| Fork | `--resume <id> --fork-session` | `forkCommand` | measured (spec 225 era); UI hides for harness |
| Harness | `CLAUDE_CONFIG_DIR` + MCP file | `HarnessManager` | specs 226+ |
| Stop | C-c / C-d sequences | `runtimeProfile.claude.gracefulStop` | `source: declared`, **verified: false** → mark `~` |
| Activity | `~/.claude/projects/.../*.jsonl` | `claudeNormalizer` (+ ownership hooks on shared cwd) | specs 238–240 era |
| Permission inject | `--permission-mode` | **not** from profile; `--permission-mode auto` only on ownership-settings / claude path | code `AgentManager` settings inject |
| Profile | isolation, composer, stop, model helpers | `runtimeProfile.claude` | code |

#### Codex

| Cap | Native mechanism | Tachyon seam | Verified |
|-----|------------------|--------------|----------|
| Brief | CLI arg | `INSTRUCTION_ARG.codex` + `composeCommand` | code |
| Bridge | `-c mcp_servers.tachyon_bridge={…}` or harness `config.toml` | `codexBridgeCmd` / harness fold | code |
| Attention | Codex TUI / usage strings | shared patterns + `RateLimitRuntime` + **composer** profile | code |
| Resume | `codex resume <id>` | `resumeCommand` afterBinary (capture id) | code |
| Fork | — | no `forkCommand` | 2026-07-09 code read |
| Harness | `CODEX_HOME` + `config.toml` | harness home-config | specs 298/357 era |
| Stop | interrupt + EOF path | `runtimeProfile.codex.gracefulStop` | `source: declared`, **verified: false** → mark `~` |
| Activity | rollout / session files | `codexNormalizer` | specs 305+ |
| Permission inject | flags / config | partial vs Claude; not a full profile-driven inject | code |
| Profile | isolation, composer, stop, model helpers | `runtimeProfile.codex` | code |

#### OpenCode

| Cap | Native mechanism | Tachyon seam | Verified |
|-----|------------------|--------------|----------|
| Brief | `--prompt` (TUI prefill) | `INSTRUCTION_ARG.opencode` | 2026-07-07/08 (`docs/runtimes/opencode.md`) |
| Bridge | `OPENCODE_CONFIG` + `opencode.json` MCP | `materializeBridgeMcpOpencode` | 2026-07-08+ |
| Attention | empirical API/error strings | shared patterns + `RateLimitRuntime`; **no composer** profile | 2026-07-08; mark `~` vs Claude/Codex |
| Resume | `-s <sessionId>` | adapter (capture id) | pre-existing + dogfood |
| Fork | `-s <id> --fork` | `forkCommand` | adapter present 2026-07-09 |
| Harness | XDG_CONFIG/DATA/STATE | `HarnessManager` opencode XDG | t-e2ebe3 |
| Stop | C-d | profile `measured` / verified | t-bae032 era |
| Activity | OpenCode storage | `opencodeNormalizer` + reader | t-0b2f30 |
| Permission inject | config `permission` block | **non-harness delegated** path only (`applyDelegatedOpencodePermission`); harness generation site is dead code | t-fb19bd era → mark `~` |
| Profile | isolation + stop only | `runtimeProfile.opencode` — **no `label`**, no GLM alias fields | 2026-07-09 review → mark `~` |

Detail dump: [`docs/runtimes/opencode.md`](./opencode.md) (narrative may still say “GLM” for product; machine profile does not yet).

#### Grok

| Cap | Native mechanism | Tachyon seam | Verified |
|-----|------------------|--------------|----------|
| Brief | positional `[PROMPT]` after options | `INSTRUCTION_ARG.grok = (q) => q` via `composeCommand` / `effectiveCmd` (after `injectResumeId` → `grok -s <uuid> '<brief>'`) | **✓** 2026-07-09 unit `config.test.ts` + code (was ✗ until Cap 1 fix) |
| Bridge | `GROK_HOME` + `[mcp_servers.tachyon_bridge]` (`headers` + `${VAR}`) | non-harness: `materializeBridgeMcpGrok`; harness: `buildGrokHarnessConfig` | **✓** 2026-07-09 dogfood (t-843576) — `grok mcp list`; native tools after stop/resume |
| Attention | same global pane patterns as peers | no composer profile; not in `RateLimitRuntime` | **~** (not “unclassified”) |
| Resume | `-r` / `-c` | adapter `resumeCommand` (`mintsId`) | **✓** 2026-07-09 live stop/resume |
| Fork | `-r <id> --fork-session` | `forkCommand` | adapter 2026-07-09 |
| Harness | `GROK_HOME` + hooks dir | harness + lifecycle hooks + Bridge fold **exist**; auth seed + **rematerialize** (below) | **✓** materialization; auth rematerialize **✓** t-2b0a08 unit |
| Stop | C-c, C-c | `runtimeProfile.grok` measured | t-bae032 / 2026-07-08 |
| Activity | `sessions/<encodeURIComponent(cwd)>/<id>/chat_history.jsonl` | `grokNormalizer` + `transcriptPath` + file-tail in `ActivityLogWriter` (sessionId from parent dir) | **✓** 2026-07-12 unit `grokNormalizer.test.ts` + `logWriter` Grok rotation (t-9874be) |
| Permission inject | `--permission-mode`, `--always-approve` (measured on CLI) | profile **records** modes/flags; **nothing applies them** at spawn (`alwaysApproveFlag` has zero readers) | **✗** |
| Profile | `label: "Grok"` + isolation + stop | `runtimeProfile.grok` — isolation still **`project-scoped`** (stale note: “private config-home wiring is not declared here yet”) | label ✓; isolation field lag |

**Grok Bridge note:** private `GROK_HOME` (e.g. `.tachyon/bridge-mcp/<agent>.grok`) is the runtime’s native config surface with a redirected home — not a bypass.  
**Grok isolation note:** Bridge/harness materialization ≠ `runtimeProfile.isolation: private-home`. Governance still treats Grok as project-scoped unless `isolatedWorktree` / `def.harness`.  
**Grok auth / rematerialize (t-2b0a08, 2026-07-09):** private home must keep `auth.json` as a **symlink** to the real `~/.grok/auth.json`. Interactive login under redirected `GROK_HOME` can replace that symlink with a **regular file** (fresh tokens only in the private home). On every reload/rebind, `materializeBridgeMcpGrok` used to `unlink` then re-symlink to the **stale** real auth → re-login wall. Fix: **`promoteNewerPrivateAuth`** — if private `auth.json` is a regular file newer than the real target, copy it to real (mode 600) **before** unlink/relink. Canonical truth remains `~/.grok/auth.json`. **✓** unit `test/unit/harness.test.ts` (t-2b0a08).  
**Parity lesson:** measuring only “symlink exists on first materialize” / “Bridge MCP tools list” is **not** enough for harness auth. A first-class private home also requires **auth survives rematerialize after in-home login** (or an explicit `~` with a task).

### 3.3 Secondary runtimes

| Runtime | Brief | Resume | Bridge | Harness | Activity | Notes |
|---------|:-----:|:------:|:------:|:-------:|:--------:|-------|
| Gemini | ✓ (`-i`) | ✓ adapter | — | — | — | Thin overall |
| Antigravity | ✓ (`--prompt-interactive`) | ✓ (`--conversation` / `--continue`) | — | — | — | Thin overall |
| Qwen | — | ✓ (`--continue` style) | — | — | — | Thin |
| Continue | — | ✓ (`--resume <id>`) | — | — | — | Thin (not “no resume”) |

Promoting a secondary runtime means walking §2 with **native** measurements, then filling the summary table.

### 3.4 Harness vs non-harness (same runtime, different cells)

These diverge; the summary table alone cannot show them:

| Seam | Non-harness | Harness (`def.harness`) |
|------|-------------|-------------------------|
| Bridge | `withRuntimeBridge` injects CLI/env | **early-return** — MCP folded into materialized private config |
| Fork (UI) | shown when `forkCommand` exists | **hidden** (`!def?.harness && forkable(...)`) |
| Isolation assert | parented agents need verified isolation / worktree | assert **skipped** when harness |
| OpenCode permission | delegated non-harness path can write permission block | harness generation site currently **dead code** |

---

## 4. How to update this document

1. **When:** any PR that changes adapters, runtime profiles, Bridge injection, harness materialization, activity normalizers, or attention patterns for a runtime.  
2. **What:** update the summary mark, the per-runtime seam row, and a **concrete** verification token (date · CLI version · test path · task id). Bump the doc header `Last verified` when the matrix substance changes.  
3. **How to mark ✓:** (a) unit/integration coverage that pins the wiring, **or** (b) dated dogfood with observable proof. If neither exists, use `~` or `✗`.  
4. **Gaps:** open a **normal** board task when prioritized — never a permanent matrix owner task.  
5. **Disputes:** code wins; fix the doc in the same change set when possible.

### Open gaps (as of 2026-07-12, post t-9874be)

| Gap | Focus |
|-----|--------|
| ~~Grok Activity~~ | **Closed t-9874be** — `grokNormalizer` + `GROK_HOME/sessions/.../chat_history.jsonl` file-tail |
| Grok permission inject | consumers for measured profile / `--permission-mode` at spawn |
| Grok isolation profile | align `runtimeProfile.grok.isolation` with private-home materialization **or** document the worktree gate forever |
| OpenCode profile completeness | `label` / model aliases if UI needs them; permission inject on harness path |
| Claude/Codex stop measurement | promote gracefulStop from declared → measured |
| Codex fork | only if Codex CLI gains stable native fork |
| ~~Grok auth rematerialize~~ | **Closed t-2b0a08** — promote private regular `auth.json` before re-symlink; see Grok auth note above |
| Release hygiene | versioned VSIX that includes Bridge Grok path (no hand-patch of installed `dist`) |

---

## 5. Host governance (not runtime parity)

Examples that look like “runtime gaps” but are **Tachyon policy**:

- `run_host_action` / `reloadWindow` enablement (pinned external policy; agent grant is `*` = any Bridge-resolved agent principal — not a runtime-name allowlist).
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
| `.tachyon/reviews/parity-doc-claude.md` | 2026-07-09 adversarial review |
| `.tachyon/reviews/parity-doc-codex.md` | 2026-07-09 adversarial review |

---

## 7. Changelog (doc only)

| Date | Change |
|------|--------|
| 2026-07-09 | Initial living matrix; supersedes board task `t-4891dd`. Grok Bridge non-harness marked ✓ after t-843576 dogfood. |
| 2026-07-09 | Fold Claude + Codex adversarial reviews: Grok Brief → ✗; Grok Permission inject → ✗; OpenCode profile/permission → ~; Attention wording + Grok Attention → ~; Claude/Codex stop → ~ until measured; harness/non-harness axis §3.4; secondary brief inversion (Gemini/Antigravity); open gaps refreshed. |
| 2026-07-09 | **Cap 1 Grok closed:** `INSTRUCTION_ARG.grok = (q) => q` + unit test; matrix Brief Grok → ✓. |
