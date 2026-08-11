# Agent cost: idle vs executing (t-2be401)

**Date:** 2026-08-11  
**Host:** WSL/Linux, 24 logical CPUs  
**Measurer:** agent `agentcost` (runtime grok), worktree  
`/home/goat/.cache/tachyon/worktrees/b349073a/agentcost`  
**Constraint honored:** no synthetic load — only `/proc`, `ps`, `free`, and
`list_agents`. No vitest/npm test/spawn/build started by this agent.

Raw samples:

- `docs/research/agent-cost-t2be401-raw.json` — two samples ~8s apart (CLI + trees)
- `docs/research/agent-cost-t2be401-peak-suitefloor.json` — suitefloor mid-vitest

---

## 1. Method

| Piece | Source |
| --- | --- |
| Who is idle / working | `list_agents` → `attention` (`idle` \| `working`) |
| Resident set | `/proc/<pid>/status` `VmRSS` |
| Proportional set (shared pages fair-share) | `/proc/<pid>/smaps_rollup` `Pss` |
| Host headroom | `/proc/meminfo` `MemTotal` / `MemAvailable` / `MemFree` / swap |
| Agent attribution | exclusive markers: `bridge-mcp/<agent>.json`, `spawn-settings/<agent>.json`, `harness/<agent>/`, worktree `.../worktrees/b349073a/<agent>` — with longer-name exclusion so `claude` does not steal `claude-fork-1` |
| Workload children | descendants of the runtime CLI **plus** processes whose `cwd` is the agent worktree (vitest workers often reparent and drop out of the ppid tree) |

**RSS vs PSS.** RSS counts every mapped page in the process, including shared
libraries counted once per process. Summing RSS across the fleet **overcounts**.
PSS is the right number for fleet totals. Both are reported; conclusions use PSS
for aggregates and RSS for single-process “how big does this look”.

**What “idle” and “executing” mean here.**

- **Idle (board sense):** `list_agents.attention == idle` — no active turn.
- **Working / executing (board sense):** `attention == working` — turn in progress.
- **Executing with project load:** working **and** heavy child processes (here:
  `npm exec vitest` / `node (vitest)` under `suitefloor`). That is the cost that
  can drop a host; pure “working” without children is mostly the same CLI bill as idle.

---

## 2. Host snapshot (during measurement)

| Metric | Sample A | Sample B (CLI table) | Peak (suitefloor vitest) |
| --- | ---: | ---: | ---: |
| MemTotal | 15990 MiB | 15990 MiB | 15990 MiB |
| MemAvailable | 8253 MiB | 8121 MiB | 7904 MiB |
| MemFree | 2227 MiB | 2076 MiB | 1841 MiB |
| AnonPages | — | — | 6609 MiB |
| Swap used | 66 MiB | 66 MiB | 66 MiB |

Load average around 3 on 24 CPUs — the host was busy but not thrashing.

Non-Tachyon residents also matter (Docker stack on this machine: logflare
~650 MiB, clickhouse ~420 MiB, plausible ~480 MiB, next-server ~240 MiB, plus
VS Code server). A floor that only looks at agent CLIs and ignores the rest of
the host would still be wrong; `MemAvailable` already folds them in.

---

## 3. Per-agent CLI cost (runtime only)

Board state at measure time (running agents):

| Agent | attention | runtime |
| --- | --- | --- |
| claude | idle | claude |
| claude-fork-2 | idle | claude |
| claude-fork-1 | working | claude |
| budgetclose | working | claude |
| deadrow | working | claude |
| suitefloor | working | claude |
| specstatus | working | codex |
| stoppath | working | codex |
| agentcost | working | grok |

### 3.1 CLI RSS / PSS by runtime (primary process)

Numbers from the peak sample (~14:27 local), primary runtime binary only:

| Agent | attention | runtime | CLI RSS (MiB) | CLI PSS (MiB) |
| --- | --- | --- | ---: | ---: |
| claude-fork-2 | **idle** | claude | **373.8** | **266.1** |
| claude | **idle** | claude | **554.0** | **441.1** |
| budgetclose | working | claude | 483.3 | 369.5 |
| suitefloor | working | claude | 495.4 | 382.0 |
| deadrow | working | claude | 512.0 | 398.5 |
| claude-fork-1 | working | claude | 534.1 | 421.0 |
| specstatus | working | codex | 218.9 | 158.1 |
| stoppath | working | codex | 221.1 | 160.2 |
| agentcost | working | grok | 148.0 | 78.6 |

**Codex tree** (not just the `codex` binary): node wrapper (`MainThread` ~
49 MiB) + `codex` (~220 MiB) + `codex-code-mode` (~17 MiB) ≈ **~285 MiB RSS /
~195 MiB PSS** per agent when idle-of-workload.

**Grok tree:** CLI ~140–150 MiB RSS / ~80 MiB PSS, plus small helpers
(`systemd-inhibit`/`sleep infinity` ~7 MiB each) while a turn is open.

### 3.2 Idle vs working — CLI layer

| Cohort | n | CLI RSS range (MiB) | CLI PSS range (MiB) | median-ish CLI RSS |
| --- | ---: | --- | --- | ---: |
| Claude **idle** | 2 | 374 – 554 | 266 – 441 | ~464 |
| Claude **working** (no / light children) | 4 | 483 – 534 | 370 – 421 | ~504 |
| Codex working | 2 | 219 – 221 | 158 – 160 | ~220 |
| Grok working | 1 | 148 | 79 | 148 |

**Finding (decisive):** at the runtime CLI layer, **idle vs working is not a
useful cost axis**. An idle long-lived Claude can cost **more** than a working
short-lived one (`claude` idle 554 MiB RSS vs `budgetclose` working 483 MiB).
What dominates CLI size is **session age / context / model baggage**, not the
attention bit. A floor derived from “idle agent = X, working = k·X” would be fiction.

### 3.3 Executing with real project load (the natural experiment)

`suitefloor` was mid-`npx vitest run test/unit/...` during the peak sample.
Attribution = CLI + every process with `cwd` under its worktree:

| Component | RSS (MiB) | PSS (MiB) |
| --- | ---: | ---: |
| claude CLI | 495.4 | 382.0 |
| `npm exec vitest` | 88.1 | 48.3 |
| `node (vitest)` | 142.4 | 102.5 |
| `node (vitest 1)` | 182.5 | 142.0 |
| `esbuild` | 17.5 | 17.5 |
| shells | ~7 | ~2 |
| **suitefloor total** | **937.3** | **694.3** |
| **workload only (total − CLI)** | **~442** | **~312** |

Earlier in the same hour (first broad `ps` pass, different unit file) the same
agent’s vitest workers were larger (~159 + ~197 + ~87 ≈ **443 MiB** on top of a
~483 MiB CLI; at another moment workers hit ~363 + ~289 + ~88 ≈ **~740 MiB**
workload RSS before shrinking). So **one agent running this repo’s unit tests
adds roughly 0.4–0.7+ GiB RSS on top of a ~0.5 GiB Claude CLI**, for a
**~0.9–1.2+ GiB** agent tree while tests run.

When the vitest children exit, the same agent falls back to CLI-only (~480 MiB).
The board still shows `working` either way — attention does not encode “holding
a test suite”.

---

## 4. Fleet total and host remainder

### 4.1 Agent fleet (9 running)

| Aggregate | RSS sum (MiB) | PSS sum (MiB) | Note |
| --- | ---: | ---: | --- |
| All primary CLIs | ~3541 | ~2675 | RSS overcounts shared pages |
| Agent trees (CLI-only sample, little workload) | ~3841 | ~2832 | raw.json sample 1 |
| suitefloor full tree at vitest peak | 937 | 694 | replaces that agent’s CLI-only row |

Rough **Tachyon-related** residents at peak (PSS where available):

| Bucket | ~PSS or RSS (MiB) |
| --- | ---: |
| 9 agent CLIs (PSS) | ~2675 |
| suitefloor workload extra (PSS) | ~312 |
| `tachyon-engine` | ~400–500 RSS≈PSS |
| VS Code extensionHost (Tachyon lives here) | ~692 PSS |
| tmux `-L tachyon` server | ~14–18 |
| **Order-of-magnitude Tachyon-ish** | **~4.1–4.3 GiB** |

### 4.2 What the machine still had

At peak: **MemAvailable ≈ 7.9 GiB** of **16.0 GiB** total. Swap barely touched
(66 MiB). The host was **not** in the failure regime of 09–10/08 during this
window — the natural experiment is “mixed idle + working + one real test load”,
not “eight parallel full suites”.

### 4.3 Scaling sketch (arithmetic on measured bases, not a new run)

Using measured Claude CLI ≈ **0.5 GiB RSS** and one vitest unit burst ≈ **0.45–0.7 GiB**:

| Scenario | Ballpark resident |
| --- | --- |
| 8 idle Claude agents | ~3.0–4.4 GiB CLI alone |
| 8 Claude agents each mid-unit-vitest | ~8 × (0.5 + 0.5) ≈ **8 GiB** agents only |
| + engine + extensionHost + Docker on this host | easily **12–16+ GiB** |

Default `maxAgents: 8` (README) therefore **permits** a fleet whose project
commands alone can exhaust a 16 GiB WSL VM. That matches the task’s product
hole: **quantity cap without cost awareness**.

---

## 5. Is a door-refusal floor defensible?

### 5.1 What the numbers do **not** support

- **A floor from “idle MiB vs working MiB”.** CLI idle ≈ CLI working. The
  dangerous delta is **workload children**, which `attention` does not measure.
- **A fixed “one agent costs X, so maxAgents = Mem/X”** using only CLI X.
  Underestimates by ~2× when every agent runs tests; overestimates safety.
- **Continuous RAM rationing of the user’s project commands.** Out of scope for
  this task; product must not throttle work it does not understand
  (project-guidance: machinery is last resort; this would be the expensive joke
  the task forbids).

### 5.2 What **is** defensible (information or refuse-at-door only)

Defect prevented: **host memory exhaustion / machine freeze when the fleet’s
concurrent work exceeds RAM.**  
When it happened: **this environment, three times** (t-6a9bc4, t-3ad4af,
2026-08-10). **Not yet measured at a third-party install** — so design carefully,
do not ship a clever controller.

| Candidate | Defensible? | Basis from this measurement |
| --- | --- | --- |
| **Show fleet cost in Runtime Ops** (sum CLI RSS/PSS + optional child sum; already have `readHostMemory`) | **Yes — cheapest honest step** | Product already reads MemAvailable; missing piece is the agent↔bytes join we just did by hand |
| **Warn when N agents have heavy children** (vitest/node test workers, etc.) | **Yes — information** | suitefloor was the only agent with ~0.4–0.7 GiB extra; that is the signal |
| **Refuse spawn when `MemAvailable` &lt; floor** | **Conditionally yes** | Coarse OS headroom. Numbers here: host stayed ≥7.9 GiB available with 9 agents + one vitest; the 09–10/08 class of failure is when available collapses. A floor of **~1.5–2.0 GiB MemAvailable** (refuse new spawn) is a **plausible default order of magnitude** for “leave room for OS + one new Claude CLI (~0.5 GiB) + buffer”, **not** a proof of optimality. Must be configurable; must not pretend to budget the user’s test suite |
| **Reserve `maxAgents × cliBaseline` against MemAvailable** | **Weak alone** | cliBaseline ≈ 0.4–0.5 GiB Claude / 0.3 GiB Codex / 0.15 GiB Grok is measurable, but concurrent workload is the real cliff |
| **Continuous cgroup / kill / throttle of user commands** | **No (this task)** | Product does not know what the command is for |

**Honest floor statement:** these numbers **support a MemAvailable door check**
as a **coarse last-line refuse**, and **support displaying per-agent / fleet
resident cost**. They **do not** support a precise per-spawn “this agent will
cost X for its whole life” number, and they **do not** justify continuous
rationing. A floor that only reserves CLI baseline would still allow eight
parallel `npm test` to freeze the machine — so if a door exists, it should be
framed as **host headroom**, not **agent price**.

Suggested starting point for a *proposal* (not implemented here):

```
refuse spawn if MemAvailable < max(
  settings.minHostMemAvailableMb,        // e.g. 1536–2048
  settings.spawnReserveMb                // e.g. ~512 for Claude-class CLI
)
```

…and always **surface** current fleet PSS/RSS + MemAvailable in Runtime Ops so
the human can see the cliff before the door hits them.

---

## 6. Direct answer: does a third-party Tachyon install share the crash risk?

**Yes — the product-shaped risk is real; the suite-shaped accidents of this repo are not.**

### Half A — does **not** ship to users (already established, reconfirmed by scope)

- Vitest RAM rationing (`admitOrFallback` / `previewVitestShare`) is **this
  repository’s test config**, not packaged product behavior for arbitrary projects.
- The 1719 tmux-server leak was **fixture/suite paths** (`TMUX_TMPDIR` under
  test sockets). Product fleet tmux here is **one** primary server
  (`tmux -L tachyon`, ~18 MiB) plus leftover smoke servers — not thousands.

### Half B — **does** ship, and is enough to recreate the failure mode

- Product limits **how many** agents exist (`settings.maxAgents`, default **8**).
- Each agent runs **whatever the user/project tells it** — including that
  project’s `npm test` / vitest / builds.
- Measured: **one** Claude agent mid-unit-vitest on this codebase ≈ **0.9–1.2 GiB**
  resident; **CLI alone** ≈ **0.4–0.55 GiB** even when idle.
- **Eight** such agents in parallel need no Tachyon bug to pressure a 16 GiB
  machine — only spawn permission and heavy commands. That is exactly the hole
  named in t-2be401.

So the owner’s question — *“nada desse problema vai acontecer por causa do
produto tachyon em projetos que utilizem tachyon né?”* — splits:

| Failure mode | Product responsibility? |
| --- | --- |
| Our vitest budget / suite tmux leak taking down the host | **No** (local harness) |
| Fleet of N agents each running the **user’s** heavy commands with only a count cap | **Yes — product gap** |

Nothing measured today says “users are safe.” It says “users are safe from
*our* harness bugs; they are **not** protected by Tachyon from *their own*
concurrent agent workloads.”

---

## 7. Machinery guard (project-guidance)

> Before adding machinery, say which defect it prevents and when that defect last happened.

| | |
| --- | --- |
| Defect | Host OOM / interactive freeze under multi-agent concurrent work |
| Last happened | This maintainer host, 2026-08-09/10 (and earlier t-6a9bc4, t-3ad4af) |
| Happened to third-party Tachyon user? | **Not observed** |
| Therefore | Prefer **information + optional door refuse**; do **not** rush continuous control; do **not** re-implement project-RAM rationing inside the product |

---

## 8. Summary table (use this in the doorbell)

| Quantity | Measured value |
| --- | --- |
| Idle Claude CLI | **~374–554 MiB RSS / ~266–441 MiB PSS** (context-dominated) |
| Working Claude CLI (no suite) | **~480–535 MiB RSS / ~370–420 MiB PSS** |
| Idle≈Working at CLI? | **Yes — attention bit ≠ memory** |
| Codex agent tree | **~285 MiB RSS / ~195 MiB PSS** |
| Grok CLI | **~150 MiB RSS / ~80 MiB PSS** |
| Claude + mid unit-vitest | **~0.94 GiB RSS / ~0.69 GiB PSS** (workload +0.44 GiB RSS) |
| Fleet 9 CLIs | **~3.5 GiB RSS / ~2.7 GiB PSS** |
| Host at peak | **16 GiB total, ~7.9 GiB MemAvailable** |
| Door floor | **MemAvailable headroom (~1.5–2 GiB) defensible; idle/working delta is not** |
| Third-party risk | **Yes for concurrent user workloads; no for our harness-only bugs** |

---

## 9. Non-goals / not done

- No product code, no `tachyon.yml` edits, no merge/push/tag.
- No continuous rationer design beyond the refuse-at-door sketch.
- No multi-hour sampling; two CLI samples + one vitest peak. Workload amplitude
  will vary by project; **re-measure on a consumer app before hardening any default**.
