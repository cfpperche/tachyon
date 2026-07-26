# Ad-hoc runtime parity — Grok isolation gate

**Task:** `t-1d49df`  
**Agents:** `grok-adhoc` (first delivery `f3288669`); `grok-adhoc-review` (re-delivery on main after gate misconfig)  
**Measured:** 2026-07-26  
**CLI:** Grok **0.2.112** (`9bbd559437`, stable)  
**Scope:** docs only — no `runtimeProfile` / gate changes in this delivery.

## Decision (verdict)

**Keep** `runtimeProfile.grok.isolation = project-scoped` (verified) for the
**runtime-wide** posture. The parented non-harness refuse without an isolated
worktree (`assertVerifiedTranscriptIsolation`) is **correct for ad-hoc Grok**
today, not a false positive.

Reasons, measured rather than inferred:

1. **Legacy / bare `grok`** (no `GROK_HOME`) stores config and sessions under
   `$HOME/.grok`, with sessions further keyed by **URL-encoded cwd** — classic
   project-scoped transcript layout.
2. **Tachyon non-harness / ad-hoc** injects only `GROK_HOME` (Bridge private home
   via `materializeBridgeMcpGrok`). That **does** isolate transcripts/config from
   ambient `~/.grok`, but **does not** bind `HOME`.
3. **Grok 0.2.112 still loads `$HOME/.claude/settings.json` for permissions** when
   only `GROK_HOME` is redirected. Binding `HOME` to the same private directory
   (canonical path only) clears that ambient source.
4. **Canonical** profiles already bind `GROK_HOME` **and** `HOME` to one private
   home (`profileLifecycle` path). That is intentionally **not** claimed as
   runtime-wide private-home isolation (SDD 456 acceptance).
5. Ad-hoc Grok deliberately **skips** auto `isolate: "transcript"` (t-303f2b) to
   avoid racing a second private home against Bridge `GROK_HOME` (auth wall).
   Peers (Claude/Codex/OpenCode) auto-isolate transcripts on ad-hoc instead.

**Do not** weaken the worktree gate or reclassify the profile until ad-hoc /
legacy launches also own ambient `HOME` discovery (or a measured, narrower
context flag is designed). That is a product/code follow-up, not this report.

## Origin of the decision

| When | Artifact | What landed |
|------|----------|-------------|
| 2026-07-08 | `t-4891dd` / `ecd4cf89` | First `runtimeProfile.grok.isolation`: **project-scoped**, notes “private config-home wiring is not declared yet.” |
| 2026-07-09 | `t-843576` | Non-harness private `GROK_HOME` + Bridge MCP (`materializeBridgeMcpGrok`). |
| 2026-07 | `t-303f2b` | Ad-hoc/gated Grok **reuses** Bridge `GROK_HOME`; **no** auto `isolate:transcript` (dual-home auth race). |
| 2026-07-08→ | OpenCode contrast `t-e2ebe3` | OpenCode upgraded to **private-home** → parented spawn **ungated**. Grok did not get the same reclassification. |
| 2026-07-25 | SDD 456 / `72a693eb` | Canonical binds `HOME`+`GROK_HOME`; notes updated to “legacy/**ad-hoc** remain project-scoped”; permission inject demoted to unverified. |
| Ongoing | `assertVerifiedTranscriptIsolation` | Parented, non-harness, `kind: agent` + verified **project-scoped** without `isolatedWorktree` → refuse. Harness skips assert (§3.4). |

## How Tachyon classifies isolation (code of record)

Seams: `src/runtime/runtimeProfile.ts`, `src/agents/AgentManager.ts` (spawn),
`src/workspace/Workspace.ts` (canonical env), `src/harness/HarnessManager.ts`
(`materializeBridgeMcpGrok`).

| Path | Env injected | Profile gate for parented non-harness |
|------|--------------|----------------------------------------|
| Bare / legacy `cmd: grok` (no materializer) | none | project-scoped → **worktree required** |
| Ad-hoc / non-harness Bridge | `GROK_HOME` only | same profile → **worktree required** |
| Canonical `profileLifecycle` | `GROK_HOME` + `HOME` → private home | same profile key (still project-scoped runtime-wide); harness or worktree still matter for parented non-harness |
| `def.harness` | harness private home | assert **skipped** |

Spawn auto-isolate for ad-hoc AI children:

```text
adhoc && adapter.harness && !def.harness && isolate unset
  → isolate: "transcript"   // Claude, Codex, OpenCode, …
  → SKIPPED for grok/hermes when Bridge private-home materializer is wired
```

Parented gate (simplified):

```text
if (parent && kind === "agent" && !harness)
  assertVerifiedTranscriptIsolation(cmd, { isolatedWorktree, parented: true })
```

`hasVerifiedTranscriptIsolation`: `mint` / `private-home` always pass when
verified; `project-scoped` passes only with `isolatedWorktree: true`.

## Measurements — Grok 0.2.112

All runs used **temporary** `HOME` / `GROK_HOME` trees. Auth was only **symlinked**
into temp homes when a live headless prompt was required; credentials were never
printed. Ambient `~/.grok/sessions` was checked for session IDs (presence only).

### M1 — Permission discovery vs `HOME`

| Setup | `grok inspect --json` → `permissions.sources` |
|-------|-----------------------------------------------|
| `GROK_HOME=$tmp/homeA`, `HOME=$tmp/ambient` with `$HOME/.claude/settings.json` marker | **Loaded** ambient Claude settings path under temp ambient home |
| `GROK_HOME=HOME=$tmp/private` (no `.claude/settings.json`) | **sources: []**, loaded 0 |

**Conclusion:** private `GROK_HOME` alone does **not** exclude Claude permission
settings; co-binding `HOME` does (matches SDD 456 / canonical env).

### M2 — Session / config namespace under `GROK_HOME`

| Setup | Result |
|-------|--------|
| Headless `grok -p … --session-id <uuid>` with private `GROK_HOME=homeA` + auth symlink | Session files under `homeA/sessions/<encodeURIComponent(cwd)>/<uuid>/` including `chat_history.jsonl` |
| Same SID under ambient `~/.grok/sessions` | **0** matches |
| Dual homes `homeA` / `homeB`, distinct SIDs | SID only under the home that ran it (no cross-home bleed) |
| Same `GROK_HOME`, two cwds | Two distinct encoded session directory keys |

**Conclusion:** `GROK_HOME` is a real private-home for **transcripts and config**.
The runtime-wide profile still cannot say “private-home” while ad-hoc/legacy omit
`HOME` binding and bare launches still use `$HOME/.grok`.

### M3 — Bare ambient (no `GROK_HOME`)

With only `HOME=$tmp/ambient`, Grok creates `$HOME/.grok/` (docs + state) and
still loads `$HOME/.claude/settings.json`. Documented default:
`GROK_HOME` overrides config directory; default `~/.grok`
(`~/.grok/docs/user-guide/17-sessions.md`, env table).

### M4 — Model preflight (context for failed `--model grok-4.5` attempt)

`RuntimeLaunchPreflightRegistry` has adapters for **claude** / **codex** only
under `src/runtime/adapters/`. Absence → `runtime_preflight_unverifiable` /
“runtime exposes no authoritative model catalog adapter.” A spawn that pins
`--model grok-4.5` is refused for **catalog**, not isolation. Native default
model on a live `-p` call in this environment reported usage keyed
`grok-4.5-build` (observation only; not an authoritative catalog).

## Ad-hoc parity matrix (main runtimes)

Legend for **parented ad-hoc AI child**, Bridge up, no explicit `harness:`, no
`worktree:` unless noted.

| Runtime | Profile isolation | Ad-hoc auto `isolate:transcript` | Bridge private home | Parented without worktree | Notes |
|---------|-------------------|----------------------------------|---------------------|---------------------------|-------|
| Claude | **mint** ✓ | yes | MCP file, not home | **allow** | Session mint / CLAUDE_CONFIG_DIR paths |
| Codex | **private-home** ✓ | yes | CODEX_HOME family | **allow** | Default private home on spawn |
| OpenCode | **private-home** ✓ | yes | `OPENCODE_CONFIG` | **allow** | t-e2ebe3 ungated after XDG harness |
| Grok | **project-scoped** ✓ | **no** (t-303f2b) | `GROK_HOME` only | **refuse** | Transcript private; **HOME**/Claude settings still ambient |
| Pi | **private-home** ✓ | (adapter harness path) | Pi extension + private dirs | **allow** | SDD 401 |
| Hermes | **private-home** ✓ | no (Bridge home) | `HERMES_HOME` | **allow** | Profile already private-home |

**Grok-only product friction:** standby / parented ad-hoc Grok without
`worktree: true` hits:

```text
cannot delegate '<name>': this runtime's project-scoped transcript isolation
requires an isolated worktree for this spawn …
```

Remedies today (unchanged): `worktree: true`, gated delegation with registered
worktree cwd, or declared harness / non-parented top-level spawn.

### Governance rigor: ad-hoc vs canonical

Tachyon **does** govern isolation for ad-hoc via the same
`assertVerifiedTranscriptIsolation` + `runtimeProfile` key as declared agents.
It does **not** give ad-hoc the full canonical lifecycle package (private
`HOME` co-bind, profile-lifecycle regeneration, measured permission projection).
§3.1 / §3.4 alone understate that split; §3.6 is the explicit ad-hoc axis.

**Session observation (not re-measured here):** during the first investigation
pass, native Grok tool-authorization prompts (`always-approve` / `proceed` /
`reject`) left the agent in `attention: working` rather than `needs-input`, so
coordinators were not notified and `write_input(answering=true)` was refused as
busy. That is an **attention** parity gap (journal on `t-1d49df`), orthogonal
to the worktree isolation ruling.

## Gaps filed as separate tasks

Code/product work **out of scope** here:

1. **`t-50fe1d` — Ad-hoc Grok HOME co-bind + isolation reclassification** — if
   product wants parented ad-hoc Grok without worktrees, measure binding `HOME`
   to the Bridge private home on the non-canonical path, then decide whether
   profile can become `private-home` without lying about bare `cmd: grok`.
2. **`t-85c586` — Grok launch model-catalog preflight** — authoritative adapter
   so explicit `--model` is verifiable (or honestly provisional) instead of
   hard-unverifiable.
3. **Permission inject** — already open in the parity matrix (profile records
   modes; spawn does not apply them).
4. **Attention: Grok native tool-auth prompts** — coordinator journal on
   `t-1d49df` (not a filed task yet); separate from isolation if prioritized.

## Re-delivery note (this commit)

First content commit was `f3288669` (tree `278df691`). Governed verify failed for
reasons **external** to the research: `behavior_test` used shell `&&` under an
argv executor, and full verify in a deep `/tmp` path hit AF_UNIX/tmux limits.
This re-delivery:

- Rebases the documentary conclusions onto current main (includes `t-a10d31`
  probe provenance rows in `docs/runtimes/parity.md` that `f3288669` predated).
- Re-audits claims against code of record on main; **no** isolation re-measure
  (CLI still 0.2.112; seams for `GROK_HOME`-only ad-hoc and canonical
  `HOME`+`GROK_HOME` co-bind are unchanged).
- Does **not** treat the failed first verify as content approval or rejection.

## Related seams / reading

- Living matrix: [`docs/runtimes/parity.md`](../runtimes/parity.md) §3.6 Ad-hoc spawn parity, Grok row, §3.4
- SDD 456: `docs/specs/456-grok-canonical-parity/`
- Profile: `src/runtime/runtimeProfile.ts` (`grok.isolation`, `assertVerifiedTranscriptIsolation`)
- Spawn: `src/agents/AgentManager.ts` (auto-isolate skip, parented assert, `withRuntimeBridge` grok branch)
- Canonical env: `src/workspace/Workspace.ts` (`HOME` + `GROK_HOME` when `profileLifecycle`)
