# 226 — tachyon-isolated-harness

_Created 2026-06-16._

**Status:** IMPLEMENTED + REVIEWED 2026-06-16 (claude-only mcp-only MVP) — all hardening H1-H9 + the
codex implementation review (2 BLOCKER + 3 MAJOR + 1 MINOR) folded in; 554 unit tests + typecheck +
build green. NOT yet shipped (awaiting the maintainer's `vsce publish` → 0.22.0 + site banner). Research
done, decisions locked (below), both codex passes (design debate + impl review) folded in — see notes.md.
H7 `${VAR}`-expansion verified live. Dogfood pin `p-ea86ad`. Feeds the loop-engineering thread (`p-bf1d7d`).

**UI impact:** ui (a per-agent `harness:` config surface + an "isolated harness" tree affordance).

**Naming:** the capability is **"isolated harness"** (yaml key `harness:`), NOT a "specialist agent"
— see Decision 0. "Specialist" survives only as informal pitch copy, never a schema noun or tree label.

## Intent

Let an agent run with **its own harness config** — MCP servers, skills, rules, hooks — that does
**NOT leak to the other agents** in the fleet. Example: a single `claude` agent that has the **fal.ai
MCP** attached; no other agent (and ideally not the human's default runtime) sees that MCP. An agent
with an isolated harness may **inherit** from the workspace/global config or start from a **clean
slate**, but its own additions are scoped to itself.

Why this matters: today a `.mcp.json` / `~/.claude` / `~/.codex` config is **fleet-wide** (every claude
agent in a workspace shares it). A team of agents can't have one heavy-MCP researcher, one minimal
coder, and one reviewer-with-different-rules without polluting all of them. Per-agent harness isolation
is the missing primitive — and it extends a capability Tachyon **already has** (per-agent `env:`).

## What already exists (build ON this, not around it)

- **Per-agent `env:`** — `AgentDef.env` (`src/config/loadConfig.ts:47`) is already parsed, validated,
  and threaded into the spawned command. Setting a config-home env var per agent is the lever.
- **Per-runtime adapter abstraction** — `src/resume/adapters.ts` already maps a runtime → its
  command/flag shape (`ADAPTERS`, `INSTRUCTION_ARG`, `forkCommand`). The harness-materialization shape
  is per-runtime and belongs in the same abstraction.
- **Worktree isolation** — `WorktreeManager` already gives an agent its own cwd; an isolated-harness
  agent's cwd-discovered config (claude `CLAUDE.md`/`--add-dir`, codex `AGENTS.md`) composes naturally.

## Capability research — VERIFIED LIVE (2026-06-16; see notes.md)

Both runtimes expose **(a)** a config-home env var for total isolation and **(b)** finer per-flag
overlays. This is the whole feasibility story — no fork of either CLI needed.

| Concern | claude 2.1.179 | codex 0.139.0 |
|---|---|---|
| **Total isolation (own config home)** | `CLAUDE_CONFIG_DIR=<dir>` env → own settings.json, hooks, skills, plugins, auth, memory | `CODEX_HOME=<dir>` env → own config.toml incl. `[mcp_servers.*]`, profiles |
| **MCP scoped to just this agent (no leak)** | `--mcp-config <file…>` + `--strict-mcp-config` (ONLY those servers; ignores global + project `.mcp.json`) | own `CODEX_HOME`, or `-c mcp_servers.<name>.command=…` inline; `codex mcp add/remove` |
| **Skills / plugins** | `--plugin-dir <dir/.zip>` (skills+commands+hooks bundle); `--disable-slash-commands` | bundled in `CODEX_HOME` |
| **Rules / system prompt** | `--add-dir <dir…>` (CLAUDE.md context), `--append-system-prompt`, `--system-prompt-file` | `AGENTS.md` (cwd-discovered — composes with the worktree cwd) |
| **Clean slate (inherit nothing)** | `--bare` (skips hooks, auto-memory, CLAUDE.md auto-discovery; opt back in via `--mcp-config`/`--settings`/`--add-dir`/`--plugin-dir`/`--agents`) | fresh empty `CODEX_HOME` |
| **Partial inheritance** | seed base config into the isolated dir, then overlay | `-p <profile>` layers `$CODEX_HOME/<name>.config.toml` over the base |

**Key guarantees this gives us:**
- *No-leak* is real: an isolated harness's MCP/skills/hooks live in its own config home (or behind
  `--strict-mcp-config`), so a sibling agent spawned without that config simply never sees them. MCP
  servers are already per-process child processes — the "leak" being solved is **config visibility**,
  not runtime process sharing.
- *Inheritance is a choice*: `none` (clean slate / `--bare` / empty `CODEX_HOME`), `workspace` (seed
  from the project `.mcp.json`/`.claude`/`.codex`), or `global` (seed from `~/.claude`/`~/.codex`).

## Design sketch (locked direction — codex debate may refine mechanism)

A declarative **`harness:` block per agent** in `tachyon.yml` that Tachyon **materializes** into an
isolated config home and wires via the existing per-agent `env:` + the per-runtime adapter.

```yaml
agents:
  researcher:
    cmd: claude
    harness:
      inherit: workspace        # none | workspace | global   (default: workspace)
      mcp:                      # servers scoped to THIS agent only
        fal-ai:
          command: npx
          args: ["-y", "@fal-ai/mcp"]
          env: { FAL_KEY: "${FAL_KEY}" }
      skills: ["./skills/research"]   # extra skill/plugin dirs (optional)
      rules:  ["./rules/researcher.md"] # extra CLAUDE.md/AGENTS.md context (optional)
      hooks:  { ... }                 # optional hook overrides
```

- **Materialization** (per-runtime, in the adapter): Tachyon writes a config home under
  `.tachyon/harness/<agent>/` — for claude a `CLAUDE_CONFIG_DIR` tree (settings.json + `.mcp.json` +
  plugin/skill dirs); for codex a `CODEX_HOME` tree (config.toml). `inherit` decides whether the base
  config is seeded first; the `harness:` block overlays on top.
- **Spawn wiring** (reuse existing plumbing): set `CLAUDE_CONFIG_DIR` on the agent's `env` (the same
  map already threaded at spawn), plus `--strict-mcp-config` for the no-leak guarantee. This
  materialize+augment step is a SINGLE shared pipeline across spawn/restart/resume/fork (H3) — not a
  spawn-only append. The effective config home is persisted and threaded through the resume resolvers
  (H2). Auth is seeded by symlinking `.credentials.json` (H1).
- **Capability gating**: a runtime supports an isolated harness iff its adapter implements a
  `materializeHarness(def) → { env, args }` capability — exactly mirroring how `forkCommand` gates
  fork to native-capable runtimes. v1 = claude only; a `harness:` on any other runtime is a
  validation ERROR, not a silent ignore (H9), so the feature never gives a false isolation signal (the
  `feedback_runtime_agnostic` discipline).
- **Lifecycle / GC**: the materialized config home lives under `.tachyon/harness/<agent>/` (gitignored,
  like `sessions.json`). GC is tied to ledger state — never deleted while a live session / resumable
  row / fork source references it (its `projects/` holds the transcript), plus a startup sweep of
  ownerless dirs (H8). Secrets come via `${VAR}` references written literally into the materialized
  `.mcp.json` and resolved from the process env at spawn — never the resolved secret on disk (H7).

## MVP (locked 2026-06-16)

Smallest end-to-end slice that proves the primitive:
1. `harness: { inherit, mcp }` for **claude only** — materialize a `CLAUDE_CONFIG_DIR` with the
   declared MCP servers + `--strict-mcp-config`, `inherit: none|workspace`.
2. Reuse `env:` for the config-home var; extend the adapter with `materializeHarness`.
3. Validation + an "isolated harness" tree affordance.
4. codex (`CODEX_HOME`), `skills`/`rules`/`hooks`, and `inherit: global` come in a follow pass.

## Decisions (maintainer-locked 2026-06-16)

- **0 — Name.** The capability is **"isolated harness"** (yaml key `harness:`). NOT "specialist agent":
  that collides with the orthogonal `role:` axis (spec 216 — *prompt* specialization: coder/reviewer/…),
  and "specialist" only describes one use (the same mechanism also enables a *minimal* clean-slate
  agent). The two axes compose (a `role: reviewer` agent may also have an isolated harness).
  "Specialist" stays as informal pitch copy only; never a schema noun or a tree label.
- **1 — v1 scope: claude-only, `mcp`-only.** Mirrors how 225 shipped claude-first. codex (`CODEX_HOME`)
  and `skills`/`rules`/`hooks` overlays are a deliberate follow pass once the primitive is proven.
- **2 — Inherit default: `workspace`.** Least surprising — an isolated harness = "the fleet's config +
  my extras". `none` (clean slate) and `global` are opt-in.
- **3 — Materialization: config-home redirection** (`CLAUDE_CONFIG_DIR`; `CODEX_HOME` in the follow
  pass). It's the only mechanism that isolates MCP+skills+rules+hooks **uniformly** across both
  runtimes; pure flag-overlay (`--mcp-config`/`--add-dir`) can't isolate hooks/auth and wouldn't extend
  to the full harness. The no-leak guarantee is the config home + `--strict-mcp-config` for claude.
  **Confirmed against the codex debate (2026-06-16):** flag-overlay was considered as a way to dodge
  the auth + resume blockers, but the blockers are cheap to fix (below), so config-home STANDS — it
  keeps the full feature one straight extension away. Two requirements fall out of the live BLOCKER
  verification (notes.md) and are now binding:
  - **3a — Auth seed.** A fresh `CLAUDE_CONFIG_DIR` is unauthenticated ("Not logged in", exit 1). Seed
    auth by **symlinking** `<harness-home>/.credentials.json` → the real `~/.claude/.credentials.json`
    (symlink, not copy — a copy goes stale on OAuth token rotation). Proven: with only that file
    present, `claude -p` returns `AUTHOK`. Seed NOTHING else for v1 (claude bootstraps the rest).
  - **3b — Resume-home threading.** A redirected home puts transcripts under
    `<CLAUDE_CONFIG_DIR>/projects/…`, invisible to the `~/.claude`-hardcoded resolvers. The effective
    config home must be persisted per session and threaded through `adapters.transcriptPath`, the
    `resolvers` cwd scans, and `AgentManager`'s resume/fork/readiness call sites — else resume (220),
    the resumable badge (221), and session fork (225) all break for a harness agent.
- **4 — Secrets: `${ENV}` indirection ONLY.** A declared secret is referenced as `${VAR}` and resolved
  at spawn from the agent's env; a literal key is **never** written into `.tachyon/harness/**`. That
  whole tree is **gitignored** (like `.tachyon/sessions.json`) and GC'd on Dismiss.
- **5 — Worktree: orthogonal.** A harness scopes *config*; a worktree scopes *files*. They compose
  freely — an isolated-harness agent may or may not have a worktree; neither implies the other.
- **6 — Template framing (loop-eng `p-bf1d7d`): DEFER the template abstraction.** v1 `harness:` is
  per-agent inline. Reuse already works today via a declared agent + `schedules.spawn` (a scheduled
  run can spawn a declared isolated-harness agent). A shared `harness-templates:` / `extends:` for
  fleets of identical specialists is a v2 nicety, gated on rule-of-three demand — not v1.

## Post-debate hardening (binding — codex 2026-06-16, all fold into implementation)

These are requirements, not options. Numbering follows the debate findings (notes.md).

- **H1 (was BLOCKER) — auth seed.** Symlink `.credentials.json` (Decision 3a). No harness agent may
  spawn into an unauthenticated home.
- **H2 (was BLOCKER) — resume-home threading.** Persist + thread the effective config home everywhere
  the resolvers assume `~/.claude` (Decision 3b). Test: a harness agent resumes/forks correctly.
- **H3 — one materialization+augmentation pipeline.** Materializing the home and augmenting the
  spawn command/env (`CLAUDE_CONFIG_DIR`, `--mcp-config`, `--strict-mcp-config`) must be a SINGLE shared
  step used by spawn, restart, resume, AND fork — else isolation silently drops on the non-spawn paths.
  (Today these rebuild the command independently: spawn/restart `effectiveCmd`, resume `resumeCommand`,
  fork `forkCommand`.)
- **H4 — reject conflicting user commands.** Fail validation if a harness agent's `cmd` already carries
  `--mcp-config` / `--strict-mcp-config` / `--settings`, or declares `env.CLAUDE_CONFIG_DIR` itself —
  Tachyon owns those for a harness agent; a user-supplied one makes the merge order security-significant.
- **H5 — two distinct, separately-tested guarantees.** (a) *No sibling leak*: an agent without a
  harness never sees a harness agent's MCP, and vice-versa. (b) *Inheritance is explicit*:
  `inherit: none` → the agent sees ONLY its declared MCP (no cwd `.mcp.json`, no global); `inherit:
  workspace` → its declared MCP **plus** an explicit copied snapshot of the workspace `.mcp.json`.
  Don't conflate "no sibling leak" with "no project pickup".
- **H6 — seeding = copy, never symlink (except auth).** For `inherit: workspace`, COPY/merge only the
  workspace `.mcp.json` at materialize time (symlinking causes write-back pollution; copying is the
  accepted staleness tradeoff). Rematerialize on every spawn/restart/resume so edits propagate.
  (`.credentials.json` is the one symlink — see H1.)
- **H7 — secrets as references, never resolved on disk.** A declared MCP `env` value must be exactly a
  `${VAR}` reference; write the literal `${VAR}` string into the materialized `.mcp.json` (NOT the
  resolved secret), require the real var to exist in the spawned process env, and fail before spawn if
  missing. _(Verified live 2026-06-16: claude expands `${VAR}` from the process env in both `args` and
  the server `env` block — notes.md § H7. So the materialized `.mcp.json` carries `${VAR}` literally.)_
- **H8 — GC tied to ledger state, never blind Dismiss.** Never delete `.tachyon/harness/<agent>` while a
  live tmux session, a resumable ledger row, or a fork source may reference it (its `projects/` holds
  the transcript). Add startup GC for ownerless harness dirs (no ledger/live owner). 
- **H9 — fail closed.** Error (don't silently ignore) on `harness:` declared for: a terminal entry, a
  non-`claude` runtime (v1), `inherit: global`, an empty/invalid `mcp` map, a literal (non-`${VAR}`)
  secret, or a not-yet-built key (`skills`/`rules`/`hooks`). Mirror every rule in `tachyon.schema.json`.

## Non-goals (v1)
- Auto-deciding which agent should get an isolated harness (AI-judgment-heavy — the attention-heuristic class).
- A GUI builder for harness config (declarative `tachyon.yml` first; a Studio form can follow).
- Sandboxing/syscall isolation — this is *config* isolation, not a security boundary.
- **Forking OR renaming a harness agent** — both fail closed in v1 (the home is name-keyed + holds the
  agent's transcripts; fork needs a cross-config-home seed, rename needs a persisted/moved home). Follow pass.
- **Secrets via anything but the ambient env** — a referenced `${VAR}` must be set in the environment
  that launched the editor before the agent starts; Tachyon resolves + injects it and fails closed if missing.
