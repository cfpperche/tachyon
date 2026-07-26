# Runtime capability parity (living document)

**Status:** living · **Owner:** Tachyon maintainers · **Last verified:** 2026-07-26 (Claude↔Codex canonical audit — `t-53455d`)
**Seams (code of record):** `src/resume/adapters.ts`, `src/runtime/runtimeProfile.ts`, `src/agents/AgentManager.ts` (`withRuntimeBridge`, `effectiveCmd`), `src/harness/HarnessManager.ts`, `src/config/agentProfileSchema.ts`, `src/config/agentProfileProjection.ts`, `src/activity/*Normalizer.ts`, `src/attention/patterns.ts`, `src/config/loadConfig.ts` (`KNOWN_AI_CLIS`, `inferKind`, `composeCommand`), `src/agents/openingPromptCapability.ts`
`src/runtimeConfig/codexInventory.ts`, `src/config/codexNativeConfigProjection.ts`

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
| 1 | **Brief / instructions** | On **fresh spawn/restart**, the [startup brief](../architecture/startup-briefs.md) is delivered via the runtime’s native channel listed in `INSTRUCTION_ARG` (or an equally automatic pane path). A task contract is an optional layer; metadata-only storage does **not** count. |
| 2 | **Bridge MCP** | Every Tachyon-spawned agent reaches the workspace Bridge without committing secrets; injection on spawn/restart/resume/fork (native MCP harnesses fold it into private config; Pi always uses its immutable additive extension through `withRuntimeBridge`). |
| 3 | **Attention** | Monitor classifies idle/working/needs-input/throttle from the pane. Shared global patterns apply to all runtimes; **extra** credit when the runtime has composer-region and/or rate-limit **identity** in `runtimeProfile` / `RateLimitRuntime`. |
| 4 | **Resume** | Adapter can rebuild the CLI command to continue a prior conversation (`resumeCommand` / mint id). |
| 5 | **Fork** | Adapter can branch a new session from an existing one without destroying the source (`forkCommand`). **UI may hide fork for harness agents** (see §3.4). |
| 6 | **Harness / private home** | Materialized private config/auth/state home so multi-agent work does not share ambient credentials unsafely. Distinct from `runtimeProfile.isolation` (governance gate) — both should be stated when they diverge. |
| 7 | **Graceful stop** | Profile-driven key/sequence for clean exit before kill-session. Prefer `runtimeProfile.*.gracefulStop.verified === true` for `✓`; `source: "declared"` without measurement is at most `~`. |
| 8 | **Activity ingest** | Durable Activity view from the runtime’s native transcript/event store (**named normalizer** + reader). |
| 9 | **Permission inject** | Spawn/harness **actually sets** the runtime’s native permission/auto-approve posture (a measured profile with **zero readers** is `✗`, not `~`). |
| 10 | **Label / profile** | `runtimeProfile` entry with enough for UI/governance: at least isolation + stop; `label` when present. “Full” means the sections peers use (composer, permission, model aliases) — not a marketing adjective. |
| 11 | **Restart** | Kill + respawn with same definition; Bridge re-injected. |
| 12 | **Native configuration parity** | Private-home isolation preserves or intentionally excludes each measured native behavior family through an explicit source/treatment/refresh policy. A private home alone does not count. |
| 13 | **Headless probe (`probe_agent`)** | Runtime has a `HeadlessCaptureAdapter` under `src/probe/adapters/` registered on `ProbeService`, and Bridge `probe_agent` accepts that runtime in schema. Captures a terminal taxonomy result without a durable pane. |
| 14 | **Runtime Config (Control)** | Runtime has a measured Control adapter for its native global/workspace source. It is listed in the Runtime Config selector **only** for the exact operations marked compatible in §3.1.2; detection of a binary alone never qualifies. |

For the Codex marks in rows 7, 9, and 12, **✓** is scoped to canonical profiles: Tachyon regenerates
the authored, allowlisted native policy in a private `CODEX_HOME` before fresh spawn, restart, and
resume. It does not claim to impose that policy on arbitrary legacy `cmd: codex …` definitions.

Also real, uneven seams (not full matrix rows yet — see open gaps): **session-id strategy** (mint vs capture), **deterministic `transcriptPath`**, **session-ownership hooks** (Claude `--settings`), **model-label normalization** (Claude/Codex), **live/observed model provenance** (spec 378 plus the Hermes SQLite reader — claude/codex/grok/hermes can latch an observed model; opencode/gemini/qwen/etc. stay declared-only), and **cross-runtime task continuation** (SDD 443 / `t-7551f9`: host focused handoff + new session on another agent — **not** native resume; edit-`cmd` while live is fail-closed via `t-6d09e6`).

### Soul identity delivery

Soul is a Tachyon-owned optional layer loaded from `.tachyon/agents/<agent>/SOUL.md` only when the
declared agent has `soul: true`. It uses the same opening-prompt adapter registry as startup briefs,
but applies a stricter contract: unsupported delivery fails the launch instead of silently dropping
identity. The product records `offered` channel metadata; it does not claim that a provider consumed
or obeyed the text.

| Runtime | Delivery when `soul: true` | Evidence as of 2026-07-20 |
|---------|-----------------------------|---------------------------|
| Claude | `startup-argument` | **✓** Human Dev Host dogfood, task `t-2278bc` |
| Codex | `startup-argument` | **✓** Human Dev Host dogfood, task `t-2278bc` |
| Grok | `startup-argument` | **✓** Human Dev Host dogfood, task `t-2278bc` |
| OpenCode | `tui-prefill` (`offered`, consumption not guaranteed) | **✓** Human Dev Host dogfood, task `t-2278bc` |
| Gemini | `startup-argument` | **~** Adapter and unit coverage; no Soul-specific human dogfood recorded |
| Antigravity / `agy` | `startup-argument` | **~** Adapter and unit coverage; no Soul-specific human dogfood recorded |
| Pi | `startup-argument` | **~** Adapter is wired after the original MVP; no Soul-specific human dogfood recorded |
| Hermes | Native external `$HERMES_HOME/SOUL.md` | **✗** Tachyon Soul fails closed; no per-agent Hermes profile/home adapter |
| Unknown, renamed binary, arbitrary shell wrapper | None | **✗** Fails closed with a direct-command diagnostic |

Recognized direct commands and `env`/`npx`/`bunx`/`pnpx` launchers are classified syntactically by
basename. This is adapter selection, not binary provenance. Hermes' global/profile-native Soul is
external user state: Tachyon neither composes with it nor overwrites it. A future native Hermes Soul
adapter requires a separately proven per-agent home/profile lifecycle.

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

| Capability | Claude | Codex | OpenCode | Grok | Pi | **Outros** |
|------------|:------:|:-----:|:--------:|:----:|:--:|:----------:|
| 1 Brief | ✓ | ✓ | ✓ | ✓ | ✓ | **✗**¶ |
| 2 Bridge MCP | ✓ | ✓ | ✓ | ✓ | ✓* | **✗**¶ |
| 3 Attention | ✓ | ✓ | ~ | ~ | ✓ | **~**¶ |
| 4 Resume | ✓ | ✓ | ✓ | ✓ | ✓ | **✗** |
| 5 Fork | ✓ | ✗ | ✓ | ✓ | ✓ | **✗** |
| 6 Harness | ✓ | ✓ | ✓ | ✓† | ✓‡ | **✗** / **—** |
| 7 Graceful stop | ✓ | ✓ | ✓ | ✓ | ✓ | **~**¶ |
| 8 Activity | ✓ | ✓ | ✓ | ✓ | ✓ | **✗** |
| 9 Permission inject | ✓ | ✓ | ~ | **✗** | ✓ | **✗** |
| 10 Label / profile | ✓ | ✓ | ~ | ✓ | ~ | **✗**¶ |
| 11 Restart | ✓ | ✓ | ✓ | ✓ | ✓ | **✓**¶ |
| 12 Native config parity | ✓ | ✓ | ~ | ✗ | ~ | **✗** |
| 13 Headless probe | ✓ | ✓ | ✗ | ✓§ | ✗ | **✗** |
| 14 Runtime Config (Control) | ✓¶ | ✓¶ | ✗ | ✗ | ✗ |

\* **Pi Bridge** is projected through a Tachyon-owned native extension because Pi has no MCP client.

† **Grok harness materialization exists** (`GROK_HOME`, hooks, Bridge fold), but `runtimeProfile.grok.isolation` is still **`project-scoped`** for governance. Non-harness **parented** Grok spawns still require an isolated worktree (`assertVerifiedTranscriptIsolation`). See Grok section + §3.4.

‡ **Pi default private home + exact resource harness exist.** SDD 406 snapshots declared workspace-local extensions/skills/prompts/themes/packages into the per-agent home, disables automatic discovery and passes only explicit private CLI paths. Remote package acquisition/global inheritance remain intentionally unsupported.

§ **Grok headless probe** (`t-7426de`, SDD 257): `src/probe/adapters/grok.ts` — `grok -p --output-format json`, golden fixtures + binary-gated `--version` smoke. Live model call remains opt-in (`PROBE_LIVE_SMOKE=1`). OpenCode / Pi / Hermes adapters deferred.

¶ **Outros** is not a runtime brand — it is the honest fallback for commands **outside** first-class + secondary adapter coverage. Marks are justified in [§3.5](#35-outros--unsupported--generic-fallback). Do **not** read **✓** Restart as “first-class runtime”; it only means the host can kill and re-spawn the same declared command.

*Secondary adapters: [§3.3](#33-secondary-runtimes). Unsupported / generic: [§3.5](#35-outros--unsupported--generic-fallback).*

¶ **Runtime Config** provides per-document provenance and CAS. Codex exposes its measured TOML
subset; Claude exposes six safe settings scalars, local-shadow detection, MCP names and opaque
section names without executable payloads. Control writes only the measured subset and marks
affected running agents pending.

The comparative audit in
[`claude-codex-canonical-parity-audit-2026-07-26.md`](../reports/claude-codex-canonical-parity-audit-2026-07-26.md)
created and reopened both canonical profiles in one Dev Host run and mapped
Runtime Config, lifecycle, isolation, external auth, Bridge/capabilities and
fail-closed claims to named regressions. Codex remains honestly `Limited`
because native fork is unavailable; that is a native difference, not a missing
Tachyon projection.

### 3.1.1 Native configuration inheritance

Private-home isolation and behavior parity are independent. The installed Codex rollout proved this:
the agent remained isolated but lost status-line, approval, model/personality and native
hook/extension behavior when the global `config.toml` was suppressed.

The architecture contract is
[`agent-native-config-inheritance.md`](../architecture/agent-native-config-inheritance.md). It separates
agent policy, regenerable runtime projection, mutable runtime state and external authority. Inheritance
means controlled materialization into the private home, never sharing that mutable home.

Current adapter evidence:

| Runtime | Global/account source | Workspace source | Private projection | External authority | Fresh/restart/resume/fork | Mark |
|---|---|---|---|---|---|:---:|
| Claude | canonical policy projects reviewed global scalar families; selected auth/bootstrap remains external | canonical policy projects reviewed workspace scalar families; selected owner-captured skills/hooks/MCP require exact Claude grants; ambient `settings.local.json`, plugin roots and unselected workspace tooling remain excluded | private `CLAUDE_CONFIG_DIR`; generated closed settings, typed `--model`/`--effort` selectors, captured skill tree, strict selected-MCP+Bridge config, and manifest-last provenance | credential symlink plus onboarding markers; auth is not profile-authored | fresh/restart/resume regenerate the same selected generation and remove stale state; fork copies the typed projection into a distinct private home and seeds the exact transcript across home/cwd namespaces (`t-fdd3a0`, `t-088454`, SDD 465/463, 2026-07-26) | ✓ |
| Codex | canonical policy projects reviewed global scalar families; auth stays external | canonical policy projects reviewed workspace scalar families; unselected keys fail closed | private `CODEX_HOME`; atomically regenerated selectors/scalars plus captured profile skills/MCP/hooks and Bridge | OAuth credentials | fresh/restart/resume regenerate an identical private projection before launch (`t-1a3d50`, 2026-07-25); fork is unavailable; native extensions remain explicitly unsupported | ✓ |
| OpenCode | ambient global XDG excluded | `inherit: workspace` snapshots `opencode.json`; `none` starts empty | private XDG config/data/state plus MCP overlay | runtime auth state not fully classified here | spawn/restart/resume wiring exists; per-family refresh evidence incomplete | ~ |
| Grok | ambient config, memory and plugins excluded | harness can snapshot `.grok/config.toml`; canonical non-harness writes Bridge-only config | private `GROK_HOME`, exact workspace/cwd trust store and hooks | auth symlink plus reconciliation | regenerated equivalently on fresh/restart/resume; stale trust removed without losing auth/MCP (`t-15d7e7`) | ✗ |
| Pi | safe global JSON settings seeded once, executable resources removed; canonical profiles exclude ambient `trust.json` | exact declared resource snapshots | private agent/session homes; exact canonical workspace/cwd trust replaces stale grants and denials | private auth snapshot; provider authority remains external | trust regenerates equivalently on fresh/restart/resume while auth/settings/resources remain private (`t-20c856`, audit `t-68ee7a`); fork stays under the single-live-Pi safety limit | ~ |
| Hermes | global non-MCP `config.yaml` is seeded; `inherit: none` still keeps that base | workspace `.hermes/config.yaml` may replace the global base; MCP is overlaid | private `HERMES_HOME`; `state.db` is runtime-owned | OAuth `auth.json` and API-key `.env` are externally linked/reconciled | spawn/resume paths exist; no canonical profile inspector or per-family policy | ✗ |

Required evidence is per family: model/provider/reasoning, approval/sandbox/trust, UI/status/personality,
hooks/MCP/skills/native extensions, feature flags, authentication, memory, caches/notices/telemetry and
resume/fork consistency. Each record names source, projection target, mutable state, credentials,
lifecycle behavior and a dated test/task. Unknown stays unknown.

Runtime-managed memory is tracked by `t-d4c42e`; agent-scoped Tachyon plugins remain separate. Both
must still be visible here when they affect effective runtime behavior.

### 3.1.2 Runtime Config (Control) eligibility

This is distinct from **Native configuration parity** above. That row asks whether a private agent
home preserves configuration behavior at launch. Runtime Config asks whether Control can truthfully
inspect or change a native user/workspace source. A runtime is shown in Control's Runtime Config
selector only when it has a row in this table — an installed executable, an ad-hoc command, or a
runtime in the `Other` parity category is not enough.

| Runtime eligible for selector | Global inventory | Workspace inventory | Measured settings | Individual tooling | Native writes | Pending / next launch | Evidence |
|------------------------------|:----------------:|:-------------------:|:-----------------:|:------------------:|:-------------:|:---------------------:|----------|
| Codex | ✓ `~/.codex/config.toml` | ✓ `.codex/config.toml` | ✓ six scalar keys | ✓ MCP names; measured enable/disable | ✓ measured scalar/MCP subset, CAS + atomic projection | ✓ runtime-scoped | `src/runtimeConfig/codexInventory.ts`; `test/unit/codexRuntimeConfigInventory.test.ts`; comparative audit `t-53455d`; SDD 446 / `t-39cf89` |
| Claude | ✓ `~/.claude/settings.json` | ✓ `.claude/settings.json`, `.claude/settings.local.json` shadow detection, `.mcp.json` | ✓ six scalar keys | ✓ MCP names read-only; hooks/statusLine/MCP bodies opaque | ✓ settings scalar subset, per-document CAS + atomic JSON replace | ✓ runtime-scoped | `src/runtimeConfig/claudeInventory.ts`; `test/unit/claudeRuntimeConfigInventory.test.ts`; Dev Host scenarios `claude-runtime-config.mjs` and `claude-codex-parity-audit.mjs`; SDD 464 / `t-e5cb7c`; audit `t-53455d` |

**Not eligible yet:** Grok, OpenCode, Pi, Hermes and every other detected runtime. Their
native formats and launch effects may exist elsewhere in Tachyon, but Control has no measured
Runtime Config adapter for them. Do not list them as disabled choices: absence communicates the
honest contract, and their eventual addition must update this table and the applicable parity row
in the same change.

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
| Stop | Escape / Ctrl+C / local `/exit` | `runtimeProfile.claude.gracefulStop` | **✓** Claude Code 2.1.220 TTY: authorized active turn stopped by Escape, Ctrl+C, then `/exit`; pane exited status 0 (2026-07-25) |
| Activity | `~/.claude/projects/.../*.jsonl` | `claudeNormalizer` (+ ownership hooks on shared cwd) | specs 238–240 era |
| Permission inject | `--permission-mode`, `settings.json` permissions | canonical private `settings.json` regenerates only an explicitly selected, validated global/workspace permission block; `bypassPermissions` is rejected by the canonical projector; ad-hoc ownership injection remains separate | Claude Code 2.1.220 measurement plus closed projector/lifecycle regressions in `t-fdd3a0` / SDD 465 |
| Native config parity | `settings.json`, `--model`, `--effort` | exact per-family global/workspace scalar projection plus agent-owned selector argv; provider/service tier and unselected keys fail closed | **✓** `t-fdd3a0`; profile/harness/fresh-restart-resume/fork regressions, 2026-07-26 |
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
| Stop | interrupt + EOF path | `runtimeProfile.codex.gracefulStop` | measured and verified; canonical lifecycle reconstruction keeps the same private policy on fresh/restart/resume (`t-60ff74`, 2026-07-25) |
| Activity | rollout / session files | `codexNormalizer` | specs 305+ |
| Permission inject | private `config.toml` policy | canonical profiles regenerate selected `approval_policy` and `sandbox_mode` in private `CODEX_HOME`; arbitrary legacy commands remain unchanged | **✓** `t-60ff74`, strict-config parser + lifecycle regression |
| Native config parity | reviewed selectors, permissions, interface and feature flags | `materializeCanonicalCodexProfileHome` atomically regenerates the allowlisted projection, Bridge, skills/MCP/hooks; ambient config and unsupported extensions are excluded | **✓** `t-60ff74`; fresh/restart/resume exact-projection regression |
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
| Profile | `label: "Grok"` + isolated home + stop | `runtimeProfile.grok`; canonical launches bind both `GROK_HOME` and `HOME` to the private home | private transcript/config namespace ✓; composer/attention remains `~` |
| Headless probe | `grok -p --output-format json` (+ `--json-schema` for archetypes) | `src/probe/adapters/grok.ts` + `ProbeService` + `probe_agent` enum | **✓** t-7426de unit + binary-gated `--version` smoke |

**Grok Bridge note:** private `GROK_HOME` (e.g. `.tachyon/bridge-mcp/<agent>.grok`) is the runtime’s native config surface with a redirected home — not a bypass.  
**Grok isolation note:** Grok 0.2.112 also discovers `$HOME/.claude/settings.json`; canonical launches therefore bind `HOME` to the same private `GROK_HOME`, preventing ambient permission discovery while retaining external `auth.json` by symlink. This makes the canonical transcript/config namespace private-home; legacy/ad-hoc commands retain their declared isolation posture.
**Grok auth / rematerialize (t-2b0a08, 2026-07-09):** private home must keep `auth.json` as a **symlink** to the real `~/.grok/auth.json`. Interactive login under redirected `GROK_HOME` can replace that symlink with a **regular file** (fresh tokens only in the private home). On every reload/rebind, `materializeBridgeMcpGrok` used to `unlink` then re-symlink to the **stale** real auth → re-login wall. Fix: **`promoteNewerPrivateAuth`** — if private `auth.json` is a regular file newer than the real target, copy it to real (mode 600) **before** unlink/relink. Canonical truth remains `~/.grok/auth.json`. **✓** unit `test/unit/harness.test.ts` (t-2b0a08).  
**Grok auth / in-session harvest (t-6c8437, 2026-07-24):** OIDC refresh mid-session leaves a **regular** private `auth.json` while the agent is still running. Harvest used to run only on **stop/kill/materialize**, so a long-lived Grok pane could keep `~/.grok/auth.json` expired (and revoke the host refresh) while the private file held the only live key → sibling agents and Dev Host dogfood hit the browser login wall. Fix: rank credentials by **non-expired `expires_at` first**, then `create_time`, then mtime; **`maybeHarvestGrokAuthFromWorkspace`** (throttled) on agent-list refresh when any private home has a regular `auth.json`. **✓** unit `test/unit/harness.test.ts` (t-6c8437).  
**Parity lesson:** measuring only “symlink exists on first materialize” / “Bridge MCP tools list” is **not** enough for harness auth. A first-class private home also requires **auth survives rematerialize after in-home login** (or an explicit `~` with a task) **and** **in-session refresh is harvested without waiting for stop**.

#### Pi

| Cap | Native mechanism | Tachyon seam | Verified |
|-----|------------------|--------------|----------|
| Brief | positional startup message | `INSTRUCTION_ARG.pi` / opening-primer adapter | SDD 399 units + Dev Host |
| Bridge | no native MCP; native extension `registerTool()` | immutable `pi-bridge-extension` loaded with `--extension` | SDD 399 real loader + human dogfood |
| Attention | framed Pi editor + shared pane patterns | `runtimeProfile.pi.composer` + framed-region Attention support | **✓** SDD 403 measured/unit/real-tmux + Dev Host idle/draft pass |
| Resume | `--session-id` + exact `--session` | adapter + bounded JSONL header resolver | SDD 400 real process A → B + human Stop/Resume |
| Fork | `--session-id <new> --fork <exact-source-path>` | positive ownership + native `forkCommand`; interim SDD 408 admission refuses a live Pi sibling | **~** mechanism proven by SDD 405, temporarily unavailable while source Pi remains live |
| Harness/private home | `PI_CODING_AGENT_DIR`; sessions override; `--no-*` + explicit resource paths | default `.tachyon/harness/<agent>`, regular mode-0600 auth copy; SDD 406 exact local extension/skill/prompt/theme/package snapshots | **✓** SDD 401 + 406 units and real Pi RPC dogfood |
| OAuth concurrency | native auth lock is scoped to each private pathname | workspace-wide serialized admission; at most one live Pi until upstream shared auth-file support | **~** SDD 408 unit; safety mitigation, not true concurrent OAuth |
| Stop | Escape interrupt, Ctrl+C clear, Ctrl+D empty-editor exit | measured profile with delayed conditional keys | **✓** idle/draft/active real-tmux + Dev Host pass |
| Activity | private v3 session JSONL | exact resolver → `piNormalizer` → bounded `ActivityLogWriter` | **✓** SDD 402 unit/integration, real-transcript dogfood and Dev Host visual pass |
| Permission inject | `--exclude-tools bash,edit,write` | authoritative Delivery reviewer adapter; canonical built-in denylist remains Bridge-compatible | **✓** SDD 404 unit injection + real catalog + human Dev Host posture pass |
| Profile | label + private-home + framed composer + stop + reviewer permission | `runtimeProfile.pi` v3 | SDD 401/403/404; model/general permission remain partial |

**Pi harness note:** resource harness mode is stricter than ordinary project trust: automatic extension/skill/prompt/theme discovery (including `$HOME/.agents/skills` and project `.pi`) is disabled, then only declared private snapshots load. Local packages use Pi's local resolver without installs; npm/git acquisition remains out of scope.

**Pi reviewer note:** the read-only posture disables Pi's only default shell/mutation tools and leaves native `read` plus extension/Bridge tools. It is not an OS sandbox or universal Bridge/resource-extension mutation ban.

**Pi interaction note:** composer/stop measurements target Pi v0.80.10 default keybindings. Tachyon does not rewrite `keybindings.json`; remapped `app.interrupt`, `app.clear` or `app.exit` can invalidate graceful Stop.

**Pi auth note:** each home receives a regular private `auth.json` snapshot. Pi writes auth in place and locks by pathname, so private copies have distinct refresh lock domains and OAuth branches cannot be reconciled safely after concurrent rotation. SDD 408 therefore permits at most one live Pi process per workspace across Spawn/Resume/Restart/Fork, regardless of auth type. This is intentionally conservative and remains until upstream Pi publishes an independent shared auth-file/credential-store hook; Tachyon still does not promote private credentials back to `~/.pi/agent`.

### 3.3 Secondary runtimes

| Runtime | Brief | Resume | Bridge | Harness | Activity | Native config | Notes |
|---------|:-----:|:------:|:------:|:-------:|:--------:|:-------------:|-------|
| Gemini | ✓ (`-i`) | ✓ adapter | — | — | — | ✗ | Thin overall |
| Antigravity | ✓ (`--prompt-interactive`) | ✓ (`--conversation` / `--continue`) | — | — | — | ✗ | Thin overall |
| Qwen | — | ✓ (`--continue` style) | — | — | — | ✗ | Thin |
| Continue | — | ✓ (`--resume <id>`) | — | — | — | ✗ | Thin (not “no resume”) |
| Hermes | ✓ (`HERMES_TUI_QUERY` + forced TUI) | ✓ adapter + live session follow (`--resume`/`-c`) | ✓ (`HERMES_HOME` + `config.yaml` MCP) | ✓ (isolated MCP set; optional auth; hooks rejected) | ✓ (`state.db`, timestamp/model, bounded backfill) | ✗ | Operational inheritance exists, but canonical policy/inspector does not. Hardened seams: 2026-07-16 (`agentManager`, `harness`, `resume`, `hermesStorageReader`). No fork or permission reader. Detail: [`hermes.md`](./hermes.md). |

Promoting a secondary runtime means walking §2 with **native** measurements, then filling the summary table.

### 3.4 Harness vs non-harness (same runtime, different cells)

These diverge; the summary table alone cannot show them:

| Seam | Non-harness | Harness (`def.harness`) |
|------|-------------|-------------------------|
| Bridge | `withRuntimeBridge` injects CLI/env | **early-return** — MCP folded into materialized private config |
| Fork (UI) | shown when `forkCommand` exists | **hidden** (`!def?.harness && forkable(...)`) |
| Isolation assert | parented agents need verified isolation / worktree | assert **skipped** when harness |
| OpenCode permission | delegated non-harness path can write permission block | harness generation site currently **dead code** |
| User-defined hooks | supported only where a native materializer runs | OpenCode/Grok/Hermes reject `harness.hooks` rather than silently dropping them |

### 3.5 Outros — unsupported / generic fallback

**Purpose:** make “it runs in a pane” unconfusable with “first-class runtime.”  
**Board:** `t-f61ce8` (docs only — no new adapters).  
**Verified against code:** 2026-07-24 · seams listed in the doc header.

#### 3.5.1 Who is “Outros”?

Anyone who is **not** a first-class matrix column (§3.1) and **not** a filled secondary row (§3.3). In practice:

| Bucket | Examples | How Tachyon classifies today |
|--------|----------|------------------------------|
| **A. Known basename, thin / no family adapters** | `aider`, `goose`, `amp`, `cursor-agent`, `copilot`, `verboo` (in `KNOWN_AI_CLIS` for kind inference) but **not** in `ResumeRuntime` / `RUNTIME_BY_BIN` | `inferKind` → **agent**; no resume/fork/Bridge family path |
| **B. Renamed binary / path alias** | `~/bin/my-claude`, `claude-custom` if basename ≠ catalog | Basename-driven selection fails → treated as unknown CLI |
| **C. Shell wrappers** | `bash -lc '…'`, custom scripts that hide the real binary | Opening-prompt + adapters **do not** unwrap; `openingPromptCapability` → `unsupported` |
| **D. Package launchers** | `npx …`, `bunx …`, `pnpx …`, `env VAR=… cmd` | `resolveBinary` / `resolveRuntimeBinary` may recover a basename when the launcher shape is recognized; otherwise Outros |
| **E. Completely unknown CLI declared under `agents:`** | `my-bot --serve` with explicit `kind: agent` or inferred agent | Spawned as a managed pane; no family wiring |
| **F. Terminals** | `agents:` entries inferred/forced **terminal** (servers, shells, builds) | Lifecycle yes; AI product seams no (by design) |

**Not Outros:** Gemini / Antigravity / Qwen / Continue / Hermes — those are **secondary** (§3.3): partial adapters exist; promote by walking §2, not by inventing a fake “generic Claude.”

#### 3.5.2 Classification contract (code → product language)

| Mechanism | Seam | Outros behavior |
|-----------|------|-----------------|
| Kind inference | `inferKind` / `KNOWN_AI_CLIS` | Basename in the list → default **agent** (attention on); else **terminal**. Explicit `kind:` wins. |
| Runtime id | `runtimeOf` / `RUNTIME_BY_BIN` | Unknown basename → `null` (no `ResumeRuntime`) |
| Opening prompt / Soul | `runtimePromptAdapter`, `openingPromptCapability`, `composeCommand` | No adapter → instructions **stored but not delivered** (`composeCommand` returns bare `cmd`); Soul **fails closed** with a direct-command diagnostic |
| Bridge | `AgentManager.withRuntimeBridge` | Only `claude` / `codex` / `opencode` / `grok` / `hermes` / `pi` (and harness fold) inject MCP/home. All other binaries: `{ wired: false }` — **no silent MCP** |
| Resume / fork | `adapterFor` / `resumeCommand` / `forkCommand` | No adapter → host must not claim session continuity |
| Graceful stop | `gracefulStopForCommand` | Falls through to `DEFAULT_GRACEFUL_STOP` (C-c, C-c, C-d; `source: assumed`, `verified: false`) |
| Isolation | `isolationMechanismForCommand` | No profile → `mechanism: "none"` (non-AI cmd) or `"unknown"` if a runtime id existed without profile |
| Activity | named normalizers | No normalizer → no durable structured Activity from a native store |
| Headless probe | `ProbeService` adapters | Not registered → `probe_agent` cannot target that runtime |
| Restart | host kill + spawn same definition | **Available** for declared managed entries (product host path), independent of CLI family |

#### 3.5.3 Capability marks (Outros column) — evidence

| # | Cap | Mark | Why (honest) |
|---|-----|:----:|--------------|
| 1 | Brief | **✗** | No `runtimePromptAdapter` → startup brief / `instructions` not appended (`composeCommand`). Not “partial delivery.” |
| 2 | Bridge MCP | **✗** | `withRuntimeBridge` returns `wired: false` for non-family binaries. Agent may still run; it does **not** get Tachyon Bridge tools. |
| 3 | Attention | **~** | Shared pane patterns still run for **agent** kind; no composer/rate-limit **identity**, no measured stop for that CLI. Terminals often have attention off by default. |
| 4 | Resume | **✗** | No `ResumeAdapter`. |
| 5 | Fork | **✗** | No `forkCommand`. |
| 6 | Harness | **✗** / **—** | Private-home materializers are family-specific. Unknown CLI + `harness:` is not a supported first-class path; do not imply isolation. |
| 7 | Graceful stop | **~** | Assumed key sequence only (`DEFAULT_GRACEFUL_STOP`); not measured per CLI. |
| 8 | Activity | **✗** | No named transcript normalizer / reader. |
| 9 | Permission inject | **✗** | No reader applies a native permission posture. |
| 10 | Label / profile | **✗** | No `runtimeProfile` entry → no first-class label/isolation/composer block. |
| 11 | Restart | **✓** | Host-level: stop process + spawn the same managed definition again. **Not** “native restart semantics.” |
| 12 | Native config parity | **✗** | No private projection policy. |
| 13 | Headless probe | **✗** | No `HeadlessCaptureAdapter`. |

#### 3.5.4 UI / diagnostics contract (do not confuse operators)

| Must say | Must **not** say |
|----------|------------------|
| Managed pane / declared agent or terminal | “Supported runtime” / first-class parity peer |
| Bridge: not wired (when `wired: false`) | Implied MCP tool list for unknown CLIs |
| Resume/fork unavailable | Session continuity for arbitrary CLIs |
| Instructions/Soul unsupported for this command | Silent drop of Soul as success |
| Generic stop sequence (assumed) | Measured graceful stop for that binary |

Product surfaces (Fleet kind badge, Doctor, spawn errors, Soul diagnostics) should prefer the **opening-prompt capability** and **Bridge wired** bits over guessing from the command string.

#### 3.5.5 Gaps → follow-ups (only if prioritized)

Documentation task **does not** open adapters. Concrete gaps (open a normal task only when scheduled):

| Gap | Notes |
|-----|--------|
| Catalog drift | `KNOWN_AI_CLIS` includes basenames with no resume/Bridge family — kind=agent is optimistic |
| Wrapper unwrap | Shell wrappers never resolve to a family without an explicit product design |
| UI copy audit | Ensure Control/Fleet never implies first-class for Outros (spot-check when touching Fleet chrome) |

No Product Invariant change. No new adapter in this task.

---

## 4. How to update this document

1. **When:** any PR that changes adapters, runtime profiles, Bridge injection, harness materialization, activity normalizers, or attention patterns for a runtime.  
2. **What:** update the summary mark, the per-runtime seam row, and a **concrete** verification token (date · CLI version · test path · task id). Bump the doc header `Last verified` when the matrix substance changes.  
3. **How to mark ✓:** (a) unit/integration coverage that pins the wiring, **or** (b) dated dogfood with observable proof. If neither exists, use `~` or `✗`.  
4. **Gaps:** open a **normal** board task when prioritized — never a permanent matrix owner task.  
5. **Disputes:** code wins; fix the doc in the same change set when possible.  
6. **Outros (§3.5):** when changing `KNOWN_AI_CLIS`, `runtimeOf` / `RUNTIME_BY_BIN`, `withRuntimeBridge` family branches, `composeCommand` / opening-prompt adapters, or `DEFAULT_GRACEFUL_STOP`, re-check the Outros column and §3.5 evidence. Do not promote a CLI into Claude/Codex/… columns without native measurements.

### Open gaps (as of 2026-07-16)

| Gap | Focus |
|-----|--------|
| ~~Grok Activity~~ | **Closed t-9874be** — `grokNormalizer` + `GROK_HOME/sessions/.../chat_history.jsonl` file-tail |
| Grok permission inject | consumers for measured profile / `--permission-mode` at spawn |
| Grok isolation profile | align `runtimeProfile.grok.isolation` with private-home materialization **or** document the worktree gate forever |
| OpenCode profile completeness | `label` / model aliases if UI needs them; permission inject on harness path |
| ~~Claude active/drafted stop measurement~~ | **Closed `t-b727bd`** — authorized Claude Code 2.1.220 active-turn stop exited status 0 after Escape, Ctrl+C, and `/exit` (2026-07-25) |
| Codex fork | only if Codex CLI gains stable native fork |
| ~~Grok auth rematerialize~~ | **Closed t-2b0a08** — promote private regular `auth.json` before re-symlink; see Grok auth note above |
| ~~Pi opt-in harness resources~~ | **Closed SDD 406** — exact private local extension/skill/prompt/theme/package snapshots with automatic discovery disabled and no install side effects |
| Release hygiene | versioned VSIX that includes Bridge Grok path (no hand-patch of installed `dist`) |
| ~~Hermes Brief/Resume/Bridge/Harness contracts~~ | **Closed/hardened 2026-07-16** — forced TUI, isolated MCP inheritance, optional auth, fail-closed hooks and activity-based session selection. See [`hermes.md`](./hermes.md). |
| ~~Hermes Activity reader~~ | **Closed/hardened 2026-07-16** — `state.db` reader now preserves source timestamp/model, follows live session switches and bounds cold backfill. Residual: visual dogfood, token/cost projection. |
| Hermes active-runtime promotion | Measure composer/attention and graceful stop; implement or explicitly reject permission posture; native fork remains absent |
| RuntimeOps panel model column | still declared/profile-only (spec 378 exposes the observed model + declared-vs-observed `modelDivergence` fact in the snapshot payload for agent consumers; the panel's own Model cell doesn't render it yet — a small follow-up once the sidebar usage is dogfooded) |

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
| [`docs/runtimes/hermes.md`](./hermes.md) | Hermes gap inventory (native CLI vs Tachyon seams; promotion path) |
| `src/runtime/runtimeProfile.ts` | Machine-readable profile fragments |
| `src/resume/adapters.ts` | Resume/fork/harness descriptors |
| `.tachyon/reviews/parity-doc-claude.md` | 2026-07-09 adversarial review |
| `.tachyon/reviews/parity-doc-codex.md` | 2026-07-09 adversarial review |

---

## 7. Changelog (doc only)

| Date | Change |
|------|--------|
| 2026-07-26 | **Claude Runtime Config (SDD 464 / `t-e5cb7c`):** independent JSON document CAS for global/workspace settings, local shadow detection, read-only MCP-name inventory, safe scalar writes, runtime-scoped pending and Dev Host functional/visual dogfood. |
| 2026-07-26 | **Claude canonical native policy (SDD 465 / `t-fdd3a0`):** closed global/workspace scalar families, typed agent-owned model/effort argv, safe permission-mode validation, and equivalent fresh/restart/resume/fork projection. |
| 2026-07-26 | **Claude Agent Form parity (SDD 466 / `t-36b7f0`):** New/Edit authors measured model/effort and per-family sources, hides provider/service tier, preserves round-trip, and reports the verified canonical baseline as Ready. |
| 2026-07-24 | **Cap 13 Headless probe:** matrix row for SDD 257 `probe_agent` adapters. Claude/Codex ✓ (shipped 0.40.0); Grok ✓ via `t-7426de` (`adapters/grok.ts`); OpenCode/Pi/Hermes ✗ deferred. |
| 2026-07-18 | **Pi OAuth interim safety (SDD 408):** at most one live Pi process per workspace across Spawn/Resume/Restart/Fork until upstream shared-auth support ships; 394 unit tests + human dogfood `v-591729`. |
| 2026-07-18 | **Pi exact harness resources (SDD 406):** workspace-local extensions/skills/prompts/themes/package directories are no-follow snapshotted per agent and loaded through Pi's `--no-*` + explicit CLI paths; remote installs and automatic ambient/project resource discovery are excluded in harness mode. |
| 2026-07-19 | **Startup-brief semantics (SDD 411):** long aggregate onboarding is labelled `startup brief`, carries a bounded typed layer inventory, distinguishes missing/unstructured/`DELIVERABLE`/`DONE_WHEN` task state, and retains pointer-only freshness semantics across positional and Hermes TUI delivery. |
| 2026-07-16 | **Hermes contract hardening:** startup brief forces modern TUI and rejects explicit classic CLI; harness `inherit:none` strips ambient MCPs; OAuth file is optional; unsupported hooks fail closed; resume/live Activity follows actual message activity; SQLite ingest preserves timestamps/model and bounds backfill. |
| 2026-07-13 | **spec 378 live-model-sidebar:** claude/codex/grok now latch a transcript-observed `{model, effort?}` (claude `message.model` filtering sidechain/synthetic; codex `turn_context.payload`; grok `assistant.model_id`, un-overloaded off `runtimeVersion` alongside opencode). `RuntimeOpsSnapshotService` projects a boundary-aware observed-vs-declared model fact + divergence; the sidebar row shows it with textual provenance (`· declared`/`· stale`/`≠ declared`). RuntimeOps panel's own Model column stays declared-only (follow-up, see open gaps). Interim honesty: pre-existing durable logs show `declared`/`profile` until the next model-bearing record is appended (no backfill — additive-only log format, no `schemaVersion` bump). Codex per-turn latency: a mid-turn `/model` switch shows the prior model until the next `turn_context` record lands (`observedAt` makes this honest, not hidden). |
| 2026-07-14 | **Hermes Activity Cap 8:** `HermesStorageReader` + `hermesNormalizer` over `$HERMES_HOME/state.db` (unit hermesNormalizer/hermesStorageReader). Secondary Activity mark → ✓. |
| 2026-07-13 | **Hermes secondary promotion:** Brief (`HERMES_TUI_QUERY`), Resume adapter, Bridge `HERMES_HOME`+`config.yaml`, harness shape, `runtimeProfile.hermes`. Activity still `—`. Units in config/resume/harness/runtimeProfile. |
| 2026-07-13 | **Hermes secondary inventory:** §3.3 row (all Tachyon seams `—`); open gap + related link to [`hermes.md`](./hermes.md). Product discovery only — no adapter/Bridge yet. CLI v0.18.2 measured. |
| 2026-07-09 | Initial living matrix; supersedes board task `t-4891dd`. Grok Bridge non-harness marked ✓ after t-843576 dogfood. |
| 2026-07-09 | Fold Claude + Codex adversarial reviews: Grok Brief → ✗; Grok Permission inject → ✗; OpenCode profile/permission → ~; Attention wording + Grok Attention → ~; Claude/Codex stop → ~ until measured; harness/non-harness axis §3.4; secondary brief inversion (Gemini/Antigravity); open gaps refreshed. |
| 2026-07-09 | **Cap 1 Grok closed:** `INSTRUCTION_ARG.grok = (q) => q` + unit test; matrix Brief Grok → ✓. |
