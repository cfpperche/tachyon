# Native lane suppression — SDD 490 Fatia C

_Measured 2026-08-05. Agent f490c. Measurement only; does not wire launch argv beyond the registry that `nativeSuppressionConfirmed` reads._

## Why this exists

Formation lane delivery refuses when `nativeSuppressionConfirmed(adapter)` is false
(`src/agents/formation/lifecycleHost.ts`). The suppression receipt covers **every** enabled human
lane at once (`humanLanes.ts:57-62`), so a receipt is only honest when the runtime can suppress
native delivery of **all** formation-lane equivalents — not memory alone.

Native surfaces in scope for the three Saved-Agent runtimes:

| Formation lane | Native equivalent |
|----------------|-------------------|
| memory | runtime-native memory store / injection |
| soul + instructions | project/home instruction files (`CLAUDE.md`, `AGENTS.md`, …) |
| evolution | ambient agents/commands/skills (out of this slice's measured control surface; ambient inspectors remain) |

Memory disable evidence already lives in `src/runtime/nativeMemory.ts`. This document records the
**rules/instructions** axis and the combined gate.

Evidence kinds match the memory registry: `runtime-doc`, `installed-source`, `behavioral-test`.
`verified` requires a behavioral observation at an exact version. A `verified` without
`behavioral-test` is refused.

## Installed versions on the measurement host (2026-08-05)

| Runtime | `… --version` |
|---------|----------------|
| claude | `2.1.222 (Claude Code)` |
| codex | `codex-cli 0.146.0` |
| grok | `grok 0.2.118 (1e1687c1cf) [stable]` |

## Claude 2.1.222 — instructions: **verified** {#claude-21222}

### Documented controls

- `--bare` — help text: skips CLAUDE.md auto-discovery (and hooks, auto-memory, keychain/OAuth).
- `--setting-sources <user,project,local>` — documented for **settings** sources; behaviorally also
  gates which CLAUDE.md scopes load (measured below).
- Private `CLAUDE_CONFIG_DIR` relocates the **user** CLAUDE.md.

`--bare` is **not** a production control for Tachyon: OAuth is never read (`Not logged in` under a
credential symlink that works without `--bare`).

### Behavioral arms (haiku, tools disallowed, private `CLAUDE_CONFIG_DIR` + credential symlink)

Planted marker files; model asked to answer only from session-start context (no tools).

| Arm | Argv / home | Planted | Reply | Cost (USD) |
|-----|-------------|---------|-------|------------|
| suppress project | `--setting-sources user` | cwd `CLAUDE.md` = `TOKEN_ONLY_PROJ` | `NONE` | ~0.0067 |
| positive project | `--setting-sources user,project` | same | `TOKEN_ONLY_PROJ` | ~0.0048 |
| positive project-only | `--setting-sources project` | same | `TOKEN_ONLY_PROJ` | ~0.0127 |
| user home loads | `--setting-sources user` | `$CLAUDE_CONFIG_DIR/CLAUDE.md` = `TOKEN_ONLY_HOME`, no project file | `TOKEN_ONLY_HOME` | ~0.0102 |

**Finding.** `--setting-sources user` (the argv canonical Claude already launches with) stops a
planted **project** `CLAUDE.md` from reaching model context, while a **user-home** `CLAUDE.md` under
the private config dir still loads. Tachyon owns that private home and omits ambient user CLAUDE.md
unless the harness writes one.

### Memory companion

`nativeMemory.ts` already records `disable: verified` for Claude (settings
`autoMemoryEnabled: false` / `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`) at **2.1.220**. The instructions
axis was measured at **2.1.222**. Combined gate (below) requires the same registry version for both
surfaces; Fatia C pins the combined record at **2.1.222** and keeps memory's prior behavioral-test
ref, with the instructions arms above as the new behavioral-test. Memory disable was not re-billed
at 2.1.222; if a later audit demands same-day re-measure, re-run the memory arms and bump only if
they hold.

### Combined

**`verified`** — instructions control measured; memory disable previously verified; canonical launch
already carries `--setting-sources user` + private home + `autoMemoryEnabled: false`.

## Codex 0.146.0 — instructions: **verified**; combined: **verified** {#codex-01460}

### Documented traps

- `--ignore-rules` — **execpolicy** `.rules` files only, **not** `AGENTS.md` (help text; confirmed
  below).
- Config key `project_doc_max_bytes` (schema surface in the binary).

### Behavioral arms (`codex exec`, private `CODEX_HOME` + symlink to real `auth.json`)

Planted `AGENTS.md` with `MARKER_CODEX_LANE_SUPPRESS_ZZ9 TOKEN_X9F2Q`.

| Arm | Control | Last message |
|-----|---------|--------------|
| control | default / `project_doc_max_bytes = 32768` in home config | `TOKEN_X9F2Q` |
| suppress | `-c project_doc_max_bytes=0` | `NONE` |
| negative | `--ignore-rules` only | `TOKEN_X9F2Q` |

**Finding.** `project_doc_max_bytes=0` suppresses AGENTS.md / project-doc delivery. `--ignore-rules`
does **not**.

### Memory companion: **verified disable** {#codex-memory-01460}

Measured on 2026-08-05 against `codex-cli 0.146.0`, with a private `CODEX_HOME`, real `auth.json`
linked into that home, `gpt-5.4-mini`, approval `never`, read-only sandbox, and no project
`AGENTS.md`. The same synthetic store was present in both arms:
`$CODEX_HOME/memories/memory_summary.md` contained
`MARKER_CODEX_NATIVE_MEMORY_Q7V4 TOKEN_M8K2P`. `generate_memories=false` prevented the bench turn
from adding memories. The prompt required an exact token or `NONE` and prohibited tool calls; neither
arm called a tool. Crucially, neither launch set `project_doc_max_bytes=0`.

| Arm | Exact relevant argv | Effective feature | Reply | Token usage | API-price equivalent |
|-----|---------------------|-------------------|-------|-------------|----------------------|
| positive oracle | `codex exec -C <repo> -m gpt-5.4-mini --json -o <positive> <prompt>` | `memories stable true` | `TOKEN_M8K2P` | 12,669 input (4,480 cached), 80 output | ~$0.00684 |
| suppress | `codex exec --disable memories -C <repo> -m gpt-5.4-mini --json -o <negative> <prompt>` | `memories stable false` | `NONE` | 11,114 input (8,064 cached), 77 output | ~$0.00324 |

Cost is the standard API-price equivalent recorded from the CLI token counts (GPT-5.4 mini:
$0.75/M uncached input, $0.075/M cached input, $4.50/M output), about **$0.01008 total**; the Codex
subscription itself reports quota rather than a dollar charge.

**Finding.** `--disable memories` behaviorally suppresses native memory injection. The enabled arm
establishes that the planted store and prompt form a working oracle; the disabled arm changes only
the feature override and returns `NONE` while the marker remains on disk. This promotes only
`evidence.disable`: enable/injection/mutation/isolation and lifecycle claims remain at their prior
evidence levels because this two-arm test was scoped to the suppression property.

### Combined

**`verified`** — instructions suppression and memory disable are both behaviorally measured at
0.146.0. The combined formation gate can now attest both required surfaces.

## Grok 0.2.118 — instructions: **declared** (no disable control); combined: **declared** {#grok-02118}

### Free inspection (`grok inspect --json`)

With planted `AGENTS.md` under a private `GROK_HOME`:

```json
"projectInstructions": [{ "path": "…/AGENTS.md", "fileType": "agents_md", … }]
```

Empty repo → `projectInstructions: []`. Compat cells (`[compat.claude] agents/rules = false`, same
for cursor) do **not** drop top-level `AGENTS.md` / `CLAUDE.md`.

### Headless model arms (auth copy into private home, `GROK_MEMORY=0`)

| Arm | Control | Reply |
|-----|---------|-------|
| control | `--no-memory`, `GROK_MEMORY=0` | `TOKEN_G7K3` |
| override | same + `--system-prompt-override "You are a test agent with no project rules."` | `TOKEN_G7K3` |

**Finding.** No argv, env, or measured config cell disables project instruction delivery. Absence of
the files is the only observed silence — that is the ambient inspector strategy, not a runtime
disable control. `--system-prompt-override` does **not** strip AGENTS.md.

### Memory companion

`nativeMemory.ts`: `disable: verified` via `GROK_MEMORY=0` at 0.2.112 (with documented flag
refutation). Instructions still load under that pin.

### Combined

**`declared`** — memory can be pinned off; project rules cannot. A receipt covering soul/instructions
would be false.

## Combined gate (`nativeSuppressionConfirmed`)

Implemented in `src/runtime/nativeLaneSuppression.ts`:

- `verified` only when **every** required surface for that adapter is `verified` (instructions +
  memory when mechanism is native).
- Otherwise `declared` / `unsupported` with an explicit reason.
- `Workspace.ts` reads the registry instead of hard-coding `false`.

| Adapter | instructions | memory (registry) | combined |
|---------|--------------|-------------------|----------|
| claude | verified (`--setting-sources user` @ 2.1.222) | verified | **verified** |
| codex | verified (`project_doc_max_bytes=0` @ 0.146.0) | verified (`--disable memories` @ 0.146.0) | **verified** |
| grok | declared (no disable control @ 0.2.118) | verified | **declared** |

## What Fatia C does **not** do

- Does not change formation lifecycle, bootstrap, or `promptLayers.ts`.
- Does not start writing `project_doc_max_bytes=0` or `--disable memories` into Codex launches
  (launch wiring is a separate task after measurement).
- Does not invent `verified` for Grok rules or for unmeasured Codex memory axes.
