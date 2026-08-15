# t-bcf9e5 — local usage / rate-limit sources (claude, codex, grok)

Measured 2026-08-15 on this host. Study only; no product code changed.

Today's incident is the control: the owner discovered Codex weekly was high
after two Codex agents were already running, and a running agent had to be
swapped mid-work. The question is whether a number already on disk (or already
collected by Tachyon) could have changed that dispatch **before** spawn.

Scope: claude, codex, grok. No Gemini / OpenCode / Kimi. No extra provider
HTTP. No token proxy.

Host clock at first inventory: `2026-08-15T19:31:40Z`.
Binaries: Claude Code `2.1.233`, Codex CLI `0.147.0`, Grok Build `1.0.4`
(`d846eb93d9`).

## Verdict

| Runtime | Local remaining-quota? | Decision-grade today? | Confidence |
|---|---|---|---|
| **codex** | Yes — rollout JSONL + live collector | **Yes** for the weekly window that exists now | `exact` while a session or the collector has written in the last few minutes |
| **claude** | No durable remaining-quota file | **No** from idle disk. Live status-line only, and only while a Claude session is rendering | `best-effort` live; persisted last-good can lie |
| **grok** | No remaining-quota channel at all | **No** | absence is `exact`; any invented remaining % would be a lie |

The Codex weekly number that motivated today's swap was already on this
machine: **64% used, `window_minutes=10080`, reset `2026-08-20T11:41:22Z`**.
It sat in the newest rollout, in Tachyon's last-good store, and in the
existing Bridge tool `runtime_condition`. Nobody read it before the second
Codex spawn. That is the gap — not a missing collector.

A monitor that displayed Claude's persisted last-good as current would have
been worse than silence: at 19:39Z that file still said the 5-hour window
was 10% used and would reset at `2026-08-15T03:40:00Z`, a time that had
already passed.

Whether any of this enters the product is the owner's call, not this
study's. The rest of the file is evidence. The table below is the
decision packet.

## For the owner to decide

| | Exists? | Reliable to this point? | Would cost | Without it |
|---|---|---|---|---|
| **codex** | Yes. Newest rollout last `rate_limits`, engine last-good, and Bridge `runtime_condition` all held **weekly 64%**, reset `2026-08-20T11:41:22Z`, at measurement. | **Yes** for that weekly window, while the newest write is minutes old. Not for a 5 h window: local payload stopped carrying one on 2026-07-16. | **Almost nothing new.** Collector + last-good + `runtime_condition` already run. Entering the product is a dispatch habit (read the tool before spawn) or, if wanted later, a fail-open one-liner on the spawn path that repeats that cached number. Not a new dashboard and not a new API. | Today's incident repeats: weekly is high, two Codex agents are already up, a running one gets swapped, a worktree and a spawn are wasted. The number will have been on disk the whole time. |
| **claude** | No durable remaining-quota file. Live status-line *can* emit 5 h + 7 d percents while a Claude session is rendering. Persisted last-good on disk was 18 h old. | **No** from idle files. `stats-cache.json` is 38-day-old *spend*. A last-good shown as current would have advertised a 5 h window that had already reset. Live read is `best-effort` only. | Building a panel from last-good or `stats-cache` is cheap and **wrong**. Making idle-disk remaining-quota exist would mean a source Claude does not write — not a Tachyon feature, a missing runtime file. | Coordinator keeps guessing Claude headroom. After a 5 h reset nobody notices until a human says so (already happened once; `runtimeCondition.ts` comments it). A stale chip would make that worse. |
| **grok** | Session token spend and context-window fill only. `grok inspect --json` has **no** quota keys. | **No** remaining-quota source. Absence is exact. | Any remaining % would be invented from spend or from an API this card forbids. Cost of honesty is zero: keep saying `no quota channel`. | Swapping *to* Grok to spare Codex is a bet, not a measurement. That is still better than a fake Grok gauge. |

This card can close on that packet. A "no" on Claude idle files and on
Grok is a complete answer, not a gap to fill.

## 1. Inventory (measured)

Agent `$HOME` is remapped to
`/home/goat/tachyon/.tachyon/bridge-mcp/usagegrok.grok`.
`os.path.expanduser('~')` follows that remap. The real runtime state is
under `/home/goat/.claude`, `/home/goat/.codex`, `/home/goat/.grok`. A
monitor that expands `~` from inside an agent process will miss every
source below.

### Codex — `/home/goat/.codex`

**What is there.** Home exists since at least `2025-12-06` (oldest rollout).
Top-level: `auth.json`, `config.toml`, `sessions/YYYY/MM/DD/rollout-*.jsonl`
(837 files), plus sqlite (`state_5`, `logs_2` ~1.0 GiB, `goals_1`,
`memories_1`, `queue_1`). No file whose *name* is usage/rate-limit.

**The remaining-quota source is inside the rollouts.** Each `event_msg`
line can carry `payload.rate_limits`:

```text
payload.rate_limits.{plan_type, limit_id, primary, secondary, credits, ...}
payload.rate_limits.primary.{used_percent, window_minutes, resets_at}
```

Reproducible read of the newest last event (keys and window numbers only):

```sh
python3 - <<'PY'
import json, time
from pathlib import Path
files = sorted(Path('/home/goat/.codex/sessions').rglob('rollout-*.jsonl'),
               key=lambda p: p.stat().st_mtime, reverse=True)
p = files[0]
last = None
with p.open() as f:
    for line in f:
        if 'rate_limits' not in line:
            continue
        obj = json.loads(line)
        rl = (obj.get('payload') or {}).get('rate_limits')
        if isinstance(rl, dict):
            last = {k: rl.get(k) for k in
                    ('plan_type','limit_id','primary','secondary')}
            last['event_ts'] = obj.get('timestamp')
print(p.name, time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(p.stat().st_mtime)))
print(last)
PY
```

**What it contained at measurement.** Newest live rollout
`rollout-2026-08-15T16-33-32-…jsonl`, last event `2026-08-15T19:34:06Z`
(seconds old while a Codex session was writing):

- `plan_type`: `prolite`
- `primary.used_percent`: `64.0`
- `primary.window_minutes`: `10080` (7 days)
- `primary.resets_at`: `1787226082` = `2026-08-20T11:41:22Z`
- `secondary`: absent / not an object

**Schema changed in July.** Across all 837 rollouts, last `rate_limits`
event per file:

| Period | `primary.window_minutes` | `secondary` |
|---|---|---|
| 2025-12-06 → 2026-07-11 | `300` (5 h) | object, `window_minutes=10080` |
| 2026-07-16 → today | `10080` (7 d) | not present |

583 historical files have a `secondary` object. The newest 80 have none.
A reader that assumes `primary` = 5 h and `secondary` = weekly will miss
today's weekly entirely, or report a 5-hour window that the payload no
longer carries.

Sqlite does **not** hold account remaining: `threads.tokens_used` and
`thread_goals.token_budget` are per-thread spend, not plan remaining.

**Tachyon already collects this.** `CodexAppServerObservationSource`
spawns `codex app-server --stdio` and calls `account/rateLimits/read`.
That is the local Codex binary using the user's existing login, not a
new Tachyon API. It classifies windows by duration (`≤1440 min` →
session, `≤20160 min` → weekly), so today's `primary=10080` is reported
as `weekly`. Last-good in the running engine
(`tachyon.runtimeObservability.lastGood.v1` inside
`/home/goat/tachyon/.tachyon/dev-host/state/tachyon/engines/eb13c881da854a88359a130fdf6ae436/state/state.json`)
matched the file at `2026-08-15T19:39:42Z`: weekly 64%, reset
`2026-08-20T11:41:22.000Z`, `confidence: exact`, `integrity: firm`.

Bridge tool `runtime_condition` (already live, cached, starts no process)
returns the same number.

### Claude — `/home/goat/.claude`

**What is there.** Home exists (`.claude.json` `firstStartTime` on this
copy `2026-08-06`; `stats-cache` daily series from `2026-01-03`;
`sessions/` files from `2026-04-11`). 30 top-level entries. Session
transcripts live under `projects/<cwd-slug>/*.jsonl` (131 files; newest
`2026-08-15T15:27:29Z`).

**There is no remaining-quota file.**

| Path | What it actually holds | Age at measurement | Remaining / limit / resetAt? |
|---|---|---|---|
| `stats-cache.json` | Historical token spend by model + daily activity. `lastComputedDate=2026-07-08` | 38 days | No |
| `projects/**/*.jsonl` | Per-turn `message.usage` (`input_tokens`, `output_tokens`, cache, `service_tier`) | newest ~4 h | No remaining, no limit, no reset |
| `.claude.json` `oauthAccount` | Billing type `stripe_subscription`, tier `default_claude_max_5x`, extra-usage flags | file mtime `2026-08-06` | Plan identity, not current remaining |
| `settings.json` | Permissions + a `statusLine` command | — | No quota |
| `claude auth status --json` | keys `loggedIn`, `authMethod`, `apiProvider` only | live | No quota (confirms the product comment) |

Reproducible key check on `stats-cache.json`:

```sh
python3 - <<'PY'
import json, time
from pathlib import Path
p = Path('/home/goat/.claude/stats-cache.json')
d = json.loads(p.read_text())
print('mtime', time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(p.stat().st_mtime)))
print('lastComputedDate', d.get('lastComputedDate'))
print('top_keys', sorted(d.keys()))
print('has_rate_limits', 'rate_limits' in d)
PY
```

**The only remaining-quota channel is a running session's status-line.**
Claude injects `rate_limits.five_hour.{used_percentage,resets_at}` and
`rate_limits.seven_day.{used_percentage,resets_at}` into the status-line
command stdin (fixture pin: `test/fixtures/claude-status-line-v2.1.209.json`).
Tachyon already wraps that command and writes a reduced capture under
the engine's `runtime-observability-v1/claude-status-line/`.

On this host that capture file existed and was **empty**:

```text
/home/goat/tachyon/.tachyon/dev-host/state/tachyon/engines/eb13c881da854a88359a130fdf6ae436/state/runtime-observability-v1/claude-status-line/ps_9e17bce000cdde9edf5068eba370bb2c/33c7430584040d0140bc9047e3c64848.capture.json
{"schemaVersion":1,"observedAt":"2026-08-15T15:46:47.257Z","rate_limits":{}}
```

Persisted last-good for Claude (same `state.json`) was still
`2026-08-15T01:41:33Z` — session 10% used, reset `03:40:00Z` (already
past); weekly 33%, reset `2026-08-18T11:00:00Z`. The stored fact labels
itself `fresh` because freshness is snapshotted at observe time, not
recomputed on read.

The live Bridge tool `runtime_condition` at `19:39:20Z` showed a
*different* Claude reading (session 8% reset `22:30:00Z`, weekly 38%).
That means a running Claude session was feeding the in-memory collector
while the on-disk capture stayed empty and last-good stayed 18 h old.
I did not find the capture file that produced the 19:39 reading.

So: idle disk is not decision-grade. A live session can be. The two
disagree, and the persisted number can describe a window that has
already reset.

### Grok — `/home/goat/.grok`

**What is there.** Home exists. 213 session dirs since
`2026-07-17T14:42:10Z`, newest this turn. Every session has
`summary.json`, `system_prompt.txt`, `chat_history.jsonl`,
`events.jsonl`; most also have `updates.jsonl` and `signals.json`.
Zero files whose name contains usage / rate / quota / limit.

**What usage exists is session spend, not account remaining.**

`updates.jsonl` → `params.update.usage`:

- keys: `inputTokens`, `outputTokens`, `totalTokens`, `cachedReadTokens`,
  `cacheCreationTokens`, `reasoningTokens`, `modelCalls`, `costUsdTicks`,
  `numTurns`, `modelUsage`
- `modelUsage['grok-4.6-build']` repeats the token fields
- no remaining, no limit, no reset, no plan window

`signals.json` (newest session): `contextTokensUsed=248146`,
`contextWindowTokens=500000`, `contextWindowUsage=49` — context-window
fill of *this* session, not xAI account quota.

`grok inspect --json` (Grok `1.0.4`, this worktree as cwd) top-level
keys: `agents`, `channel`, `configSources`, `cwd`, `externalCompat`,
`grokVersion`, `hooks`, `loginPolicy`, `lspServers`, `marketplaces`,
`mcpServers`, `permissions`, `plugins`, `projectInstructions`,
`projectRoot`, `projectTrusted`, `skills`. Walk for
usage/rate/quota/limit/reset/percent: **NONE**.

Reproducible:

```sh
grok inspect --json | python3 -c '
import json,sys
obj=json.loads(sys.stdin.read())
print(sorted(obj))
'
```

Tachyon already declares this: `ProviderConfigurationFactV1.quotaChannel`
is `{state:"unsupported", reason:"no-quota-channel"}`.
`runtime_condition` reports Grok capacity as `no quota channel` by name
and refuses to emit zeros.

The probe-matrix `provider-usage` evidence on Grok is **which model ran**
(session `modelUsage` keys), not how much account quota remains. Same
for Claude session JSONL. That path does not answer today's question.

## 2. Is the local datum reliable enough to change a decision?

**Codex — yes, for the weekly window that the payload currently
carries.** Three independent local reads agreed within seconds: newest
rollout last event, engine last-good, `runtime_condition`. All said 64%
of a 10080-minute window, reset `2026-08-20T11:41:22Z`. That is exactly
the class of fact that should have blocked or warned before a second
Codex spawn. Confidence: `exact` while the newest rollout event (or the
collector) is newer than a few minutes. If no Codex has written for
hours, treat the file as last-known and say so — do not present it as
now.

Caveats that would make a display a lie:

- Since 2026-07-16 there is no 5-hour window in the local payload. A
  panel that still draws “5 h” from `primary` is inventing.
- `secondary` is the wrong field for weekly on this plan today.
- Rollouts contain full conversation text. A monitor must project
  `rate_limits` only.

**Claude — no, not from files you can read when nothing is running.**
`stats-cache.json` is 38-day-old spend. Session JSONL is per-turn
tokens. The status-line *can* be decision-grade, but only while a
Claude session is rendering, and even then Tachyon labels it
`best-effort` because it is parsed off a human surface. Using the
persisted last-good without recomputing age against `now` would have
shown a 5-hour window that had already reset — the failure mode the
brief named. I will not put that number on a panel.

**Grok — no.** There is no remaining-quota channel. Session tokens and
context-window % are not account headroom. Showing them as remaining
would be a lie. The honest answer is the one the product already has:
`no quota channel`.

## 3. Common model

Tachyon already has one, and it is the right shape when a source
exists:

```text
provider, accountScope (opaque ps_… key — never email),
windows[]: { name: session|weekly|tertiary, usedPercent, windowMinutes?, resetsAt? },
confidence: exact|estimated|unknown,
freshness: fresh | stale{lastGoodAt},
integrity: firm | best-effort
```

Do not add a fourth schema.

Where the three runtimes refuse to unify:

| Field | Codex | Claude | Grok |
|---|---|---|---|
| remaining % | yes (weekly only, today) | yes, only from a live status-line | **absent** |
| limit / plan remaining tokens | not in the local payload (percent only) | not in the local payload (percent only) | absent |
| resetAt | yes, unix seconds in the rollout | yes, when the status-line emits it | absent |
| 5 h window | gone from local files since 2026-07-16 | yes, when live | absent |
| account identity | `plan_type=prolite` in the rollout; Tachyon stores an opaque key | billing/tier in `.claude.json` (do not copy email into a panel) | login exists; no quota identity |
| integrity | firm (machine protocol + file echo) | best-effort (rendered surface) | no channel |

Grok must stay `no-quota-channel`. Filling `used=0` is the lie
`runtimeCondition.ts` was written to prevent.

## 4. Proposed surface (one sentence, if the owner says yes)

Before spawn, the coordinator reads the existing Bridge tool
`runtime_condition` and treats stale / absent / `no quota channel` as
unknown — never as a green light and never as a spawn block.

That is a proposal for the owner, not a request to implement. The
collector, the last-good store, the projection, and the Bridge tool
already exist (`t-458497` / `src/runtimeObservability/` /
`src/runtimeOps/runtimeCondition.ts`). Today's incident is that nobody
looked. Fail-open is already the contract: a missing or uncertain read
must not refuse an agent. An 80% chip that is not wired to a human or
coordinator action should not become a badge (owner's prior cut).

If a later increment wants a human glance, it should be the same
cached projection — one line per runtime, freshness visible, Grok
literally `no quota channel` — not a second number invented from
session tokens.

## 5. What I did not measure (and why)

- **`/tmp/orca-re` is gone** (journal 2026-08-06). Public Orca docs still
  claim they read `~/.claude` / `~/.codex` with no API; prior Tachyon
  research `t-5f4294` found Orca source calling
  `https://api.anthropic.com/api/oauth/usage`. I did not re-clone Orca
  and I did not call that URL. On *this* host, Claude has no
  remaining-quota file for a disk-only reader to open.
- **No Anthropic / OpenAI / xAI HTTP.** Codex `app-server` is the
  user's local CLI; I did not spawn a second one. I read the files and
  the collector that was already running.
- **Gemini, OpenCode, Kimi** — out of scope (spawn brief).
- **ccusage** (`t-f0180b`, still inbox) — not installed, not evaluated.
  Claude session JSONL has per-turn tokens; that is spend, not
  remaining. ccusage cannot invent a reset time that the files do not
  carry.
- **The capture file behind the 19:39 Claude live reading** — not found.
  The only capture on disk at that moment was the empty 15:46 file.
- **Whether `codex app-server account/rateLimits/read` talks to the
  network** — not traced. Classified as the runtime's own control plane,
  same credentials the CLI already uses. The rollout file is the
  no-process fallback and agreed with it today.
- **Session bodies** — not copied into this repository. A monitor in
  operation should read `rate_limits` / status-line projection / last-good
  only.

## Privacy — paths a monitor would touch

Normal operation should read **only**:

- `/home/goat/.codex/sessions/**/rollout-*.jsonl` — last `rate_limits`
  object on the newest file (or skip the file and use last-good).
- Engine `state.json` key `tachyon.runtimeObservability.lastGood.v1` —
  already-reduced windows, opaque `ps_…` account keys.
- Engine `runtime-observability-v1/claude-status-line/**/*.capture.json`
  — already-reduced `{observedAt, rate_limits}`.
- Bridge `runtime_condition` — no extra disk.

Must **not** open in a monitor loop:

- `/home/goat/.claude/.credentials.json`, `projects/**/*.jsonl` message
  bodies, `history.jsonl`
- `/home/goat/.codex/auth.json`, rollout message text,
  `logs_2.sqlite` (~1 GiB of debug logs), `threads.first_user_message`
- `/home/goat/.grok/auth.json`, `system_prompt.txt`, `chat_history.jsonl`,
  `events.jsonl`

Resolve homes as `/home/goat/.{claude,codex,grok}` (or the host
`CODEX_HOME` / `CLAUDE_CONFIG_DIR` if set). Do not expand `~` from an
agent process.

## Fail-open (requirement, not a suggestion)

- Missing file, empty `rate_limits`, parse error, stale last-good,
  `no quota channel` → report unknown. Never refuse spawn.
- Never block the coordinator's own Claude seat on a best-effort read.
- Never infer remaining from session token spend.
- Recompute freshness against `now` on every read. A fact that stored
  `freshness: fresh` at 01:41 is not fresh at 19:39.

## Relation to work already in the tree

- `t-71ec3b` (done) — pane-text detection + auto-continue *after* the
  stop. Reactive. Does not prevent today's dispatch mistake.
- `t-458497` / `runtimeObservability` / `runtime_condition` — the
  proactive collector and the Bridge tool. Built. Unused at dispatch.
- `t-f0180b` (inbox) — ccusage evaluation. Adjacent, not a remaining-
  quota source on this host.
- `t-a68138` — session artifacts on disk. Starting point only; those
  artifacts are spend / prompts, not remaining.

## Reproducible commands (no session text)

```sh
date -u +%Y-%m-%dT%H:%M:%SZ
claude --version; codex --version; grok --version
ls -ld /home/goat/.claude /home/goat/.codex /home/goat/.grok

# Codex newest rate_limits (see script in §1)
# Claude stats-cache keys (see script in §1)
claude auth status --json   # expect loggedIn/authMethod/apiProvider only
grok inspect --json | python3 -c 'import json,sys; print(sorted(json.loads(sys.stdin.read())))'
```

Live Tachyon read (no new process): Bridge `runtime_condition`.
