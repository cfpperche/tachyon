# Ad-hoc runtime parity — Grok isolation gate

**Task:** `t-1d49df`  
**Agents:** `grok-adhoc` (first delivery `f3288669`); `grok-adhoc-review` (re-delivery on main after gate misconfig); `grok-adhoc-fixer` (review findings on `cf5ad64f`)  
**Measured:** 2026-07-26 (operator re-measure; sanitized evidence in appendix)  
**CLI:** Grok **0.2.112** (`9bbd559437`, stable)  
**Scope:** docs only — no `runtimeProfile` / gate changes in this delivery.

## Decision (verdict)

**Keep** `runtimeProfile.grok.isolation = project-scoped` (verified) for the
**runtime-wide** posture. The parented non-harness refuse without an isolated
worktree (`assertVerifiedTranscriptIsolation`) is **correct for ad-hoc Grok**
today, not a false positive.

Reasons, from re-runnable CLI evidence (appendix) + code of record — not
prose-only inference:

1. **Legacy / bare `grok`** (no `GROK_HOME`) stores config under `$HOME/.grok`
   (M3: ambient `HOME` creates `$HOME/.grok/{config.toml,docs,…}`) with sessions
   further keyed by **URL-encoded cwd** — classic project-scoped layout.
2. **Tachyon non-harness / ad-hoc** injects only `GROK_HOME` (Bridge private home
   via `materializeBridgeMcpGrok`). That **does** isolate transcripts/config from
   ambient `~/.grok` (M2 dual-home), but **does not** bind `HOME`.
3. **Grok 0.2.112 still loads `$HOME/.claude/settings.json` for permissions** when
   only `GROK_HOME` is redirected (M1a `permissions.sources`). Binding `HOME` to
   the same private directory (canonical path only) clears that ambient source
   (M1b `sources: []`, `loaded: 0`).
4. **Canonical** profiles already bind `GROK_HOME` **and** `HOME` to one private
   home (`profileLifecycle` path). That is intentionally **not** claimed as
   runtime-wide private-home isolation (SDD 456 acceptance).
5. Ad-hoc Grok deliberately **skips** auto `isolate: "transcript"` (t-303f2b) to
   avoid racing a second private home against Bridge `GROK_HOME` (auth wall).
   Peers with `ResumeAdapter.harness` (Claude/Codex/OpenCode) auto-isolate
   transcripts on ad-hoc instead; Pi has **no** adapter harness (see matrix).

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
  → isolate: "transcript"   // Claude, Codex, OpenCode (ResumeAdapter.harness present)
  → SKIPPED for grok/hermes when Bridge private-home materializer is wired
  → NEVER fires for pi: ResumeAdapter.pi has no harness field
```

**Pi private home (code of record, not adapter harness):** profile
`isolation.mechanism === "private-home"` makes `materializeRuntimeHarness` need a
home; `Workspace.materializeHarness` then calls `materializePiHomeOnly` /
`materializePiHome` (`PI_CODING_AGENT_DIR` + session dir). Opt-in `def.harness`
only adds SDD 406 resource snapshots — it is not `ResumeAdapter.harness`.

Parented gate (simplified):

```text
if (parent && kind === "agent" && !harness)
  assertVerifiedTranscriptIsolation(cmd, { isolatedWorktree, parented: true })
```

`hasVerifiedTranscriptIsolation`: `mint` / `private-home` always pass when
verified; `project-scoped` passes only with `isolatedWorktree: true`.

## Measurements — Grok 0.2.112

**Evidence standard:** M1–M3 claims below are backed by a **committed, sanitized
re-measure protocol + outputs** in the appendix (same CLI version). Raw session
transcripts and auth material are **not** committed (secrets / bulk noise).
Path presence, `permissions` JSON from `grok inspect --json`, and redacted
headless JSON fields (`sessionId`, `modelUsage` keys, `text`) are the durable
artifacts. Earlier `cf5ad64f` prose alone was not independently traceable; this
section supersedes that gap.

All runs used **temporary** `HOME` / `GROK_HOME` trees. Auth was only **symlinked**
into temp homes when a live headless prompt was required; credentials were never
printed. Ambient `~/.grok/sessions` was checked for session IDs (presence only).

### M1 — Permission discovery vs `HOME`

| Setup | `grok inspect --json` → `permissions` |
|-------|----------------------------------------|
| `GROK_HOME=$tmp/homeA`, `HOME=$tmp/ambient` with `$HOME/.claude/settings.json` marker | `sources: ["$tmp/ambient/.claude/settings.json (settings)"]`, `loaded: 1` |
| `GROK_HOME=HOME=$tmp/private` (no `.claude/settings.json`) | `sources: []`, `loaded: 0` |

**Conclusion:** private `GROK_HOME` alone does **not** exclude Claude permission
settings; co-binding `HOME` does (matches SDD 456 / canonical env).

### M2 — Session / config namespace under `GROK_HOME`

| Setup | Result |
|-------|--------|
| Headless `grok -p '<prompt>' --session-id <uuid> --output-format json` with private `GROK_HOME=homeA` + auth symlink | Session files under `homeA/sessions/<encodeURIComponent(cwd)>/<uuid>/` including `chat_history.jsonl` |
| Same SIDs under ambient real `~/.grok/sessions` | **0** matches |
| Dual homes `homeA` / `homeB`, distinct SIDs | SID only under the home that ran it (no cross-home bleed) |
| Same `GROK_HOME`, two cwds | Two distinct encoded session directory keys |

**Conclusion:** `GROK_HOME` is a real private-home for **transcripts and config**.
The runtime-wide profile still cannot say “private-home” while ad-hoc/legacy omit
`HOME` binding and bare launches still use `$HOME/.grok`.

### M3 — Bare ambient (no `GROK_HOME`)

With only `HOME=$tmp/ambient` and **unset** `GROK_HOME`, `grok inspect --json`
still loads `$HOME/.claude/settings.json` (`loaded: 1`), and launching Grok
creates `$HOME/.grok/` (docs, `config.toml`, locks, …). Documented default:
`GROK_HOME` overrides config directory; default `~/.grok`
(`~/.grok/docs/user-guide/17-sessions.md`). Headless `-p` without auth under a
fresh ambient home fails closed with “Not signed in” — auth still lives under
the default home layout, not a redirected `GROK_HOME`.

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
| Claude | **mint** ✓ | yes (`adapter.harness`) | MCP file, not home | **allow** | Session mint / CLAUDE_CONFIG_DIR paths |
| Codex | **private-home** ✓ | yes (`adapter.harness`) | CODEX_HOME family | **allow** | Default private home on spawn |
| OpenCode | **private-home** ✓ | yes (`adapter.harness`) | `OPENCODE_CONFIG` | **allow** | t-e2ebe3 ungated after XDG harness |
| Grok | **project-scoped** ✓ | **no** (t-303f2b Bridge home skip) | `GROK_HOME` only | **refuse** | Transcript private; **HOME**/Claude settings still ambient |
| Pi | **private-home** ✓ | **no** (`ResumeAdapter.pi` has **no** `harness`) | profile → `materializeRuntimeHarness` / `materializePiHomeOnly` (`PI_CODING_AGENT_*`) + Bridge extension | **allow** | SDD 401; private home is **not** adapter-harness auto-isolate |
| Hermes | **private-home** ✓ | no (Bridge home skip) | `HERMES_HOME` | **allow** | Profile already private-home |

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

## Re-delivery note

First content commit was `f3288669` (tree `278df691`). Governed verify failed for
reasons **external** to the research: `behavior_test` used shell `&&` under an
argv executor, and full verify in a deep `/tmp` path hit AF_UNIX/tmux limits.
Re-delivery `cf5ad64f` rebased documentary conclusions onto main (including
`t-a10d31` / SDD 476 probe provenance rows that `f3288669` predated).

### Review-fix note (`grok-adhoc-fixer` on `cf5ad64f`)

Adversarial review findings addressed in this commit (docs only; verdict
**unchanged** — keep project-scoped + parented worktree gate):

1. **Pi mislabel:** § matrix / parity §3.6 no longer claim ad-hoc auto-isolation
   via “adapter harness path.” Code of record: `ResumeAdapter` for `pi` has no
   `harness`; private dirs come from profile `private-home` →
   `materializeRuntimeHarness` / `Workspace` → `materializePiHomeOnly`.
2. **M1–M3 traceability:** appendix commits sanitized, re-runnable evidence for
   HOME ambient permission loading, dual-home session isolation, and bare
   `$HOME/.grok` default. No secrets; no raw transcript dumps.

## Appendix — sanitized M1–M3 evidence (Grok 0.2.112)

**When:** 2026-07-26 · **CLI:** `grok 0.2.112 (9bbd559437) [stable]` · **Host:**
operator temp trees under `/tmp/grok-adhoc-evidence.*` (ephemeral; not required
to reproduce the paths — use any clean `mktemp -d`).

**Safety:** symlink `auth.json` from real `~/.grok/auth.json` into private homes
only when running live `-p`; never print auth, tokens, or full session bodies.
Commit only the redacted fields below.

### Protocol (reproducible)

```bash
BASE=$(mktemp -d /tmp/grok-adhoc-evidence.XXXXXX)
mkdir -p "$BASE/ambient/.claude" "$BASE/homeA" "$BASE/homeB" "$BASE/private" \
         "$BASE/cwd1" "$BASE/cwd2"
printf '%s\n' '{"permissions":{"defaultMode":"acceptEdits"},"_tachyon_marker":"adhoc-m1-ambient"}' \
  > "$BASE/ambient/.claude/settings.json"
# optional for M2 live -p: ln -s "$HOME/.grok/auth.json" "$BASE/homeA/auth.json" (etc.)

# M1a — GROK_HOME only, ambient HOME carries Claude settings
GROK_HOME="$BASE/homeA" HOME="$BASE/ambient" grok inspect --json \
  | jq '{grokVersion, permissions}'

# M1b — co-bind HOME + GROK_HOME (no .claude under private)
GROK_HOME="$BASE/private" HOME="$BASE/private" grok inspect --json \
  | jq '{grokVersion, permissions}'

# M2 — dual home + dual cwd (distinct session UUIDs)
SID1=$(python3 -c 'import uuid; print(uuid.uuid4())')
SID2=$(python3 -c 'import uuid; print(uuid.uuid4())')
SID3=$(python3 -c 'import uuid; print(uuid.uuid4())')
GROK_HOME="$BASE/homeA" HOME="$BASE/ambient" \
  (cd "$BASE/cwd1" && grok -p 'reply with only the word ping' --session-id "$SID1" \
     --output-format json --no-memory --always-approve)
GROK_HOME="$BASE/homeB" HOME="$BASE/ambient" \
  (cd "$BASE/cwd1" && grok -p 'reply with only the word pong' --session-id "$SID2" \
     --output-format json --no-memory --always-approve)
GROK_HOME="$BASE/homeA" HOME="$BASE/ambient" \
  (cd "$BASE/cwd2" && grok -p 'reply with only the word cwd2' --session-id "$SID3" \
     --output-format json --no-memory --always-approve)
# Then list: find "$BASE/homeA/sessions" "$BASE/homeB/sessions" -name chat_history.jsonl
# and confirm zero matches for those SIDs under real ~/.grok/sessions

# M3 — bare ambient (unset GROK_HOME)
unset GROK_HOME
HOME="$BASE/ambient" grok inspect --json | jq '{grokVersion, permissions}'
# After any launch under that HOME: ls "$BASE/ambient/.grok"
```

### Observed (redacted) — operator run 2026-07-26

**M1a** (`GROK_HOME=homeA`, ambient Claude marker):

```json
{
  "grokVersion": "0.2.112",
  "permissions": {
    "sources": ["<tmp>/ambient/.claude/settings.json (settings)"],
    "loaded": 1,
    "skipped": [],
    "managedSettingsExists": false,
    "managedSettingsActive": false
  }
}
```

**M1b** (`HOME=GROK_HOME=private`, no `.claude`):

```json
{
  "grokVersion": "0.2.112",
  "permissions": {
    "sources": [],
    "loaded": 0,
    "skipped": [],
    "managedSettingsExists": false,
    "managedSettingsActive": false
  }
}
```

**M2** layout (session UUIDs from the operator run; replace when re-running):

| SID (abbrev) | Only under | Encoded cwd group |
|--------------|------------|-------------------|
| `…6af9a8f087c0` | `homeA/sessions/…/cwd1/…` | `%2F…%2Fcwd1` |
| `…e091a1b981a0` | `homeB/sessions/…/cwd1/…` | `%2F…%2Fcwd1` |
| `…08c5301aec92` | `homeA/sessions/…/cwd2/…` | `%2F…%2Fcwd2` |

- Each path contained `chat_history.jsonl`.
- Cross-home: SID for homeA absent under homeB and vice versa.
- Real ambient `~/.grok/sessions`: **0** path matches for those three SIDs.
- Headless JSON (fields kept): `sessionId` matched the requested UUID;
  `modelUsage` keys `["grok-4.5-build"]`; `text` was `ping` / `pong` / `cwd2`.

**M3** (unset `GROK_HOME`, `HOME=ambient`):

- `permissions.sources` loaded ambient `.claude/settings.json` (`loaded: 1`).
- `$HOME/.grok` created with at least: `config.toml`, `docs/`, `logs/`,
  `active_sessions.json`, locks (no committed listing of secrets).
- Live `-p` without auth under that fresh ambient home failed with “Not signed
  in” (expected — no auth seed in bare ambient).

## M4 — the `HOME` co-bind, measured before deciding (`t-50fe1d`, 2026-07-26)

`t-50fe1d` asked whether the ad-hoc path should co-bind `HOME` to the private Bridge `GROK_HOME`,
the way `Workspace.ts` already does for canonical (`profileLifecycle`) Grok. It said to measure
first, and the measurement changes the answer.

Arms: private home materialized the way `materializeBridgeMcpGrok` does (`config.toml` + `auth.json`
symlink), grok 0.2.112, `grok inspect --json` in a scratch git repo.

| # | Env | `permissions.sources` | Live `-p` auth | Sessions | `git commit` |
|---|-----|----------------------|----------------|----------|--------------|
| A | `GROK_HOME` private, `HOME` ambient — **today's ad-hoc path** | `["~/.claude/settings.json (settings)"]`, `loaded: 1` | ✓ | private home | ✓ |
| B | `HOME` **and** `GROK_HOME` = private — **canonical shape** | `[]`, `loaded: 0` | ✓ | private home | ✗ **"Author identity unknown"** |
| C | B + private `.gitconfig` with `[include] path = <real ~/.gitconfig>` | `[]`, `loaded: 0` | ✓ | private home | ✓ |

Neither arm wrote to the operator's `~/.grok`: the session ids from both live `-p` runs are absent
from `~/.grok/sessions`. **`GROK_HOME` alone already isolates sessions, config and auth** — the
co-bind buys exactly one thing, and it is the permission surface.

**What the co-bind buys.** Arm A really does load the operator's `~/.claude/settings.json`. On this
machine that file carries `permissions.defaultMode: "bypassPermissions"`, so the hole is not
theoretical: it is ambient inheritance of the single most dangerous value, on the path used by bare
`cmd: grok`. Arm B closes it completely.

**What the co-bind costs.** A co-bound `HOME` is the agent's `HOME` for everything it shells out to,
not only for Grok's own config discovery. Measured: `git commit` fails outright with *"Author
identity unknown"*, because `~/.gitconfig` is no longer on any path git consults. Nothing in `src/`
supplied a git identity at the time of measurement: no `GIT_AUTHOR_*`, no `GIT_CONFIG_GLOBAL`, no
seeded `.gitconfig`.

**Correction (`t-076a28`, re-measured): SSH is NOT affected.** The first pass inferred an SSH failure
from the private home having no `.ssh` and said so while flagging that no handshake had been
attempted. The handshake disagrees: under a private `HOME`, with no ssh-agent at all
(`SSH_AUTH_SOCK` unset), `ssh -T git@github.com` authenticates. `ssh -v` shows why — it resolves
`~` for identity files from the **passwd database**, not `$HOME`, and offers
`/home/<user>/.ssh/id_ed25519` regardless. That is the crisp asymmetry: git reads its global config
from `$HOME`, so it breaks; ssh does not, so it does not. Only git needed fixing.

**This already bites canonical Grok.** `Workspace.ts` co-binds `HOME` for every `profileLifecycle`
Grok agent today, so a canonical Grok agent cannot commit. That is a pre-existing consequence of SDD
456 that nobody measured; filed separately rather than folded in here.

**Mitigation exists and is cheap** (arm C): seeding the private home with a `.gitconfig` that
`[include]`s the operator's real one restores commits *and* keeps `loaded: 0`. Shipped for canonical
Grok in `t-076a28`.

**Correction (`t-076a28`): `GIT_CONFIG_GLOBAL` works too.** The first pass reported that pointing it
at the real file failed; re-measured cleanly, it succeeds — the original one-liner was at fault, not
the mechanism. The include form was shipped anyway, for reasons that survive that correction: a file
in `HOME` is found by anything that honours `HOME`, whereas an env var is lost by any subprocess that
re-execs with a scrubbed environment.

**Ruling (unchanged pending a product call).** `runtimeProfile.grok.isolation` stays
`project-scoped` and `assertVerifiedTranscriptIsolation` is untouched. Co-binding `HOME` on the
ad-hoc path is *effective* but not *free*, and shipping it bare would trade a permission hole for
silently broken commits in the exact scenario ad-hoc exists to serve — an agent working in the
operator's own workspace. Step 3 of `t-50fe1d` (reclassify to `private-home`) therefore remains
blocked on a decision, not on more measurement: ship arm C (co-bind + seeded `.gitconfig`, accepting
the `.ssh` gap) or keep arm A and treat the ambient permission read as a declared limitation.

## Related seams / reading

- Living matrix: [`docs/runtimes/parity.md`](../runtimes/parity.md) §3.6 Ad-hoc spawn parity, Grok row, §3.4
- SDD 456: `docs/specs/456-grok-canonical-parity/`
- Profile: `src/runtime/runtimeProfile.ts` (`grok.isolation`, `assertVerifiedTranscriptIsolation`)
- Spawn: `src/agents/AgentManager.ts` (auto-isolate skip, parented assert, `withRuntimeBridge` grok branch)
- Canonical env: `src/workspace/Workspace.ts` (`HOME` + `GROK_HOME` when `profileLifecycle`)
