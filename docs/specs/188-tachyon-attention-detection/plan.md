# 188 — tachyon-attention-detection — plan

_Drafted from `spec.md` on 2026-06-09. Update this file if implementation reveals the plan is wrong; do NOT silently diverge._

## Approach

_One or two paragraphs. The strategy in plain language — what we'll build, in what order, and why this shape (not just any shape)._

Three vscode-free modules + thin wiring, mirroring 186's testability discipline. (1) `src/attention/patterns.ts` — default prompt-pattern library (y/n, Enter-to-confirm, Esc-to-cancel, password, numbered selectors) + `classifyTail(text, extras)` pure matcher over the last ~8 non-empty lines. (2) `src/attention/AttentionMonitor.ts` — per-agent state machine (`working|idle|needs-input`) with injected IO (list/capture/cpuTicks/config/now): content change resets to working; pattern+stability => needs-input (episode-keyed, onChange fired once); stability>=silenceSec + flat CPU => idle (advancing CPU suppresses). (3) TmuxService gains `panePid()`; cpu ticks read from /proc/<pid>/stat (+ one level of children via /proc/<pid>/task/<pid>/children), null off-Linux. Wiring: extension.ts setInterval(3s) tick; sidebar AgentTreeItem renders the 3 states; AgentsProvider's TreeView created via createTreeView to carry the ViewBadge (needs-input count); toast once/episode with Open action; config gains `attention` (default: enabled iff no watch globs); Bridge list_agents merges the state via an injected getter; internal command `tachyon._attention` exposes states for the integration test.

## Files to touch

_Concrete list of files to be created, modified, or deleted. Group by category if it helps._

**Create:**
- `packages/tachyon/src/attention/patterns.ts` — pattern library + classifyTail
- `packages/tachyon/src/attention/AttentionMonitor.ts` — state machine + injected IO
- `packages/tachyon/test/unit/attention.test.ts` — classifier + state machine + config defaults

**Modify:**
- `src/tmux/TmuxService.ts` — panePid()
- `src/config/loadConfig.ts` + `src/config/tachyon.schema.json` — attention field
- `src/agents/AgentManager.ts` — none expected (monitor reads via manager.list)
- `src/presentation/Sidebar.ts` — 3-state icons, createTreeView badge
- `src/bridge/tools.ts` + `Bridge.ts` deps — attention in list_agents
- `src/extension.ts` — monitor lifecycle, toasts, internal command
- `test/unit/bridge.test.ts`, `test/integration/extension.test.js`, `examples/tachyon.yml`, `README.md`

**Delete:** none.

## Alternatives considered

_At least one rejected approach with its reasoning. If there genuinely was no alternative, state that explicitly ("no real alternative — only viable approach is X because Y")._

### tmux monitor-silence + hooks pushing to the Bridge

Rejected (umbrella discussion): event-driven on paper, but adds shell hooks, curl dependency and tmux-server config for the same outcome polling gives with all logic unit-testable in one place.

### Patterns-only (no stability/CPU weak signal)

Rejected by user decision — full design chosen; the idle signal is what surfaces out-of-library prompts and stuck agents.

## Risks and unknowns

_What could go wrong, what we're not sure about, what assumptions we're making. Spell them out — surprises during implementation are usually pre-implementation risks that weren't named._

- Notification spam — mitigated: toast only on pattern match (high precision), once per episode; weak signal never toasts.
- "Thinking" agents misread as idle when a wrapper shell (`sh -c`) sleeps while its child works — mitigated by summing one level of /proc children; deeper trees may still misread (documented).
- TUI redraws (spinners) keep panes changing => TUIs rarely show idle; expected, not a bug.
- macOS: no /proc — cpuTicks null, stability alone drives idle (documented; classifier unaffected).

## Research / citations

_Sources consulted (docs, blog posts, code references) that informed this plan. Satisfies `.agent0/context/rules/research-before-proposing.md`._

- Umbrella discussion 2026-06-09 (F1 decision); spec 186 spike notes (real Claude Code prompt capture); VSCode ViewBadge API; /proc(5) stat fields 14-15.
