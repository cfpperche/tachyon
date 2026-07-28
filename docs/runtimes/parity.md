# Runtime capability parity (living document)

**Status:** living · **Owner:** Tachyon maintainers · **Last verified:** 2026-07-28 (canonical Grok native-config projection — `t-26f508`)
**Seams (code of record):** `src/resume/adapters.ts`, `src/runtime/runtimeProfile.ts`, `src/agents/AgentManager.ts` (`withRuntimeBridge`, `effectiveCmd`), `src/harness/HarnessManager.ts`, `src/config/agentProfileSchema.ts`, `src/config/agentProfileProjection.ts`, `src/activity/*Normalizer.ts`, `src/attention/patterns.ts`, `src/config/loadConfig.ts` (`KNOWN_AI_CLIS`, `inferKind`, `composeCommand`), `src/agents/openingPromptCapability.ts`
`src/runtimeConfig/codexInventory.ts`, `src/config/codexNativeConfigProjection.ts`, `src/config/grokNativeConfigProjection.ts`

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
| 15 | **Runtime-managed native memory** | Adapter inventories the exact runtime/version's persistent learned-context mechanism and behaviorally verifies disable/enable, injection, mutation, isolation and lifecycle semantics. A written setting without behavioral proof is at most `~`; plugin memory is separate from the built-in runtime mark. |
| 16 | **Auth-required detection** | Runtime exposes a MEASURED signal that it cannot execute for authentication reasons, distinct from rate limit, quota, permission, network and invalid session. `✓` needs a **turn-attached** signal measured on a stated version AND consumed by Tachyon — turn-attached is what makes it work mid-run as well as at launch. `~` means measured but not yet consumed, OR consumed only at the launch boundary because the runtime emits nothing during a turn (`t-0338fc`). `✗` means the runtime gives no reliable signal anywhere. Inferring auth state from silence or exit code alone never qualifies. |
| 17 | **Ad-hoc Agent (`spawn_agent`)** | The runtime may be handed a DELEGATION through the lighter ad-hoc path — no canonical profile required — and can honor it: it resumes as the same entity, it can receive the spec 246 brief, and it can answer through the Bridge. `✓` needs all three; `~` means the runtime is admitted with a declared, task-owned shortfall; `✗` means a command of that shape is refused as an Agent and belongs to `spawn_terminal`. This is a SEPARATE axis from canonical attestation — see §3.6.1. |

For the Codex marks in rows 7, 9, and 12, **✓** is scoped to canonical profiles: Tachyon regenerates
the authored, allowlisted native policy in a private `CODEX_HOME` before fresh spawn, restart, and
resume. It does not claim to impose that policy on arbitrary legacy `cmd: codex …` definitions.

Also real, uneven seams (not full matrix rows yet — see open gaps): **session-id strategy** (mint vs capture), **deterministic `transcriptPath`**, **session-ownership hooks** (Claude `--settings`), **model-label normalization** (Claude/Codex), **live/observed model provenance** (spec 378 plus the Hermes SQLite reader — claude/codex/grok/hermes can latch an observed model; opencode joined them in `t-4a4d30` once its Activity reader followed the store from JSON to SQLite — each message carries the model that answered; gemini/qwen/etc. stay declared-only), **probe effective-model proof** (SDD 473/474/476 — claude/grok prove from provider usage accounting, codex from its own correlated session rollout; the kinds are recorded distinctly and not treated as equal evidence), **composer suggestion vs human draft** (`t-aee74e` codex, `t-c5f29b` claude — both render suggestion text INSIDE an otherwise empty composer and both mark it entirely SGR-dim, so `ansiEmptyContentStyle: "all-dim"` separates it from a typed draft; `t-3eaa8b` then measured grok 0.2.112, opencode 1.18.4, pi 0.80.10 and hermes 0.18.2 across empty composer, typed draft AND completed turn — none renders suggestion text in any of those states, so none declares the rule: with nothing to exempt, declaring it would only weaken a real draft's protection), and **cross-runtime task continuation** (SDD 443 / `t-7551f9`: host focused handoff + new session on another agent — **not** native resume; edit-`cmd` while live is fail-closed via `t-6d09e6`).

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
| 5 Fork | ✓ | ✗ | ✓ | ✓ⁿ | ✓ | **✗** |
| 6 Harness | ✓ | ✓ | ✓ | ✓† | ✓‡ | **✗** / **—** |
| 7 Graceful stop | ✓ | ✓ | ✓ | ✓ | ✓ | **~**¶ |
| 8 Activity | ✓ | ✓ | ✓ | ✓ | ✓ | **✗** |
| 9 Permission inject | ✓ | ✓ | ~ | ~ | ✓ | **✗** |
| 10 Label / profile | ✓ | ✓ | ~ | ✓ | ~ | **✗**¶ |
| 11 Restart | ✓ | ✓ | ✓ | ✓ | ✓ | **✓**¶ |
| 12 Native config parity | ✓ | ✓ | ~ | ~ | ~ | **✗** |
| 13 Headless probe | ✓ | ✓ | ✗ | ✓§ | ✗ | **✗** |
| 14 Runtime Config (Control) | ✓¶ | ✓¶ | ✗ | ✓¶ | ✗ | **✗** |
| 15 Runtime-managed native memory | ~ | ~ | ✗ | ~ | ✗ | **✗** |
| 16 Auth-required detection | ✓ | ✓ | ~‖ | ✓ | ~ | **✗** |
| 17 Ad-hoc Agent (`spawn_agent`) | ✓ | ✓ | ✓ | ✓ | ✓ | **✗**# |

ⁿ **Grok fork** is native for legacy/ad-hoc agents and, since `t-ee5c05`, covered for a CANONICAL profile
too: the fork gets its own projected `bridge-mcp/<fork>.grok` with `HOME` co-bound under exact trust, and
the source **session directory** is seeded into it — not just the file `transcriptPath` names, because
`summary.json` + `updates.jsonl` are what make a Grok session resolvable.

\* **Pi Bridge** is projected through a Tachyon-owned native extension because Pi has no MCP client.

† **Grok harness materialization exists** (`GROK_HOME`, hooks, Bridge fold), but `runtimeProfile.grok.isolation` is still **`project-scoped`** for governance. Non-harness **parented** Grok spawns still require an isolated worktree (`assertVerifiedTranscriptIsolation`). See Grok section + §3.4.

‡ **Pi default private home + exact resource harness exist.** SDD 406 snapshots declared workspace-local extensions/skills/prompts/themes/packages into the per-agent home, disables automatic discovery and passes only explicit private CLI paths. Remote package acquisition/global inheritance remain intentionally unsupported.

# **Ad-hoc Agent is not an Outros capability, with two named exceptions** (`t-8f3f7d`, SDD 478 M9). A generic command — a shell, a server, a build, a renamed binary, anything whose executable cannot be resolved — is refused by `spawn_agent` and belongs to `spawn_terminal`. The exceptions are the secondary runtimes that DO have measured machinery: Hermes is a full `✓`, and Gemini and Qwen are `~` with declared gaps. §3.6.1 has the per-runtime evidence.

‖ **OpenCode auth-required is a LAUNCH-boundary signal, not a turn one** (`t-0338fc`, SDD 477). OpenCode is the only runtime measured to answer a credential-free turn *successfully*, on the fallback model `big-pickle` — so there is nothing in a transcript to match, and `RUNTIME_AUTH_PROFILES` still declares no matcher for it. What exists instead is a measured **credential-store** signal: `opencode providers list` reports its own inventory (`0 credentials`, plus a separate `Environment` section for provider keys found in the environment, covering both of OpenCode's auth paths), and `OpencodeLaunchPreflight` refuses the launch on an empty one rather than letting the agent start unauthenticated. Two bounds keep this `~` and not `✓`: it proves a credential is **readable**, not valid, and it fires only before launch — a credential expiring mid-run is still undetected for OpenCode. See §3.7.

§ **Grok headless probe** (`t-7426de`, SDD 257): `src/probe/adapters/grok.ts` — `grok -p --output-format json`, golden fixtures + binary-gated `--version` smoke. Live model call remains opt-in (`PROBE_LIVE_SMOKE=1`). OpenCode / Pi / Hermes adapters deferred.

¶ **Outros** is not a runtime brand — it is the honest fallback for commands **outside** first-class + secondary adapter coverage. Marks are justified in [§3.5](#35-outros--unsupported--generic-fallback). Do **not** read **✓** Restart as “first-class runtime”; it only means the host can kill and re-spawn the same declared command.

*Secondary adapters: [§3.3](#33-secondary-runtimes). Unsupported / generic: [§3.5](#35-outros--unsupported--generic-fallback).*

¶ **Runtime Config** provides per-document provenance and CAS. Codex exposes its measured TOML
subset; Claude exposes six safe settings scalars, local-shadow detection, MCP names and opaque
section names without executable payloads. Grok exposes nine measured global scalars, native MCP
enable/disable, read-only authority keys and read-only folder trust — and states per document who it
reaches, because its global config does **not** reach a Tachyon-managed agent. Control writes only
the measured subset and marks affected running agents pending.

**Runtime-managed memory:** the 2026-07-26 inventory
[`runtime-native-memory-parity-t-d4c42e.md`](../research/runtime-native-memory-parity-t-d4c42e.md)
finds native mechanisms in Claude, Codex, Grok and Hermes. Claude and Codex are
`~` because private-home/default-disable projections exist but no behavioral
disable/enable verifier exists. Grok is `~` because `--no-memory` is measured
and used by probes but not canonical launches. OpenCode and Pi have no built-in
mechanism (`✗`); plugins/extensions can still introduce uncontrolled memory.
Hermes belongs under **Outros** until it has a canonical profile adapter and
remains `✗` because copied config can reconnect native or external-provider
memory. Human-approved selected memory is a separate Tachyon lane.

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
| Claude | canonical policy projects reviewed global scalar families, including the `statusLine` a selected Interface family carries into the private home (`t-af504e`); unselected global keys stay opaque and unauthored, so a personal `~/.claude/settings.json` carrying `$schema`, `tui`, `switchModelsOnFlag`, … never blocks activation (`t-45e80d`); selected auth/bootstrap remains external | canonical policy projects reviewed workspace scalar families; unselected workspace keys fail closed; selected owner-captured skills/hooks/MCP require exact Claude grants; ambient `settings.local.json`, plugin roots and unselected workspace tooling remain excluded | private `CLAUDE_CONFIG_DIR`; generated closed settings, typed `--model`/`--effort` selectors, captured skill tree, strict selected-MCP+Bridge config, and manifest-last provenance | credential symlink plus onboarding markers; auth is not profile-authored; a refresh that detaches the symlink is harvested and every private home is re-converged on the authority, and a genuinely dead session refuses at materialize (`t-9598cc`) | fresh/restart/resume regenerate the same selected generation and remove stale state; fork copies the typed projection into a distinct private home and seeds the exact transcript across home/cwd namespaces (`t-fdd3a0`, `t-088454`, SDD 465/463, 2026-07-26) | ✓ |
| Codex | canonical policy projects reviewed global scalar families; auth stays external | canonical policy projects reviewed workspace scalar families; unselected keys fail closed | private `CODEX_HOME`; atomically regenerated selectors/scalars plus captured profile skills/MCP/hooks and Bridge | OAuth credentials | fresh/restart/resume regenerate an identical private projection before launch (`t-1a3d50`, 2026-07-25); fork is unavailable; native extensions remain explicitly unsupported | ✓ |
| OpenCode | ambient global XDG excluded | `inherit: workspace` snapshots `opencode.json`; `none` starts empty | private XDG config/data/state plus MCP overlay | `auth.json` copied (never symlinked) into the private `XDG_DATA_HOME`, and a launch whose credential store comes back empty is refused rather than degraded (`t-0338fc`); validity of the copied credential is still not classified here | spawn/restart/resume wiring exists; per-family refresh evidence incomplete | ~ |
| Grok | canonical policy projects reviewed global scalar families (`[ui]`, `[features]`, `[permission]`) plus typed agent-owned `[models]` selectors; unselected global keys (`[cli]`, `[marketplace]`, `[model.*]`, …) stay opaque and unauthored; `always-approve`/`yolo` are omitted with a warning unless THIS agent authorizes them (`t-26f508`) | **no projectable workspace source** — measured on 0.2.112, a project `.grok/config.toml` contributes only `[mcp_servers]`/`[plugins]`/`[permission]` and its permission block did not reach the effective rule set, so `workspace` is refused rather than offered; ambient `.grok` tooling and `AGENTS.md` are refused by the inspector | private `GROK_HOME` + `HOME`; regenerated `config.toml` carrying the closed projection, the Bridge server, `[memory] enabled = false` and every `[compat.*]` cell pinned off; exact workspace/cwd trust store and hooks | auth symlink plus reconciliation; auth is not profile-authored and survives every rewrite | fresh/restart/resume regenerate byte-identical config; fork materializes the fork's OWN projected private home and seeds the source session directory into it (`t-ee5c05`); stale trust removed without losing auth/MCP (`t-26f508`, `t-15d7e7`) | ~ |
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
| Grok | ✓ `$GROK_HOME/config.toml` (default `~/.grok`), plus read-only `trusted_folders.toml` | ✓ `<workspace>/.grok/config.toml`, MCP only — Grok ignores every other section in project scope | ✓ nine global scalar keys; permission/approval keys shown read-only | ✓ MCP names with Grok's **native** `enabled` toggle; hooks/telemetry/provider/marketplace/memory sections opaque | ✓ measured scalar + MCP subset, per-document CAS on the raw text + atomic TOML replace | ✓ per document — workspace always; global for a canonical profile (see below) | `src/runtimeConfig/grokInventory.ts`; `test/unit/grokRuntimeConfigInventory.test.ts`; `npm run dogfood:grok-runtime-config` (round-trip against the installed binary); `test/browser/grokRuntimeConfigView.test.ts` (headless Chrome over the shipped bundle — agents do not open a Dev Host); SDD 481 / `t-ce83a2` |

**Grok's impact rule is per document, and it changed under us.** The **workspace** document is
discovered from the working directory, so it reaches a live agent even under a private `GROK_HOME`
(measured 2026-07-28, and independently re-measured by `t-26f508` via an ambient
`[mcp_servers.ambient]` that DID reach the effective server list) — it therefore marks live Grok
agents pending regardless of profile. The **global** document depends on the agent: since `t-26f508`
a canonical Grok profile projects the measured families from `~/.grok/config.toml` into its private
home at every launch, so it is marked pending by the same projection rule Claude and Codex use, while
a Bridge-only agent launches without those families and is not. SDD 481 originally recorded that the
global document reached NO managed agent; that was true when measured and `t-26f508` superseded it
mid-slice — the adapter, the pending rule and both directions of the test were corrected on merge
rather than left to drift. Each document states its own reach in the UI.

**Not eligible yet:** OpenCode, Pi, Hermes and every other detected runtime. Their
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
| Attention | TUI pane + rate-limit strings | shared patterns + `RateLimitRuntime` + **composer** profile carrying the measured all-dim suggestion rule (`t-c5f29b`) and the measured history-echo rule (`t-6ffa13`) | code `patterns.ts` / `runtimeProfile.claude` |
| Composer occupancy | live editor carries no background; a submitted message is echoed into the transcript with its glyph painted (`\x1b[48;5;237m❯ `) | `ansiHistoryEchoStyle: "prompt-background"` keeps `findComposerRegion` from selecting an echoed message as the editable region; `ansiEmptyContentStyle: "all-dim"` keeps a dim suggestion from counting as a draft | **✓** `t-6ffa13` units over `capture-pane -e` lines measured on 2.1.220 (2026-07-27), incl. a localized post-turn suggestion |
| Resume | `--resume <id>`; named session `-n` | `resume/adapters.ts` claude (`mintsId` / `nameMint`) | code |
| Fork | `--resume <id> --fork-session` | `forkCommand` | measured (spec 225 era); UI hides for harness |
| Harness | `CLAUDE_CONFIG_DIR` + MCP file | `HarnessManager` | specs 226+ |
| Auth refresh / relogin | `.credentials.json` rewritten by create+rename on OAuth refresh (which replaces the symlink); `claude /login` rewrites the authority | `reconcileWorkspaceClaudeAuth` harvests → promotes → re-symlinks **every** eligible private home (materialize + throttled agent-list tick); `claudeCredentialState` grades projection and health separately; `assertUsableClaudeAuth` refuses a dead session at materialize, before a pane exists | **✓** `t-9598cc` units; detachment measured 2026-07-27 |
| Stop | Escape / Ctrl+C / local `/exit` | `runtimeProfile.claude.gracefulStop` | **✓** Claude Code 2.1.220 TTY: authorized active turn stopped by Escape, Ctrl+C, then `/exit`; pane exited status 0 (2026-07-25) |
| Activity | `~/.claude/projects/.../*.jsonl` | `claudeNormalizer` (+ ownership hooks on shared cwd) | specs 238–240 era |
| Permission inject | `--permission-mode`, `settings.json` permissions | canonical private `settings.json` regenerates only an explicitly selected, validated global/workspace permission block; `bypassPermissions` is rejected by the canonical projector unless THIS agent's profile explicitly authorizes it (`nativeConfig.permissions.authorize: [bypassPermissions]`, SDD 471) — inheriting it from the person's global settings is never sufficient on its own; ad-hoc ownership injection remains separate | Claude Code 2.1.220 measurement plus closed projector/lifecycle regressions in `t-fdd3a0` / SDD 465, per-agent authorization in SDD 471 / `t-98427e` |
| Native config parity | `settings.json`, `--model`, `--effort` | exact per-family global/workspace scalar projection plus agent-owned selector argv; provider/service tier and unselected keys fail closed; the Interface family carries `statusLine`, so the private home preserves the status line instead of blanking it (`t-af504e`) | **✓** `t-fdd3a0`; profile/harness/fresh-restart-resume/fork regressions, 2026-07-26; status-line projection `t-af504e`, 2026-07-28 |
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
| Permission inject | private `config.toml` policy | canonical profiles regenerate selected `approval_policy` and `sandbox_mode` in private `CODEX_HOME`, held to the measured enums (`untrusted`/`on-failure`/`on-request`/`never`, `read-only`/`workspace-write`/`danger-full-access`); the two dangerous values are rejected unless THIS agent's profile explicitly authorizes them (`authorize: [neverAskForApproval]` / `[dangerFullAccess]`, SDD 472) — inheriting them from the person's global config is never sufficient on its own; arbitrary legacy commands remain unchanged | **✓** `t-60ff74`, strict-config parser + lifecycle regression; value enums measured against `codex-cli 0.145.0` and per-agent authorization in SDD 472 / `t-b0440a` |
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
| Activity | `opencode.db` (SQLite) — the JSON `storage/` tree is retired | `opencodeNormalizer` + reader (both stores; DB wins) | t-0b2f30; re-measured on 1.18.5 in `t-4a4d30` |
| Observed model | per-message `providerID`/`modelID` in the store | `modelLabel` reads the flat (assistant) and nested (user) shapes | `t-4a4d30` — captured session replays as `opencode-go/glm-5.2` |
| Permission inject | config `permission` block | **non-harness delegated** path only (`applyDelegatedOpencodePermission`); harness generation site is dead code | t-fb19bd era → mark `~` |
| Profile | isolation + stop only | `runtimeProfile.opencode` — **no `label`**, no GLM alias fields | 2026-07-09 review → mark `~` |

Detail dump: [`docs/runtimes/opencode.md`](./opencode.md) (narrative may still say “GLM” for product; machine profile does not yet).

#### Grok

| Cap | Native mechanism | Tachyon seam | Verified |
|-----|------------------|--------------|----------|
| Brief | positional `[PROMPT]` after options | `INSTRUCTION_ARG.grok = (q) => q` via `composeCommand` / `effectiveCmd` (after `injectResumeId` → `grok -s <uuid> '<brief>'`) | **✓** 2026-07-09 unit `config.test.ts` + code (was ✗ until Cap 1 fix) |
| Bridge | `GROK_HOME` + `[mcp_servers.tachyon_bridge]` (`headers` + `${VAR}`) | non-harness: `materializeBridgeMcpGrok`; harness: `buildGrokHarnessConfig` | **✓** 2026-07-09 dogfood (t-843576) — `grok mcp list`; native tools after stop/resume |
| Model preflight | `grok models` (bounded catalog command; CLI refuses unlisted ids) | `GrokLaunchPreflight` — pinned models resolve `supported`/`unsupported`, unreadable catalog stays `unverifiable` | **✓** 2026-07-26 measured on 0.2.112 + real-CLI dogfood (`t-85c586`) |
| Attention | global pane patterns **plus** the first measured per-runtime overlay (`manifests/grok.json`) | native tool-authorization modal detected as `needs-input` (`t-4e6ba5`); still no composer profile; not in `RateLimitRuntime` | **~** overall, but tool-auth prompts **✓** 2026-07-26 measured on grok 0.2.112 + real-pane check |
| Resume | `-r` / `-c` | adapter `resumeCommand` (`mintsId`) | **✓** 2026-07-09 live stop/resume |
| Fork | `-r <id> --fork-session` | `forkCommand`; a canonical profile is a `managedPrivateFork` — its own `bridge-mcp/<fork>.grok` is materialized with the projection, `HOME` co-bound, exact trust applied, and the source SESSION DIRECTORY seeded across homes/cwds (`transcriptUnit: "session-directory"`) | **✓** `t-ee5c05`, 2026-07-28 — measured on 0.2.112: a namespace seeded with only `chat_history.jsonl` reported "Session not found" to `grok export` and was absent from `grok sessions list`; with `summary.json` + `updates.jsonl` it exported byte-identically (642 bytes) to the source home |
| Native config parity | `~/.grok/config.toml` `[models]`/`[ui]`/`[features]`/`[permission]`, `[compat.*]`, `[memory]` | closed per-family global projection into the private `config.toml` (`projectGrokNativeConfig` → `renderGrokCanonicalConfig`), typed agent-owned `[models]` selectors, `always-approve`/`yolo` gated behind an explicit per-agent authorization, and an unconditional isolation block (`[memory] enabled = false` + every `[compat.*]` cell false) | **✓** `t-26f508`, 2026-07-28 — projector/renderer/lifecycle units, plus live `grok inspect --json` on 0.2.112: a private home with the Bridge-only config reported an ambient `.claude/skills/*` as `compatibilityStatus: "enabled"` and 0/13 compat cells off; the same home with the projected config reported that skill `"disabled"`, 13/13 cells off, and `tachyon_bridge` still present |
| Harness | `GROK_HOME` + hooks dir | harness + lifecycle hooks + Bridge fold **exist**; auth seed + **rematerialize** (below) | **✓** materialization; auth rematerialize **✓** t-2b0a08 unit |
| Stop | C-c, C-c | `runtimeProfile.grok` measured | t-bae032 / 2026-07-08 |
| Activity | `sessions/<encodeURIComponent(cwd)>/<id>/chat_history.jsonl` | `grokNormalizer` + `transcriptPath` + file-tail in `ActivityLogWriter` (sessionId from parent dir) | **✓** 2026-07-12 unit `grokNormalizer.test.ts` + `logWriter` Grok rotation (t-9874be) |
| Permission inject | `--permission-mode`, `--always-approve` (measured on CLI); `[ui] permission_mode` and `[permission]` allow/ask/deny in config | canonical profiles regenerate an explicitly selected, validated global permission block in the private `config.toml`; `always-approve`/`bypassPermissions`/`yolo = true` are omitted with a named warning unless THIS agent's profile authorizes them (`nativeConfig.permissions.authorize: [alwaysApprove]`) — inheriting them from the person's global config is never sufficient. The legacy argv path is unchanged: `alwaysApproveFlag` still has zero readers and Tachyon never infers `--always-approve` | **~** config projection **✓** `t-26f508` (value enums from the shipped 0.2.112 guide plus the measured `--permission-mode` enum); argv injection still **✗** |
| Profile | `label: "Grok"` + isolated home + stop | `runtimeProfile.grok`; canonical launches bind both `GROK_HOME` and `HOME` to the private home | private transcript/config namespace ✓; composer/attention remains `~` |
| Headless probe | `grok -p --output-format json` (+ `--json-schema` for archetypes) | `src/probe/adapters/grok.ts` + `ProbeService` + `probe_agent` enum | **✓** t-7426de unit + binary-gated `--version` smoke |
| Runtime Config | `$GROK_HOME/config.toml` (user layer), `<repo>/.grok/config.toml` and `<cwd>/.grok/config.toml` (project layers, `[mcp_servers]` only), `trusted_folders.toml` | `src/runtimeConfig/grokInventory.ts` — measured scalars, native MCP `enabled` toggle, read-only authority keys and trust, per-document CAS | **✓** 2026-07-28 measured on 0.2.112; `npm run dogfood:grok-runtime-config` 15/15 round-trips through `grok inspect --json` (SDD 481 / `t-ce83a2`) |

**Grok Runtime Config note:** the private-home posture the rows above describe is exactly why the
**global** document reaches no managed agent — `materializeBridgeMcpGrok` writes the private
`config.toml` from scratch at every spawn. Editing `~/.grok/config.toml` in Control therefore changes
the person's own `grok`, not the fleet; the workspace document, discovered from the working
directory, is the one that reaches agents. Control states this per document instead of implying a
uniform blast radius.

**Grok Bridge note:** private `GROK_HOME` (e.g. `.tachyon/bridge-mcp/<agent>.grok`) is the runtime’s native config surface with a redirected home — not a bypass.  
**Grok isolation note:** Grok 0.2.112 also discovers `$HOME/.claude/settings.json`; canonical launches therefore bind `HOME` to the same private `GROK_HOME`, preventing ambient permission discovery while retaining external `auth.json` by symlink. This makes the canonical transcript/config namespace private-home; legacy/ad-hoc commands retain their declared isolation posture. **Ad-hoc / non-harness Bridge** injects only `GROK_HOME` (not `HOME`) and still hits the parented **project-scoped** worktree gate — measured and kept intentional in [`adhoc-runtime-parity-grok.md`](../research/adhoc-runtime-parity-grok.md) (`t-1d49df`).
**Grok auth / rematerialize (t-2b0a08, 2026-07-09):** private home must keep `auth.json` as a **symlink** to the real `~/.grok/auth.json`. Interactive login under redirected `GROK_HOME` can replace that symlink with a **regular file** (fresh tokens only in the private home). On every reload/rebind, `materializeBridgeMcpGrok` used to `unlink` then re-symlink to the **stale** real auth → re-login wall. Fix: **`promoteNewerPrivateAuth`** — if private `auth.json` is a regular file newer than the real target, copy it to real (mode 600) **before** unlink/relink. Canonical truth remains `~/.grok/auth.json`. **✓** unit `test/unit/harness.test.ts` (t-2b0a08).  
**Grok auth / in-session harvest (t-6c8437, 2026-07-24):** OIDC refresh mid-session leaves a **regular** private `auth.json` while the agent is still running. Harvest used to run only on **stop/kill/materialize**, so a long-lived Grok pane could keep `~/.grok/auth.json` expired (and revoke the host refresh) while the private file held the only live key → sibling agents and Dev Host dogfood hit the browser login wall. Fix: rank credentials by **non-expired `expires_at` first**, then `create_time`, then mtime; **`maybeHarvestGrokAuthFromWorkspace`** (throttled) on agent-list refresh when any private home has a regular `auth.json`. **✓** unit `test/unit/harness.test.ts` (t-6c8437).  
**Claude auth / global relogin does not reach private homes (t-9598cc, 2026-07-27):** the lesson below was written for Grok and never applied to Claude, which has the **same** mechanism — Claude Code rewrites `.credentials.json` by create+rename under `CLAUDE_CONFIG_DIR`, replacing Tachyon’s symlink with a **regular file** on every OAuth refresh. Claude had no harvest, no workspace reconcile and no pre-launch credential assertion: `materializeHome` called `promoteNewerPrivateAuth` only for Hermes and `reconcile…` only for Grok, and returned before the `t-303f2b` readable-auth checks. Three consequences, all measured on 2026-07-27: a detached private snapshot **outlived a global `/login`** indefinitely (`.tachyon/harness/claude-opus5/.credentials.json` was a regular file whose contents differed from the authority’s while sibling homes were symlinks); `ensureAuthSymlink` would have **destroyed** a fresher private refresh rather than harvesting it; and the failure surfaced only as `runtime_auth_rejected` at launch readiness, after a pane, a worktree and a home already existed — the “compensation was incomplete” tail. Separately, **`authCredentialRank` could not read a Claude credential at all**: it parsed only ISO `expires_at` / `create_time`, while Claude states epoch-ms `expiresAt` / `refreshTokenExpiresAt`, so every Claude credential ranked as “no expiry stated” = permanently valid, ranked by mtime alone. Fix: teach the rank both encodings and the refresh window; **`reconcileWorkspaceClaudeAuth`** (harvest → promote → re-symlink **every** eligible home) on materialize and on a throttled agent-list tick; **`claudeCredentialState`** grading projection (`linked`/`detached`/`absent`/`foreign`) and health (`valid`/`refreshable`/`expired`/`unreadable`) as separate axes; **`assertUsableClaudeAuth`** refusing a genuinely dead session at the harness boundary with a named recovery. Account isolation is explicit: a home whose `.claude.json` names a different `oauthAccount` — or whose credential links to another authority — is neither harvested from nor relinked. **✓** unit `test/unit/harness.test.ts` (t-9598cc).  
**Parity lesson:** measuring only “symlink exists on first materialize” / “Bridge MCP tools list” is **not** enough for harness auth. A first-class private home also requires **auth survives rematerialize after in-home login** (or an explicit `~` with a task) **and** **in-session refresh is harvested without waiting for stop** — and, per t-9598cc, that the reconcile reaches **every** private home rather than only the one being materialized, that a **global** re-login propagates outward, and that the credential-freshness parser actually understands **that runtime's** expiry encoding. A runtime marked ✓ for “harness / private home” is not thereby ✓ for auth refresh; they are separate rows now.

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

| Runtime | Brief | Resume | Bridge | Harness | Activity | Native config | Ad-hoc Agent (17) | Notes |
|---------|:-----:|:------:|:------:|:-------:|:--------:|:-------------:|:-----------------:|-------|
| Gemini | ✓ (`-i`) | ✓ adapter | — | — | — | ✗ | ~ | Thin overall. Admitted ad-hoc, but with no Bridge it cannot answer the delegation it receives (`t-59f67c`) |
| Antigravity | ✓ (`--prompt-interactive`) | ✓ (`--conversation` / `--continue`) | — | — | — | ✗ | ✗ | Thin overall. Never was an ad-hoc agent — absent from `KNOWN_AI_CLIS`, so the old inference already produced a Terminal |
| Qwen | — | ✓ (`--continue` style) | — | — | — | ✗ | ~ | Thin. Admitted ad-hoc, but receives neither the brief nor a way to report (`t-59f67c`) |
| Continue | — | ✓ (`--resume <id>`) | — | — | — | ✗ | ✗ | Thin (not “no resume”). Never was an ad-hoc agent, same reason as Antigravity |
| Hermes | ✓ (`HERMES_TUI_QUERY` + forced TUI) | ✓ adapter + live session follow (`--resume`/`-c`) | ✓ (`HERMES_HOME` + `config.yaml` MCP) | ✓ (isolated MCP set; optional auth; hooks rejected) | ✓ (`state.db`, timestamp/model, bounded backfill) | ✗ | ✓ | Operational inheritance exists, but canonical policy/inspector does not. Hardened seams: 2026-07-16 (`agentManager`, `harness`, `resume`, `hermesStorageReader`). No fork or permission reader. Detail: [`hermes.md`](./hermes.md). |

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
| **A. Known basename, thin / no family adapters** | `aider`, `goose`, `amp`, `cursor-agent`, `copilot`, `verboo` (in `KNOWN_AI_CLIS` as authoring suggestions) but **not** in `ResumeRuntime` / `RUNTIME_BY_BIN` | **`spawn_agent` refuses them** (SDD 478 M9): a quick-add chip is not evidence Tachyon can operate something, and they have no resume/brief/Bridge path. They run as Terminals via `spawn_terminal`. A human authoring by hand still sees `agent` PRE-SELECTED for them, and can override it |
| **B. Renamed binary / path alias** | `~/bin/my-claude`, `claude-custom` if basename ≠ catalog | Basename-driven selection fails → treated as unknown CLI |
| **C. Shell wrappers** | `bash -lc '…'`, custom scripts that hide the real binary | Opening-prompt + adapters **do not** unwrap; `openingPromptCapability` → `unsupported` |
| **D. Package launchers** | `npx …`, `bunx …`, `pnpx …`, `env VAR=… cmd` | `resolveBinary` / `resolveRuntimeBinary` may recover a basename when the launcher shape is recognized; otherwise Outros |
| **E. Completely unknown CLI declared under `agents:`** | `my-bot --serve` with explicit `kind: agent` or inferred agent | Spawned as a managed pane; no family wiring |
| **F. Terminals** | `agents:` entries inferred/forced **terminal** (servers, shells, builds) | Lifecycle yes; AI product seams no (by design) |

**Not Outros:** Gemini / Antigravity / Qwen / Continue / Hermes — those are **secondary** (§3.3): partial adapters exist; promote by walking §2, not by inventing a fake “generic Claude.”

#### 3.5.2 Classification contract (code → product language)

| Mechanism | Seam | Outros behavior |
|-----------|------|-----------------|
| Kind **suggestion** (authoring only) | `suggestKindForCommand` / `KNOWN_AI_CLIS` | Basename in the list → **pre-selects** agent (attention on) for a human who can override it; else terminal. Explicit `kind:` wins. Since SDD 478 M4 this never decides a stored entity. |
| Kind **admission** (entity creation) | `admitAdhocAgentCommand` / `SUPPORTED_ADHOC_AGENT_RUNTIMES` | `spawn_agent` admits only a declared runtime; every other command — including bucket A/B/C names — is refused and named to `spawn_terminal` (§3.6.1) |
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

### 3.6 Ad-hoc spawn parity

**Purpose:** parented **Ad-hoc** AI children (`spawn_agent` with `cmd`, not declared in `tachyon.yml`) share the same runtime profile isolation key as declared agents, but their **auto-isolation and Bridge home wiring differ**. The summary table (§3.1) and harness axis (§3.4) alone hide that.

**Seams:** `AgentManager` spawn (auto `isolate: "transcript"`, `assertVerifiedTranscriptIsolation` when `parent && kind === "agent" && !harness`), `withRuntimeBridge`, `runtimeProfile.*.isolation`.

**Verified:** 2026-07-26 · Grok CLI **0.2.112** · research [`adhoc-runtime-parity-grok.md`](../research/adhoc-runtime-parity-grok.md) · task `t-1d49df`.

| Runtime | Profile isolation | Ad-hoc auto `isolate:transcript` | Bridge private surface | Parented ad-hoc **without** worktree |
|---------|-------------------|----------------------------------|------------------------|--------------------------------------|
| Claude | mint ✓ | yes (`ResumeAdapter.harness`) | `--mcp-config` file | **allow** |
| Codex | private-home ✓ | yes (`ResumeAdapter.harness`) | private `CODEX_HOME` family | **allow** |
| OpenCode | private-home ✓ | yes (`ResumeAdapter.harness`) | `OPENCODE_CONFIG` | **allow** (t-e2ebe3) |
| Grok | **project-scoped** ✓ | **no** (t-303f2b — reuse Bridge `GROK_HOME`, avoid dual-home auth race) | `GROK_HOME` only (**not** `HOME`) | **refuse** — worktree / harness / registered worktree cwd |
| Pi | private-home ✓ | **no** (`ResumeAdapter.pi` has **no** `harness` — auto-isolate never fires) | profile `private-home` → `materializeRuntimeHarness` / `materializePiHomeOnly` (`PI_CODING_AGENT_*`) + Bridge extension | **allow** |
| Hermes | private-home ✓ | no (Bridge `HERMES_HOME`) | `HERMES_HOME` | **allow** |

**Pi ad-hoc note (code of record):** do not describe Pi auto-isolation as “adapter
harness.” Private agent/session dirs come from verified profile
`isolation.mechanism === "private-home"` driving `AgentManager.materializeRuntimeHarness`
and `Workspace` → `HarnessManager.materializePiHomeOnly` / `materializePiHome`
(SDD 401/406). Opt-in `def.harness` only layers exact resource snapshots; it is
not `ResumeAdapter.harness`.

**Grok ad-hoc attention (`t-4e6ba5`, closes the gap `t-1d49df` journalled):** a parented ad-hoc Grok
that hits its native tool-authorization modal used to stay `attention: working` — no coordinator
notification, and `write_input(answering=true)` refused as busy, so the only way through was polling
and typing straight into tmux. Measured on grok 0.2.112: the modal shares no signature with any base
rule (`1 (●)` has no period, so base's `❯\s*\d+\.` misses it) **and** the pane keeps animating while
it waits, which is what held it in `working`. `manifests/grok.json` — the first measured per-runtime
overlay — matches the modal at the bottom of the tail, where a recognized prompt outranks
content-change classification. Answering stays entirely human/coordinator work: the highlighted
option is session state (a first prompt highlights `1`, which is `always-approve`; after answering
`2` the next prompt arrives with `2 (●)`), so an answer must always name its digit and Tachyon ships
no path that answers on its own.

**Grok ad-hoc ruling (do not weaken without new measurement):**

1. `GROK_HOME` **does** isolate sessions/config from ambient `~/.grok` (dual-home
   live `-p` proof; sanitized layout + protocol in research appendix, 2026-07-26).
2. Without co-binding `HOME`, Grok **still loads** `$HOME/.claude/settings.json`
   (`grok inspect --json` → `permissions.sources` / `loaded: 1`; cleared when
   `HOME=GROK_HOME` co-bound — research M1).
3. Canonical-only `HOME`+`GROK_HOME` co-bind (SDD 456) is **not** the ad-hoc path; runtime-wide profile therefore stays **project-scoped**, and parented non-harness ad-hoc correctly requires an isolated worktree.
4. Explicit `--model …` refusals on Grok were a **separate** gap (not isolation), closed by `t-85c586`: `grok models` is now an authoritative preflight catalog.

5. **Canonical Grok keeps the operator's git identity (`t-076a28`).** The co-bind hid `~/.gitconfig`
   from everything the agent shells out to, so a canonical Grok agent could not commit at all
   ("Author identity unknown"). Its private home is now seeded with a `.gitconfig` that `[include]`s
   the operator's real global config — an include, not a copy, so an identity change is picked up
   live. Measured: `grok inspect --json` stays at `loaded: 0`, so the permission isolation is
   untouched. **SSH is unaffected and needs nothing**: OpenSSH resolves `~` for identity files from
   the passwd database rather than `$HOME`, so a private-`HOME` agent still offers the operator's
   real key (measured with no ssh-agent). Nothing else from the real `HOME` is re-exposed.
6. **The `HOME` co-bind was measured for ad-hoc (`t-50fe1d`, 2026-07-26) and the rating did NOT move.**
   Co-binding closes the ambient permission read (`loaded: 1` → `loaded: 0`) and keeps auth and
   sessions private — but a co-bound `HOME` is the agent's `HOME` for everything it shells out to,
   and `git commit` then fails with "Author identity unknown" (no `~/.gitconfig`, no `.ssh`).
   Seeding the private home with a `.gitconfig` that `[include]`s the operator's real one restores
   commits while keeping `loaded: 0`. So the reclassification is blocked on a product decision, not
   on more evidence — see research §M4. The same co-bind already ships for CANONICAL Grok, where it
   has the same cost unmitigated (filed separately).

Remedies for parented Grok ad-hoc today: `worktree: true`, gated delegation into a registered Tachyon worktree, or harness / non-parented top-level spawn. Code changes that reclassify isolation or bind `HOME` for ad-hoc belong in follow-up tasks — not silent gate weakening.

#### 3.6.1 Which runtimes the ad-hoc door admits, and on what evidence

**Purpose:** §3.6 above answers *how* an admitted ad-hoc child is isolated. This answers the prior
question — *which commands may become one at all*, and which are Terminals. Before SDD 478 M9 the
answer was inferred from the command string (`KNOWN_AI_CLIS` → agent, else terminal), so `spawn_agent`
could hand a shell a task, a lineage, a brief and a worktree.

**Capability of record:** `SUPPORTED_ADHOC_AGENT_RUNTIMES` in `src/agents/adhocAdmission.ts`. Verified
2026-07-27 · task `t-8f3f7d`.

**This is not canonical attestation, and the two must not be merged.** `ATTESTED_RUNTIMES` answers
"may this back a canonical profile"; this list answers "can Tachyon hand this a delegation and get an
answer back". Every attested runtime is in this list; the reverse is deliberately false. Using the
canonical bar here would have removed OpenCode, Hermes, Gemini and Qwen as agents everywhere —
`agents:` already admits only attested executables, so the ad-hoc path is their only door — orphaning
measured resume adapters, private homes, activity readers, attention manifests and OpenCode's
credential preflight. `test/unit/adhocAdmission.test.ts` asserts the relation in **both** directions,
so the lists cannot quietly converge.

**What each column is measured against:** *Resume* = an entry in `ADAPTERS` (`src/resume/adapters.ts`),
so the child survives restart/resume as the same entity. *Brief* = a channel `instructionsDeliverable`
recognizes, so the spec 246 contract can reach it. *Bridge* = a branch in
`AgentManager.withRuntimeBridge`, so it can answer with `notify_agent` and the task tools; every other
binary lands on `{ wired: false }` (§3.5.2).

| Runtime | Canonical profile | Resume | Brief channel | Bridge | Ad-hoc Agent | Declared gap |
|---|:---:|:---:|---|---|:---:|---|
| Claude | ✓ | ✓ | startup argument | `--mcp-config` file | **✓ full** | — |
| Codex | ✓ | ✓ | startup argument | `-c mcp_servers.tachyon_bridge` | **✓ full** | — |
| Grok | ✓ | ✓ | startup argument | private `GROK_HOME` | **✓ full** | — |
| Pi | ✓ | ✓ | startup argument | staged Pi Bridge extension | **✓ full** | — |
| OpenCode | ✗ | ✓ | TUI prefill (`--prompt`) | `OPENCODE_CONFIG` | **✓ full** | — |
| Hermes | ✗ | ✓ | `HERMES_TUI_QUERY` env | private `HERMES_HOME` | **✓ full** | — |
| Gemini | ✗ | ✓ | startup argument (`-i`) | **none** | **~ partial** | receives the contract, cannot answer it — no `notify_agent`, no task tools (`t-59f67c`) |
| Qwen | ✗ | ✓ | **none** | **none** | **~ partial** | receives neither the contract nor a way to report on it (`t-59f67c`) |
| Antigravity, Continue | ✗ | ✓ | — | none | **✗ Terminal** | none — they were never ad-hoc agents (absent from `KNOWN_AI_CLIS`, so the old inference already produced Terminals) |
| `aider`, `goose`, `amp`, `cursor-agent`, `copilot`, `verboo`, `agy` | ✗ | ✗ | — | none | **✗ Terminal** | none — authoring-catalog names with no adapter of any kind |
| Everything else (`sh`, servers, builds, renamed binaries, wrappers) | ✗ | ✗ | — | none | **✗ Terminal** | — |

Gemini and Qwen are admitted **on purpose**. Removing a working capability inside a boundary migration
would be decision by negation; the shortfall is written into their capability entries and owned by a
task instead. Read the `~` as "Tachyon will start it and hand it the delegation it can take, and the
operator should not expect a completion signal".

**The Terminal half is explicit, not a fallback.** `spawn_terminal` (Bridge) starts any command
verbatim and has exactly three parameters — `name`, `cmd`, `cwd`. There is no parameter for a task, a
lineage, a brief, a worktree or a delegation gate, so the agent-only capabilities of §3.1 are
unrepresentable on it rather than validated away. A refusal from `spawn_agent` always names it.

**Two doors are deliberately outside this rule**, because each has its own measured contract:
`delivery_join` runs an unrecognized reviewer runtime with an advisory (SDD 368 T10), and pipeline
inline `cmd:` nodes accept both kinds by design with nowhere in `pipelines:` to declare which
(`t-c003e1`).

**Evidence:** `test/unit/adhocAdmission.test.ts` (31 cases — admission, launcher resolution, refusal
text, the declaration-vs-code agreement, and both directions of the attested relation); door cases in
`test/unit/bridge.test.ts` and `test/unit/agentManager.test.ts`; and
`npm run dogfood:adhoc-agent-boundary`, which drives the installed CLIs so the declaration cannot rot
unnoticed — 13/13 on 2026-07-27 against claude 2.1.220, codex-cli 0.145.0, grok 0.2.112, pi 0.80.10,
opencode 1.18.5 and Hermes 0.18.2. Gemini and Qwen were absent on that machine and are reported as
skipped rather than passed, because absence is not evidence about a runtime.

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
| ~~Grok isolation / ad-hoc worktree gate~~ | **Documented `t-1d49df`** — keep runtime-wide **project-scoped**; parented ad-hoc refuse without worktree is correct while ad-hoc binds only `GROK_HOME` (ambient `$HOME/.claude/settings.json` still loads). Reclassification requires ad-hoc `HOME` co-bind (or narrower context) as a **code** follow-up — see §3.6 + research note |
| Grok ad-hoc `HOME` co-bind (optional product) | If parented ad-hoc Grok should run without worktrees: bind `HOME` to Bridge private home on non-canonical path, re-measure, then consider profile `private-home` without lying about bare `cmd: grok` |
| ~~Grok model-catalog launch preflight~~ | **Closed `t-85c586`** — `GrokLaunchPreflight` under `src/runtime/adapters/`; `grok models` is authoritative because the CLI refuses anything it does not list (measured both directions on 0.2.112), so a pin is `supported`/`unsupported`, not `unverifiable` |
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
| [`docs/research/adhoc-runtime-parity-grok.md`](../research/adhoc-runtime-parity-grok.md) | Ad-hoc spawn isolation parity; Grok 0.2.112 measurements (`t-1d49df`) |
| `src/runtime/runtimeProfile.ts` | Machine-readable profile fragments |
| `src/resume/adapters.ts` | Resume/fork/harness descriptors |
| `.tachyon/reviews/parity-doc-claude.md` | 2026-07-09 adversarial review |
| `.tachyon/reviews/parity-doc-codex.md` | 2026-07-09 adversarial review |

---

## 7. Changelog (doc only)

| Date | Change |
|------|--------|
| 2026-07-28 | **A canonical Grok fork now carries its own home and the source session (`t-ee5c05`):** `t-26f508` refused the operation rather than ship a degraded sibling; this closes it. Grok joins Pi and Claude in `managedPrivateFork`, with its private home read from `bridgeGrokHome` rather than `harnessHome` — the wrong one there would silently disable the partial-home cleanup, because nothing is ever created at the path it watches. `profileFork` joins the Workspace materializer gate for the same reason it already does on the Claude branch: a fork deliberately does not inherit `profileLifecycle` authority, so keying only on that hands the fork an unprojected home. The load-bearing finding is the transcript. Claude's session is one self-contained JSONL, so `spec 225` seeding copies the file `transcriptPath` names; Grok's is not, and copying that file produces a fork the runtime cannot see. Measured on 0.2.112: a session directory seeded with ONLY `chat_history.jsonl` returned "Session not found" from `grok export` and did not appear in `grok sessions list`; bisecting the directory showed `summary.json` alone restores listing, `summary.json` + `updates.jsonl` restores export byte-identically to the source home (642 bytes), and `chat_history.jsonl` is required for NEITHER — it is what Tachyon's own Activity reader tails, not what the runtime restores from. Adapters therefore declare a `transcriptUnit`, and Grok declares `session-directory`; the seeder copies the directory's regular files, skipping `*.lock` (a lock asserts a claim by the process that held it in the SOURCE home) and subdirectories (Grok keeps `recap_requests/` beside the session files), and still fails closed when nothing lands. Also fixed here: `withRuntimeBridge` now reuses the private `GROK_HOME` that `applyHarness` already materialized. Grok is the one runtime whose Bridge wiring rewrites the same file the canonical materializer owns — harmless for a declared agent because `t-26f508` made both option sets identical, but a fork is not in `config.agents`, so the port could not see the profile and the second write would have erased the projection and the exact-trust store. The lifecycle tuple gains `fork`, and the three-phase tuple `t-26f508` authored stays admitted: an unsupported family fails the WHOLE config, so refusing it would stop the entire roster, and the older tuple claims LESS than the runtime now does. Evidence: fork projection/seeding/HOME in `agentManager.test.ts`, lifecycle compatibility in `grokNativeConfigProjection.test.ts`. Not measured here: a live TUI fork of a canonical Grok agent — the seeding was verified with `grok sessions list` / `grok export` against a foreign home and cwd, which is the resolver's own answer, but no interactive fork was run. |
| 2026-07-28 | **Grok Runtime Config (SDD 481 / `t-ce83a2`):** Control's third measured adapter, and the first whose IMPACT rule differs from the others. Measured on `grok 0.2.112`: `<workspace>/.grok/config.toml` is discovered from the working directory, so it reaches a live agent even under a private `GROK_HOME` and marks live Grok agents pending regardless of profile. The global document's reach depends on the agent — and this is the one claim the slice had to CORRECT before landing: it originally recorded that the global file reached no managed agent (true when measured, because every Grok agent launched Bridge-only), and `t-26f508` landed mid-slice giving canonical Grok profiles a projection from `~/.grok/config.toml`. The adapter's impact sentence, the pending rule and the tests were corrected on merge, and both directions are now pinned: a canonical profile is marked for the global source, a profile-less agent is not. Three independently versioned documents: global config (nine measured scalars, including the two numeric ones the shared envelope gained for this), workspace config (**no scalar editor at all** — Grok honors only `[mcp_servers]` in project scope, so an editor there would write keys the runtime ignores) and read-only folder trust (the switch that decides whether `.grok/hooks/` executes; Control reports it and refuses to grant it). MCP enable/disable uses Grok's own `enabled` field rather than the commented-block marker Codex needs, verified by round-trip: a server Control disables disappears from `grok inspect --json` and reappears when re-enabled. Permission/approval keys (`ui.permission_mode`, `features.support_permission`, `ui.yolo`) are shown read-only with a stated reason — hiding them would make Control less honest than the file, and writing them would move an authority decision out of the runtime's own consent flow. CAS is the strict digest of the raw text (not Codex's state-excluding digest), because Grok rewrites its own config, so a concurrent edit must conflict rather than be overwritten. Also measured and recorded: `grok inspect` misattributes project MCP servers to the global config path, so provenance is read from the files; and project hooks need a git `projectRoot`, while project MCP does not. Evidence: `npm run dogfood:grok-runtime-config` (15/15 against the installed binary), `test/unit/grokRuntimeConfigInventory.test.ts` (10), the pending rule in `test/unit/nativeConfigSources.test.ts`, and `test/browser/grokRuntimeConfigView.test.ts` (6, headless Chrome). The UI half is proven in a browser rather than a Dev Host because opening VS Code / an EDH is a human-only action here; the save path is therefore proven host-side and against the binary, not through the UI. |
| 2026-07-28 | **Canonical Grok stopped being Bridge-only (`t-26f508`):** the private `GROK_HOME` held a `config.toml` containing one MCP server, so the agent was isolated and behaviorally naked — the person's model, approval posture, TUI preferences and telemetry choice all reset to Grok's built-in defaults. Grok now has a per-family policy (`selectors`/`permissions`/`interface`/`featureFlags` projected; `tooling`/`memory`/`authentication` declared as refusals), a closed projector over `~/.grok/config.toml` and a deterministic renderer, with the same fail-closed discipline as Claude/Codex: unmeasured values are refused by name with the family to exclude, and `always-approve`/`bypassPermissions`/`yolo = true` are omitted with a warning unless the profile carries `authorize: [alwaysApprove]`. Three measurements shaped the design rather than decorating it. (1) **`workspace` is not a source.** `grok inspect --json` on 0.2.112 shows a project `.grok/config.toml` loading as a `project` layer whose `[ui]` keys are ignored and whose `[permission]` block left `permissions.loaded` at 0 — so Studio offers only `global`, and `resolveAgentNativeConfigSupport` refuses a workspace policy instead of letting someone author one the runtime ignores. (2) **Redirecting `GROK_HOME` does not stop project discovery.** The same project layer's `[mcp_servers.ambient]` DID reach the effective server list under a private home, so ambient `.grok/*` and `AGENTS.md` are now inspector-refused like Claude's roots — and a project `.claude/skills/*` was discovered and `"enabled"` in a private home, which is why every `[compat.*]` cell is pinned off unconditionally (the same skill then reports `compatibilityStatus: "disabled"`, 13/13 cells off, Bridge intact). (3) **Fork is refused rather than declared.** Grok has a native `--fork-session`, but `commitFork`'s `managedPrivateFork` covers only Pi and Claude, so a canonical Grok fork would spawn against a fresh `bridge-mcp/<fork>.grok` holding neither the projection nor the source transcript — `--resume <id> --fork-session` would find nothing. The lifecycle is therefore `fresh`/`restart`/`resume` and `planFork` refuses by name; listing `fork` would have been the cheaper claim and the false one. Inspector bumped to v2 because the contract text really changed — and the bump came with a supersession lane, because review showed the first justification ("no canonical Grok agent exists yet") was a fact about this dogfood workspace, not about an installed base that has been able to create one all along. The failure a bump causes is not scoped to the stale agent: `loadProfileAwareConfig` returns `{errors}` for the WHOLE config, so one stale Grok authority stops every agent of every runtime in that workspace from loading, and nothing repairs it in-product because `authorityFor` copies `prior.runtimeInspector` on every edit. `SUPERSEDED_RUNTIME_INSPECTORS` therefore names the v1 sha explicitly: an authority carrying it still loads, the CURRENT (stricter) checks still run, and the attestation carries the descriptor the human actually authorized so `assertNativeAttestation`'s exact match keeps holding. `authorityFor` adopts the current inspector on the next lifecycle transaction, which is where re-attestation belongs. Acceptance is per named sha, under a rule stated over REACHABLE states rather than over the two contract strings: a pair is admissible only when, for every authority that can legitimately name the old descriptor, the current build is at least as strict. That distinction is load-bearing here and a second review caught it — v2 is equal or stricter than v1 on every line except one (v1 promised ambient `~/.grok` config/memory/plugins are not inherited *absolutely*; v2 promises it of *unselected* config), and that line is unreachable only because no Grok native-config policy existed before this change, so a v1-era profile can carry no selection and the first transaction able to add one is the same one that adopts v2. Safe by chronology, not by superset — which is exactly why the rule is written this way, so a future pair whose weaker line IS reachable stays out. Evidence: `test/unit/grokNativeConfigProjection.test.ts` (15), private-home lifecycle in `harness.test.ts`, fresh/restart/resume + fork refusal in `agentManager.test.ts`, projection + ambient refusal + superseded-authority load in `agentProfileConfigLoader.test.ts`, inspector adoption in `agentProfileLifecycle.test.ts`, Studio source/authorization in `agentStudioAdapter.test.ts`. Not measured here: whether the projected `[permission]` rules change live approval behavior in a TUI turn — `grok inspect` reports the rule COUNT, not an enforcement trace, and proving enforcement needs an authorized model call. |
| 2026-07-28 | **A canonical Claude agent kept its isolation and lost its status line (`t-af504e`):** the exact failure §3.1.1 opens with, reproduced on the runtime that motivated the row. `CLAUDE_CONFIG_DIR` plus `--setting-sources user` makes the private `settings.json` the ONLY user source, and `statusLine` was in no scalar family — so the person's own status line never arrived, while Codex, holding an identical authored policy (`interface: {source: global, treatment: overlay, refresh: every-launch}`), inherited `tui.status_line` and rendered it. Measured on the dogfood workspace: `~/.codex/config.toml` → `.tachyon/harness/codex-canonico/config.toml` carried the widget list verbatim; `~/.claude/settings.json` → `.tachyon/harness/claude/settings.json` carried nothing. The bar was not merely empty either — the observability capture wrapper occupies the `statusLine` slot on every Claude spawn and had `priorCommand: null` to wrap, so the host was rendering an empty line rather than leaving the setting untouched (relays on the same host show the person's real command for launches against the default `~/.claude`). `statusLine` now joins the Interface family, held to the exact shape the capture transport can wrap — `statusLineRejection` mirrors that parser's bounds deliberately, because a value the projector accepted and the parser refused would cost the agent BOTH its status line and its rate-limit capture with no diagnosis. Projected from whichever source the family selects, matching the Codex posture rather than inventing a Claude-only gate; refusals name the offending subkey (`statusLine.padding` …) like the permissions path. The attestation contract is unchanged: "scalar settings" names the scalar FAMILIES (`permissions`/`interface`/`featureFlags`), and `permissions` was already an object, so no inspector bump — which matters, since `authorityFor` preserves a prior inspector on edit and a bump would refuse every existing canonical Claude agent with no migration lane. Evidence: `test/unit/agentProfileConfigLoader.test.ts` (projection from global and workspace, five named subkey refusals). Not measured here: which of the two `--settings` files wins when both declare `statusLine` — the wrapper is passed last and is expected to win, but that ordering is a live-TUI behavior no unit test observes. |
| 2026-07-27 | **The ad-hoc door declares which runtimes may become Agents (`t-8f3f7d`, SDD 478 M9):** `spawn_agent` used to take any command and let `KNOWN_AI_CLIS` decide the outcome — a catalog name became an Agent, everything else became a Terminal — so the Bridge could hand a shell a task, a lineage, a brief and a worktree, and the tool named for agents could not guarantee it had produced one. Admission is now a declared capability (`SUPPORTED_ADHOC_AGENT_RUNTIMES`) matched against the RESOLVED executable, through the same launcher-aware parse the launch preflight uses: `env`/`npx`/absolute paths resolve, and shell composition is refused rather than guessed at, because a Terminal runs a command verbatim while an Agent's identity depends on which runtime actually starts. New capability row 17 and §3.6.1 record the per-runtime evidence: **full** ad-hoc support for claude/codex/grok/pi/opencode/hermes (resume + brief + Bridge), **partial** for gemini (no Bridge — it receives the delegation and cannot answer) and qwen (neither), both admitted deliberately with the gap owned by `t-59f67c` rather than removed by negation. The list is NOT `ATTESTED_RUNTIMES` and a test asserts both directions: the canonical bar would have deleted OpenCode, Hermes, Gemini and Qwen as agents everywhere, since `agents:` already admits only attested executables. The Terminal half is explicit — `spawn_terminal` takes `name`/`cmd`/`cwd` and has no parameter for a task, lineage, brief, worktree or gate, so agent capabilities are unrepresentable on it rather than validated away, and every refusal names it. Also corrected here: §3.5.1 bucket A and §3.5.2 no longer claim `inferKind` promotes `aider`/`goose`/`amp`/`cursor-agent`/`copilot`/`verboo` to agents — they are refused, and the surviving helper is an authoring suggestion a human can override. Evidence: `test/unit/adhocAdmission.test.ts` (31), door cases in `bridge.test.ts` and `agentManager.test.ts`, and `npm run dogfood:adhoc-agent-boundary` (13/13 against the installed CLIs; it found that `opencode --help` writes its usage to stderr and exits 0, so a stdout-only probe reported a flag missing that is still there). |
| 2026-07-27 | **Tachyon's own notice was read back as a human draft (`t-6ffa13`):** reported as "the post-turn suggestion blocks notifications", and the measurement said otherwise. Captured on the live `claude-opus5` pane (Claude Code 2.1.220): the post-turn suggestion — including a LOCALIZED one, `\x1b[39m❯\u00a0\x1b[2mFinalize t-18f6a5 quando o full terminar; permaneça aberto.\x1b[0m` — already classified as EMPTY, as did the startup placeholder (which is dim per WORD, with `\x1b[0m` between them) and the empty composer in both the 16-colour and 256-colour themes. What occupied the composer was the runtime's echo of an ALREADY-SUBMITTED message: `\x1b[38;5;239m\x1b[48;5;237m❯ \x1b[38;5;231m[tachyon] task ... assigned to you\x1b[39m`. `findComposerRegion` picks the LAST `promptLine` match in the tail window, so whenever the echo was the last one, an already-sent message became the "editable region". The echo is normally TACHYON'S OWN notice, which makes it a loop Tachyon feeds itself: notify_agent submits → the runtime echoes → the echo reads as a draft → later notify_agent calls queue (`deliverNotice`) and write_input refuses (`refused-composer`) → the pane goes quiet, and occupancy only recomputes on content change, so it never recovers. Fix is region selection only: a new measured `ansiHistoryEchoStyle: "prompt-background"` excludes echoes from being chosen as the composer. The discriminator is ANSI, not text — the echo paints its glyph with a background colour and the live editor never carries one in any state. A first attempt keyed on the U+00A0 separator instead (the live composer uses it, the echo an ordinary space) and was rejected by the cross-runtime behaviour suite: it also swallowed an UNSTYLED `> existing draft`, which is the permissive direction. Keying on the background fails closed instead — a plain capture has no background to read, so the line keeps counting as the composer and injection is still refused. Declared for Claude only; a typed draft still blocks and the dim-suggestion rule is untouched. Evidence: `test/unit/claudeComposerHistoryEcho.test.ts` (11 tests on the captured bytes) with `claudeComposerSuggestion`/`composerDimTruecolor` green. |
| 2026-07-27 | **OpenCode's silent fallback is closed at the launch boundary (`t-0338fc`, SDD 477):** OpenCode was row 16's only `✗` — with no credential it does not error, it answers on the fallback model `big-pickle`, so an agent could look perfectly healthy while running a model the operator never chose. Three candidate signals were measured on 1.18.5 before one was chosen, and two were rejected by measurement rather than by preference: `run --format json` emits `step_start`/`text`/`step_finish` with **no model field at all** (the effective model surfaces only in session storage, *after* the turn has run), and an explicit `-m` pin does **not** degrade — it fails outright, so the silent fallback is specific to the unpinned default path, which is exactly how Tachyon launches. The signal that works is the runtime's own credential store: `opencode providers list` reports `└  0 credentials` on an empty private home, lists each provider on a real one, and reports environment-provided keys as their own section — covering BOTH of OpenCode's authentication paths. `OpencodeLaunchPreflight` consumes it and refuses the launch, surfacing the same human sentence a transcript-detected signal produces (naming agent, runtime and the safe action, carrying only a count). Nothing was inferred from silence, latency or cost: `RUNTIME_AUTH_PROFILES` still declares no OpenCode matcher, because a credential-free turn genuinely looks like work. Row 16 moves `✗` → `~`, held there by two honest bounds: the probe proves a credential is **readable**, not valid, and it fires only before launch, so a mid-run expiry is still undetected. The gate fails **closed** on an unreadable probe — justified narrowly by measuring that the read is local (it works from a cold private home with the network black-holed, under a second), so a failure means a broken environment rather than a flaky network. Evidence: `npm run dogfood:auth-required-parity` (10/10 against the real CLIs, now driving the gate both ways — credential-free home refused, the operator's own home admitted) plus `test/unit/opencodeLaunchPreflight.test.ts` (21 tests on the captured bytes). |
| 2026-07-27 | **The auth-required AGENT STATE, and the hold that goes with it (`t-5bfb72`, SDD 477 increment 3):** increment 2 stopped a LAUNCH that failed to authenticate; a live agent that lost its login mid-run was still read as ordinary idleness — the original incident. `AgentAttention.authRequired` now latches from the same declared matchers read against the running pane, and carries the measured evidence so every consumer names the runtime and the human action without re-deriving them. It is an independent latch, not a new attention state: the row still reads `idle`, and the badge is what tells "finished" apart from "cannot start another turn". The hold is both of Tachyon's automatic re-entry paths — the crash-restart policy is forced to `never` and rate-limit auto-continue is cancelled rather than scheduled — while assignment is left untouched, so the task simply stays where it was. Recovery needed no new API: the latch releases on the first genuine new-turn edge, which an unauthenticated runtime cannot produce, so a restart that works clears the hold and a restart into a still-broken login re-latches. Two limits are declared rather than papered over: the live read matches the wording a runtime writes into the TRANSCRIPT, not the interactive sign-in screens measured for Codex and Grok; and because no genuinely expired credential has been observed rendering live, the read is gated to the last 12 non-empty lines of a pane that has already gone quiet — enough that Claude's false-positive footer, and an agent merely READING these strings (this repository stores all of them verbatim), can never park anything. Evidence: `test/unit/attention.test.ts` (8 new tests incl. the working-agent-reading-the-fixtures case and the restart-suppression composition), `test/unit/authRequired.test.ts` (scrollback window), sidebar preview fixture `auth-required`. |
| 2026-07-27 | **Auth-required detection implemented for the measured runtimes (`t-16cd93`, SDD 477 increment 2):** `src/runtime/authRequired.ts` declares a per-runtime matcher with the version it was measured on, and the launch boundary now attaches the human action to an authentication rejection — the agent's failure names the runtime and what to do, and states that Tachyon will not retry or restart it automatically. There is deliberately NO shared fallback regex: absence of a profile is a declaration, which is why OpenCode can never be reported auth-required. Two negative properties are pinned by tests because they are the ways this feature could do harm: Claude's bare TUI footer `Not logged in · Run /login` must NOT match (measured on a fully functional agent mid-task — matching it would park healthy agents), and rate limit, quota, permission, network and invalid-session failures are excluded before any matcher runs, so "stuck" never collapses into "log in again". Evidence: `npm run dogfood:auth-required-parity` (7/7 against the real CLIs, re-deriving every signal from credential-free homes and re-confirming OpenCode's silence) plus `test/unit/authRequired.test.ts` (24 tests). |
| 2026-07-27 | **Authentication / loss-of-session measured across the fleet (`t-16cd93`, SDD 477):** an agent lost its provider login mid-run and Tachyon read it as ordinary idleness — a coordinator could keep assigning work and restarting forever. Capability row 16 and §3.7 now record, per runtime, the auth mechanism, the MEASURED unauthenticated signal, whether an official non-interactive refresh exists, the human action and the recovery path. Claude/Codex/Grok/Pi/Hermes all emit a usable signal (structured JSON for the first three); **OpenCode emits none** — it silently answers on the fallback model `big-pickle`, so an agent can look healthy while running a model nobody chose. Also measured and load-bearing: Claude's TUI footer `Not logged in · Run /login` appeared on a fully functional agent mid-task, so a pane detector keyed on it would park healthy agents — the trustworthy Claude signal is turn-attached. All six are `~` (measured, not yet consumed) pending the SDD 477 implementation. |
| 2026-07-26 | **Codex probes work outside a git repository (`t-7cc65e`):** a probe answers a bounded question wherever its caller happens to be, but `codex exec` refused a non-repo cwd outright — *"Not inside a trusted directory and --skip-git-repo-check was not specified"*, exit 1, no JSON events and no artifact, which the adapter honestly mapped to `process_error`. The same question answered fine on Claude (`result: ok`) and Grok in the same directory, so this was pure fleet asymmetry: only Codex failed, and for a directory-trust check rather than anything about the probe. The adapter now passes `--skip-git-repo-check`. Measured that this does NOT widen the probe's boundary: with the flag AND `--sandbox read-only`, a write request came back refused (`BLOCKED`) and no file was created — the sandbox is the boundary, and directory trust is already Tachyon's own since SDD 476 gave each run a private `CODEX_HOME` with a seeded trusted-folder store. Evidence: `npm run dogfood:probe-codex-model-proof` (11/11, now including a probe launched from a non-repo dir). |
| 2026-07-26 | **Peer composers measured post-turn; extended-colour dim bug fixed (`t-3eaa8b`):** `t-c5f29b` left the peers measured only at startup, which was a weak negative — the Claude incident's suggestion appeared AFTER a turn. Captured grok 0.2.112, opencode 1.18.4/1.18.5, pi 0.80.10 and hermes 0.18.2 in three states each (empty composer, human-typed draft, completed real turn): **none renders suggestion text in the composer in any state**, so none declares `ansiEmptyContentStyle` — with nothing to exempt, declaring it would only weaken a real draft's protection. The measurement did surface a defect in the SHARED rule: the dim parser scanned each escape's parameters as a set looking for `2`, but SGR 38/48/58 introduce an extended colour whose sub-parameters are ordinary numbers, so truecolor `38;2;r;g;b` read as dim. Measured on grok, whose composer IS truecolor: a human's typed draft came out entirely dim and the composer therefore read as EMPTY — the dangerous direction, since empty is what permits injection. Latent only because no truecolor runtime declared the rule yet, which is precisely what this task was about to change. The parser now walks parameters and consumes `5;<n>` / `2;<r>;<g>;<b>` properly, and fails closed on a malformed colour. Evidence: `test/unit/composerDimTruecolor.test.ts` (7 tests on the captured bytes; the truecolor case fails without the fix). |
| 2026-07-26 | **Canonical Grok can commit again (`t-076a28`):** SDD 456 co-binds `HOME` to the private `GROK_HOME` so Grok cannot discover `$HOME/.claude/settings.json` — but `HOME` is also the agent's `HOME` for everything it shells out to, and git found no global config there, so every canonical Grok agent failed `git commit` with "Author identity unknown". The private home is now seeded with a `.gitconfig` that `[include]`s the operator's real one: identity (and their aliases and signing config) is read live from the file they own, nothing is copied, and nothing drifts. Measured that the isolation is untouched — `grok inspect --json` stays `sources: [] loaded: 0` with the seed present. Two claims from the `t-50fe1d` measurement are **corrected** here by re-measurement: `GIT_CONFIG_GLOBAL` does work (the original one-liner was at fault), and SSH was never broken — OpenSSH resolves `~` for identity files from the passwd database, not `$HOME`, so a private-`HOME` agent still offers the operator's real key even with no ssh-agent running. Only git reads its global config from `$HOME`, which is why only git needed a fix; no SSH follow-up is warranted. Evidence: `test/unit/privateHomeGitIdentity.test.ts` (7 tests driving real git, including the reproduced failure) plus a live `grok inspect` before/after the seed. |
| 2026-07-26 | **Grok model pins are verifiable (`t-85c586`):** `RuntimeLaunchPreflightRegistry` had claude/codex adapters only, so `--model grok-4.5` failed preflight as `runtime_preflight_unverifiable` ("runtime exposes no authoritative model catalog adapter") — a catalog gap, not an isolation one. Grok ships `grok models`, and measurement on 0.2.112 showed the CLI treats it as the source of truth in BOTH directions: a listed slug runs, and an unlisted one is refused before any turn with *Invalid params: "unknown model id". Run 'grok models' to see available models.* So `GrokLaunchPreflight` is authoritative (`supported`/`unsupported`) rather than provisional like Claude's. Nothing is invented: an unreadable listing — a logged-out CLI, an unrecognized layout, a timeout, a nonzero exit — stays `unverifiable`/`failed`, because absence of a readable catalog is not evidence that a model is missing. Caution recorded in the adapter: the catalog namespace is NOT the usage-reporting namespace — `grok-4.5-build` is what `modelUsage` reports as effective (SDD 474) yet is not a selectable id, and the dogfood pins that both reject it. Evidence: `npm run dogfood:grok-model-preflight` (6/6, cross-checking every verdict against the real CLI) + `test/unit/grokLaunchPreflight.test.ts`. |
| 2026-07-26 | **Grok tool-authorization prompts reach the coordinator (`t-4e6ba5`):** Grok's native modal (`1 always-approve / 2 Yes, proceed / 3 reject`) left the agent classified `working` — no notification, governed input refused as busy. Measured on grok 0.2.112 by making a live agent act OUTSIDE its workspace under `--permission-mode default`: the modal matches nothing in the base manifest (its options are `1 (●)`, no period, so base's `❯\s*\d+\.` menu rule misses them) **and** the pane keeps animating while it waits (an elapsed-time counter ticks every second), which is what pinned it to `working`. Fixed with `src/attention/manifests/grok.json`, the first measured per-runtime overlay in a mechanism that shipped empty; it matches the modal's bottom-most footer so a recognized prompt outranks content churn (the first option line sits past `PATTERN_POSITION_TOLERANCE`). Nothing auto-answers: the highlighted option is session state — a first prompt highlights always-approve, and after answering `2` the next prompt arrives with `2 (●)` — so a bare Enter is unpredictable and an answer must name its digit. Verified live that `2` performs the single action, leaves the footer without `always-approve`, and the next out-of-workspace action prompts again. Evidence: `test/unit/grokAuthorizationPrompt.test.ts` (11 tests, 5 fail without the overlay) plus a real-pane run of the actual `AttentionMonitor` reaching `needs-input`. |
| 2026-07-26 | **Claude composer suggestion is not a human draft (`t-c5f29b`):** Claude Code renders suggestion text INSIDE an otherwise empty composer, and Tachyon read it as a typed draft — refusing continuity with `refused-composer: non-empty composer draft` while the human had nothing to clear and no key would clear it. Measured on a live pane, Claude Code 2.1.220: the suggestion is entirely SGR-dim (`\x1b[39m❯ \x1b[2mTry "fix typecheck errors"\x1b[0m`), a typed draft carries no dim at all (`\x1b[39m❯ integre em main e verifique o tree` — the incident's own text, typed), and the separator after `❯` is U+00A0 in BOTH cases so it discriminates nothing. Claude therefore adopts the same measured `ansiEmptyContentStyle: "all-dim"` rule Codex has carried since `t-aee74e`; no new heuristic was invented, and with no escaped capture the detector still refuses rather than guessing. A real draft keeps blocking injection. Peers measured on an empty composer (grok 0.2.112, opencode 1.18.4, pi 0.80.10, hermes 0.18.2) render no such text; their post-turn behavior is unmeasured and filed separately. Evidence: `npm run dogfood:claude-composer-suggestion` (5/5 against the real CLI) plus `test/unit/claudeComposerSuggestion.test.ts`. |
| 2026-07-26 | **Ad-hoc spawn parity review fix (`t-1d49df` / `grok-adhoc-fixer`):** (1) Pi §3.6 row no longer mislabels private home as adapter-harness auto-isolate — `ResumeAdapter.pi` has no `harness`; home comes from profile `private-home` → `materializeRuntimeHarness` / `materializePiHomeOnly`. (2) Research appendix commits sanitized M1–M3 protocol + redacted outputs so HOME ambient / dual-home claims are independently re-runnable. Grok fail-closed worktree gate **unchanged**. |
| 2026-07-26 | **Ad-hoc spawn parity (§3.6 / `t-1d49df`):** measured Grok 0.2.112 — `GROK_HOME` isolates sessions; ad-hoc still omits `HOME` so ambient Claude settings load; runtime-wide **project-scoped** + parented worktree gate **kept**. Research: [`adhoc-runtime-parity-grok.md`](../research/adhoc-runtime-parity-grok.md). |
| 2026-07-26 | **Codex probe effective-model proof (SDD 476 / `t-a10d31`):** closes the last provenance exemption. `codex exec --json` still emits no model identity, so the probe stopped passing `--ephemeral` and instead correlates the `thread_id` the stream already prints to the session rollout Codex writes — `sessions/**/rollout-<ts>-<thread_id>.jsonl`, whose `turn_context.payload.model` is the identity (the same field spec 378 latches). Correlation is exact or absent: one `thread.started`, one matching rollout, and the file's own `session_meta` must repeat the id; anything else records `unproven` rather than borrowing a neighbouring rollout. The isolation `--ephemeral` provided is replaced by a stronger one — a PRIVATE per-run `CODEX_HOME` under the run's scratch dir (auth reaching it by symlink, plugins/remote-plugins/apps/skill-search disabled: 1.2 MB versus 38 MB), torn down by a new adapter `cleanup` hook the runner awaits on every exit path including timeout and cancel. Measured: the human's `~/.codex/sessions` is untouched and even codex's arg0 helper binaries follow `CODEX_HOME`. Codex's verdict carries `evidence: "session-record"` to distinguish it from Claude/Grok's `provider-usage`: it proves Codex did not substitute a model between the flag and the wire, not what the provider served. Evidence: `npm run dogfood:probe-codex-model-proof` (real CLI) and `npm run dogfood:probe-provenance-parity`. |
| 2026-07-26 | **Probe model provenance parity (SDD 474 / `t-be9405`):** audited every probe adapter against the four provenance obligations. All three already pass `--model` to the native invocation and persist `requestedModel` centrally. **Grok can prove its effective model** — `grok 0.2.112 -p --output-format json` reports `modelUsage` keyed by the identifier (`grok-4.5-build`, no `canonicalModel` sub-field), now extracted, so Grok probes leave SDD 473's `unproven` exemption. **Codex cannot**, measured on codex-cli 0.145.0: `exec --json` emits only thread/turn/usage records with no model identity, and the rollout carrying `turn_context.payload.model` is suppressed by the probe's `--ephemeral` (`t-a10d31`). A fleet guard now fails any adapter that neither declares `reportsEffectiveModel` nor carries a reasoned exemption. Evidence: `npm run dogfood:probe-provenance-parity`. |
| 2026-07-26 | **Per-agent Codex danger authorization (SDD 472 / `t-b0440a`):** `approval_policy` and `sandbox_mode` are now held to enums **measured against `codex-cli 0.145.0`** (the config enums, which are wider than the CLI flag enums — `on-failure` exists only in config), and the two dangerous values (`never`, `danger-full-access`) are refused unless the agent's own profile authorizes them. This closes the asymmetry where Claude refused a dangerous value by default while Codex validated nothing and inherited any string from the person's global config. Same `authorize` mechanism as SDD 471, now per-runtime; neither runtime can claim the other's members. Evidence: `npm run dogfood:codex-danger-optin`. |
| 2026-07-26 | **Per-agent `bypassPermissions` authorization (SDD 471 / `t-98427e`):** a canonical Claude profile may declare `nativeConfig.permissions.authorize: [bypassPermissions]`, which is the ONLY way that mode reaches the private `CLAUDE_CONFIG_DIR`. Inheriting it from `~/.claude/settings.json` still fails closed for every agent that did not authorize it, the authorization is refused on any other family/runtime or with an unknown member, and the authorized value is regenerated identically on fresh/restart/resume/fork. Agent Studio exposes it as an explicit checkbox with localized risk copy, off by default. Evidence: `npm run dogfood:claude-bypass-optin`. |
| 2026-07-26 | **Claude scalar refusals name the offending setting (`t-111190`):** a rejected value now reports the exact path, the value, the supported set and the way out (`Claude global key 'permissions.defaultMode' value 'bypassPermissions' is not projectable (supported: …); set the Permissions family to Exclude or change the global value`) instead of a bare "has an unsupported value". Fail-closed behavior is unchanged — only the diagnosis. |
| 2026-07-26 | **Claude canonical create unblocked (`t-45e80d`):** the global scalar projector no longer rejects unselected keys, so a real `~/.claude/settings.json` (`$schema`, `_comment`, `mcpServers`, `statusLine`, `tui`, `skipDangerousModePermissionPrompt`, `switchModelsOnFlag`, `skipAutoPermissionPrompt`) stays opaque instead of failing activation — matching the Codex projector, which already scoped this allowlist to `workspace`. Selected-family values (including the `bypassPermissions` refusal) and unselected **workspace** keys still fail closed. Evidence: `npm run dogfood:claude-canonical-create`. |
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

### 3.7 Authentication / loss of session

**Measured 2026-07-27 (`t-16cd93`, SDD 477).** Each runtime was driven with an isolated,
credential-free private home — the shape Tachyon already materializes — so no real credential was
touched. `✓` in row 16 requires the signal to be both measured AND consumed by Tachyon; everything
below is measured; Claude/Codex/Grok are additionally consumed at the launch boundary (`✓`), Pi and
Hermes are declared but not yet consumed (`~`), and OpenCode has nothing to consume (`✗`).

**What the mid-run state consumes (`t-5bfb72`, increment 3).** The live auth-required agent state runs
the same declared matchers against a running agent's pane, for every runtime that has a profile. Two
boundaries are worth stating plainly rather than leaving to be discovered:

- It matches the wording a runtime writes **into the transcript** — the column below. Codex and Grok
  were also measured rendering an interactive **sign-in screen** instead (a menu; a device-code
  approval ending in `Waiting for approval...`), and those shapes are deliberately NOT matched: they
  are a different surface, and no measurement yet says the transcript wording appears alongside them.
- The live read is gated harder than the launch read — the signal must sit within the last 12
  non-empty lines and the pane must already be quiet — because no runtime's *live* logged-out TUI has
  been observed with a genuinely expired credential, and because an agent reading these strings (the
  fixtures in this repository contain all of them) must never be parked.

| Runtime | Auth mechanism | Measured unauthenticated signal | Official non-interactive refresh | Human action | Recovery |
|---|---|---|---|---|---|
| Claude 2.1.220 | OAuth login → `.credentials.json` in `CLAUDE_CONFIG_DIR` (Tachyon symlinks it) | headless result `is_error: true`, `result: "Not logged in · Please run /login"` | none measured | `/login` in the runtime | explicit restart/retry after login |
| Codex 0.145.0 | ChatGPT login / device code / API key → `auth.json` in `CODEX_HOME` | `{"type":"error"}` + `turn.failed`: `401 Unauthorized: Missing bearer or basic authentication in header`, after **5 automatic reconnects**; TUI renders a sign-in menu | device code and API key exist as CLI options | sign in, or provide an API key | explicit restart/retry |
| Grok 0.2.112 | OAuth/device code → `auth.json` in `GROK_HOME` | `{"type":"error","message":"Not signed in. To authenticate without a browser, run: grok login --device-code …"}`; TUI shows the device-code approval screen | **yes** — `grok login --device-code`, or `XAI_API_KEY` | run the device-code flow | explicit restart/retry |
| OpenCode 1.18.5 | `auth.json` under `XDG_DATA_HOME/opencode`, **or** a provider key in the environment | **none in a turn** — it answers normally on the fallback model `big-pickle`. Measured instead from the credential store: `opencode providers list` → `└  0 credentials` (and no `Environment` section), consumed as a **launch refusal** (`t-0338fc`) | n/a | `opencode providers login`, or set a provider API key | re-launch after login |
| Pi 0.80.10 | API key / OAuth via env or `/login` | `No API key found for the selected model.` + `Use /login to log into a provider via OAuth or API key.` | env-var API key | `/login`, or set the provider env var | explicit restart/retry |
| Hermes 0.18.2 | provider key in `~/.hermes/.env` | `agent failed: No inference provider configured. Run 'hermes model' … or set an API key (OPENROUTER_API_KEY, OPENAI_API_KEY, …)` | env-var/`.env` key | `hermes model`, or set a provider key | explicit restart/retry |

**Two findings that constrain any detector.**

The **Claude TUI footer is not a usable signal**: `Not logged in · Run /login` was observed in the
footer of a *fully functional* agent, mid-task, which then completed that task and several more. A
pane detector keyed on that string would park healthy agents. The trustworthy Claude signal is
turn-attached — the runtime *answering* the login error.

**OpenCode fails silently in the dangerous direction**: with no credential it does not error, it
degrades to a fallback model and answers. An agent can therefore look healthy while running a model
the operator did not choose. Nothing about that was inferred away — `t-0338fc` re-measured it on
1.18.5 and confirmed there is still nothing in a turn to match (`run --format json` carries no model
field at all; the effective `big-pickle` surfaces only in session storage, *after* the turn). What
changed is where the question is asked: the runtime's own credential store answers it *before* the
launch, so the failure is refused at the boundary instead of being invisible afterwards. The mark is
`~`, not `✓` — a credential expiring mid-run is still undetected for OpenCode.

**Where the OpenCode gate deliberately fails closed.** An unreadable probe — timeout, non-zero exit,
or output that is not the measured inventory shape — refuses the launch rather than assuming the
credential is fine. That is the opposite of the rule everywhere else in this spec, and the reason is
specific to this runtime: the probe was measured to be a *local* read (it works from a cold private
home with the network black-holed, in under a second), so a failure means a broken environment, and
the cost of guessing "probably fine" is precisely the invisible degradation the gate exists to stop.
A refusal is loud, immediate and names the probe; the alternative failure is silent.
