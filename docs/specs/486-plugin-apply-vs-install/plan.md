# 486 — plugin-apply-vs-install — plan

_Drafted from `spec.md` on 2026-08-03. The approach, not the steps (those go in `tasks.md`)._

## Approach

The engine already knows how to materialize a skill into a runtime's project directory and how to
remove it — `install` and `uninstall` both walk `plugins.lock.json`'s `targets`. What is missing is a
**second fact** between them: whether a given skill is currently *applied*. So this is less new
machinery than an existing action being split away from install and given a switch.

Two phases, after the 2026-08-03 scope cut. The first is the whole point; the second is forced by it.

### Phase A — applied-state exists, and install stops materializing

Introduce the applied record and make `install` write the payload only. Materialization moves behind
`apply`, keyed by (plugin, skill), fanning out to every runtime the plugin declares. `un-apply`
removes exactly what `apply` wrote and nothing else — the lockfile's `targets` already name those
paths per runtime, so removal is a lookup rather than a guess.

Two properties decide whether this phase is right, and both are testable: an un-applied skill must
not resurrect on reload (the record is durable, not derived), and un-applying must not disturb the
payload (re-applying needs no refetch).

### Phase B — zero-applied delegation, corrected after `t-53e485`

Re-measurement on 2026-08-13 invalidated this plan's original source change. SDD 487 and `t-53e485`
made the parent's resolved, digest-pinned capability projection the sole delegation source. Neither
`target.file` nor `.tachyon/plugins/<plugin>/` participates. That is an authority boundary: installed
workspace plugins are not grants the parent can give away.

Phase B therefore adds proof, not a production source change. Its test creates an installed plugin
with no applied-state ledger and no runtime materialization, then proves a Temporary child receives
the parent's approved snapshot in its own worktree. A supported child runtime consumes the projection;
an unmeasured runtime refuses rather than silently dropping a requested grant.

### Phases C and D moved to SDD 487

Cut on 2026-08-03. The Saved-Agent skill selection and Grok joining the grant enum (`t-84c678`) live
in the capability layer that SDD 487 unifies, so building them here would be work done twice — the
maintainer's objection, and it is correct.

The inspector verification that was Phase D goes with them: proving "a canonical Grok agent is
creatable because nothing was materialized" is worth doing once, after the model it depends on has
settled.

What remains here is Phases A and B. B is not optional as proof, but its original payload-source
implementation is retired: reinstating it would reopen the authority leak closed by `t-53e485`.

## Key decisions

- **Applied-state is its own record, not a field on the install** — chosen because the two facts have
  different lifetimes and different authors: an install is a fetch with integrity, an apply is a
  human toggle that must survive reload and be revocable without refetch. Rejected *a field inside
  `plugins.lock.json`'s plugin entry* because that file records what was FETCHED (its
  `integrity.payload` hashes upstream bytes, and spec 270 deliberately lets that drift once a human
  edits) — overloading it makes one file answer two questions with two lifetimes.
- **`apply` fans out to every runtime the plugin declares, not per runtime** — chosen because the
  human's question is "do I want this skill in this workspace", not "for Codex but not Claude";
  per-runtime toggles multiply the surface with no use case anyone has asked for. Rejected
  *per (skill, runtime)* on that basis; revisit if a real case appears.
- **No migration code** — maintainer decision, 2026-08-03: after the release and before reload the
  environment is cleaned by hand, keeping plugins and removing materializations. Rejected *default to
  applied* (invisible, and carries today's accident forward as tomorrow's intent) and *a migrator*
  (more code than the one-machine transition it serves).
- **A Temporary agent always gets its own worktree** — maintainer decision, 2026-08-03. It follows the
  ruling already recorded in `plugins/agentHookProjection.ts:25`, and it is what makes "not selected
  for this agent" mean "this agent does not see it": a shared cwd keeps workspace discovery alive no
  matter what the selection says.
- **The inspector's content check survives** — chosen because applying is a declaration and a declared
  thing is not ambient; rejected *reverting `t-09be02`* because a workspace with applied skills is a
  legitimate state that must not block a canonical agent.

## Files touched

| File | Change |
|---|---|
| `src/plugins/engine.ts` | `install` writes payload only; materialization moves behind `apply`/`unapply` |
| `src/plugins/paths.ts` | applied-record location, beside `PLUGIN_PAYLOAD_ROOT` (added by `t-09be02`) |
| *(new)* applied-state store | durable per-workspace record of (plugin, skill) → applied |
| `src/agents/AgentManager.ts` | no Phase B change: `t-53e485` already made the parent's pinned grant the sole source |
| `src/webview/plugins/App.tsx` | per-skill apply/un-apply control |
| `src/config/agentProfileProjection.ts` | comment only — why the subtraction now matters less |

## Risks & unknowns

- **The Plugins screen is being migrated right now** (SDD 485 D2, `t-1cc57e`). Phase A's UI lands
  after that merges, or it lands in the wrong file. Sequencing, not a conflict.
- **Applied-state and a fresh clone.** Open question in `spec.md`, and it decides a default: if the
  record travels in the repo, a teammate's clone applies skills they never chose; if it stays local,
  a team re-answers the same question on every machine. Maintainer's call, needed before Phase A
  chooses the record's location.
- ~~**Unmeasured: what a runtime does with a skill dir that disappears mid-session.**~~ **MEASURED
  2026-08-06 (`t-5d219f`) — see `notes.md` § Measurements.** No runtime crashes or wedges on a skill,
  so A5 may offer the switch during a live session. The HOOK half came back the other way and is the
  real constraint: codex 0.146.1 and grok 0.2.118 fix their hook set at session start, so a removed
  hook keeps firing until the session restarts, and an un-apply switch reading "disarmed" would be
  wrong on both. Claude 2.1.223 re-reads live. Both runtimes also hold a hook behind their OWN trust
  gate, which Tachyon's switch cannot open.
- **`t-84c678` shrinks but does not vanish.** Measured while drafting: the delegated toolkit already
  filters by runtime and already admits Grok, so a Temporary Grok child already receives skills
  privately. The gap is Saved agents. The task's framing is right; its implied scope was wider than
  the code.

## Visual impact

Phase A adds a per-skill apply/un-apply control to the Plugins screen — the only visible surface
this spec still owns after the cut. It carries screenshots before release under the convention
agreed 2026-08-02 — measured with the browser viewport AND `?width=`
together, since `plugins.css` has a `@media (max-width: 720px)` that a frame-only resize never fires
(`t-b24282`).

The state to get right visually is the one the model introduces: *installed but not applied* has no
representation today, and a card that shows it as absent would hide a plugin the human installed.

## Sources consulted

- `src/plugins/engine.ts` (`ADAPTERS`, the install/uninstall target walk), `src/plugins/paths.ts`,
  `src/plugins/projectedInputs.ts` (`t-09be02`).
- `src/agents/AgentManager.ts:1215-1275` — the delegated toolkit: runtime filter, per-name
  withholding, digest-conflict refusal.
- `src/config/agentSkillAuthorization.ts` — authorize/select/deliver, `SkillGrantAdapter`, and the
  `runtime-home` scope note that names `~/.grok/skills/…`.
- `src/plugins/agentHookProjection.ts:14-32` — the standing worktree ruling, and why each runtime
  misses project scope for a different reason.
- `docs/runtimes/parity.md` — Grok's measured `~`/`✗` rows and their causes (no projectable workspace
  source on 0.2.112; no `--setting-sources user` equivalent).
- Tasks: `t-09be02`, `t-84c678`, `t-b505b3`, `t-b0cfd4`, `t-836be3`.
