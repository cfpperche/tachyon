# 216 — tachyon-role-anchoring

_Created 2026-06-14._

**Status:** ready to ship — implemented, codex dueto SHIP (3 rounds, 2026-06-15), 466 tests + typecheck green. Pending: commit + `vsce publish minor`.

**UI impact:** flow
<!-- Studio gains a role picker; a re-anchored agent shows a transient badge/log line.
Verified by spawning a role-templated agent, forcing a compaction, observing the re-inject. -->

## Intent

**Keep a spawned agent anchored to the job it was given — and make Tachyon's coordination the
path of least resistance.** Two real frictions, both surfaced by the Hive RE (2026-06-14, see
memory `project_hive_re`) and both shaped to Tachyon rather than copied:

1. **Role drift after compaction.** An agent's `instructions` (its role/task contract) are
   delivered once as a launch arg (`composeCommand` → `claude "<instructions>"`). After the CLI
   internally compacts (`/compact`, Codex auto-summarize), that opening turn is summarized away
   and the agent forgets what it was for — it regresses to its generic CLI persona.
2. **Invisible coordination.** A spawned agent that uses its own CLI's native sub-agent tools
   (Claude `Task`/`Explore`, etc.) does work Tachyon can't see — no tab, no lineage, no attention.

**Key reframe (why this is NOT a copy of Hive's mechanism).** Hive re-anchors *the whole `team`
protocol* on every message because its coordination is shell-CLI knowledge that compacts away.
Tachyon's coordination is **MCP** — the Bridge tool-defs are re-sent by the MCP client every
turn, so the **protocol never needs re-anchoring**. The only thing that compacts away is the
**role/instructions**. So Tachyon's re-anchoring targets the *role*, not the protocol — a much
smaller, safer payload.

## Confirmed design (proposed — locking at this checkpoint)

### Part A — Role/instruction templates (safe; the bulk)
- A per-agent optional **`role:`** field (`tachyon.yml` + Studio picker) selecting a built-in
  **instruction template**: `coder` / `reviewer` / `tester` / `orchestrator` / `custom`, each a
  short **behavior-contract** (scope, boundaries, how-to-verify, what-to-report). These are
  **reusable task contracts, framed as context-engineering — NOT persona/identity prompting**
  (per memory `feedback_no_persona_role_prompting`: no SOUL.md, no "you are a 10x engineer").
  Templates are English (repo-artifact rule).
- **Composition:** the role template is the base; an explicit `instructions:` is **appended after
  it** (the human's words win / extend, never silently replaced). `role` alone → template only;
  `instructions` alone → today's behavior unchanged; both → template + instructions.
- Studio "Agent" tab gains a role dropdown; choosing one previews the template; the instructions
  box still edits the free-text addendum. Backward compatible: no `role` = identical to today.

### Part B — Bridge-coordination guidance (safe; prose)
- Agents **spawned via the Bridge** (`spawn_agent`, i.e. children) get a short guidance tail
  appended to their delivered instructions: *prefer the Bridge tools for coordination; native
  sub-agent delegation (Task/Explore/…) runs work Tachyon can't see — spawn through the Bridge if
  you want it in the team.* **Guidance only — no enforcement** (we cannot intercept a CLI's
  built-in tools; Hive only prompts too). Opt-out via `settings.bridgeGuidance: false`.

### Part C — Role re-anchoring after compaction (the novel/risky part; OPT-IN, default OFF)
- A **compaction detector** rides the existing `AttentionMonitor` capture stream (it already
  reads every agent's pane each tick). Per-runtime markers via the adapter abstraction (claude +
  codex for v1; other runtimes = no detector, documented gap — per
  `feedback_runtime_agnostic_not_claude_only`). On a marker, the agent is flagged
  `compactedSinceAnchor`.
- **Safe-window injection:** when a flagged agent next transitions to **`idle`** (never
  `working` — would interleave with output; never `needs-input` — would answer the wrong prompt),
  Tachyon re-injects a compact **role reminder** (the agent's role template summary, not the full
  instructions) via `tmux.sendKeys(..., submit=true)`, **at most once per compaction episode**.
- **Manual + durable fallbacks always on** (even when auto is off): a canonical
  **`.tachyon/ROLE.md`** per agent (or a workspace `PROTOCOL.md`) the agent can be told to
  `cat`, plus a **`reanchor_agent` Bridge tool / palette command** to re-inject on demand.
- **Default OFF** (`settings.anchor.auto: false`) until dogfood proves the injection timing is
  safe — sending keys into a live pane races the human and spends a turn; ship conservative.

## Decisions (locked 2026-06-14 with the maintainer)
- **D-A** — Re-anchoring auto-inject is **default OFF / opt-in** (`settings.anchor.auto: false`).
- **D-B** — v1 ships **auto (gated by the off-by-default flag) + an always-on manual command/tool**
  + the `.tachyon/ROLE.md` durable fallback.
- **D-C** — Compaction detection v1 covers **claude + codex** only; other runtimes have no detector
  (documented gap, per `feedback_runtime_agnostic_not_claude_only`).
- **D-D** — `role` **composes at delivery** (template → then `instructions`); it never rewrites the
  yml.

## Non-goals
- A full **orchestrator/worker hierarchy** (Hive's model). Tachyon stays "any agent can spawn any
  agent"; `role` is a template, not an enforced rank.
- **Enforcing** Bridge use / intercepting native sub-agent tools (impossible without hooks).
- **Persona/identity prompting** (explicitly out — context-engineering only).
- Re-anchoring the **Bridge protocol** (unnecessary — MCP defs persist per turn).

## Behavior (proposed)
- `agents: { rev: { cmd: claude, role: reviewer } }` → `rev` launches with the reviewer contract
  as its opening instructions; no hand-written prompt needed.
- A Bridge-spawned child gets the coordination guidance appended automatically.
- With `settings.anchor.auto: true`: a long-running `rev` hits `/compact`, Tachyon detects it,
  waits for `rev` to go idle, types a one-line role reminder + Enter; the tree shows a transient
  "re-anchored" note. With auto off: nothing types; the human (or the agent) can `cat .tachyon/
  ROLE.md` or run "Re-anchor agent".

## Acceptance
- `role:` parses + validates (known templates or `custom`); composes with `instructions` at
  delivery (template → instructions order); unknown role = clear parse error; no `role` =
  byte-identical launch to today. Unit-tested.
- Built-in templates render as behavior contracts (no persona language); Studio role picker
  writes/round-trips `role:` via YamlConfigEditor. Unit-tested.
- Bridge-spawned children receive the guidance tail; `settings.bridgeGuidance: false` suppresses
  it. Unit-tested on the compose path.
- Compaction detector: per-runtime markers classify a synthetic compacted pane (claude + codex
  fixtures) → flag set; non-matching panes → no flag. Pure + unit-tested.
- Re-anchor injection fires **only** on idle-after-compaction, **once** per episode, **never** in
  working/needs-input; off by default; manual `reanchor_agent` + `.tachyon/ROLE.md` always work.
  State-machine unit-tested; one real-tmux smoke for the inject path.
- README documents roles, the guidance, and the opt-in anchor (incl. the runtime gap).
