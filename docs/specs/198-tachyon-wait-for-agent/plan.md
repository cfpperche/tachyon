# 198 — tachyon-wait-for-agent — plan

_Drafted from `spec.md` on 2026-06-10. Update this file if implementation reveals the plan is wrong; do NOT silently diverge._

## Approach

_One or two paragraphs. The strategy in plain language — what we'll build, in what order, and why this shape (not just any shape)._

src/bridge/Waiters.ts (vscode-free registry: wait/notifyAttention/notifyDead/notifyGone/dispose) + executeWait helper in tools.ts (immediate-resolution branches, live-state-on-timeout) shared by the 13th tool and the extension's _wait internal command. Wiring: AttentionMonitor.onChange → notifyAttention; LifecycleMonitor onCrash/onCleanExit → notifyDead, new onGone → notifyGone. bridge-host E2E harness gains real monitors (1s tick) so waits work standalone. Cleanup fix: kill/killAll clear adhoc defs. Version 0.3.0.

## Files to touch

_Concrete list of files to be created, modified, or deleted. Group by category if it helps._

**Create:** `src/bridge/Waiters.ts`, `test/unit/waiters.test.ts`.

**Modify:** `src/bridge/tools.ts` (+wait_for_agent, executeWait, deps.waiters), `src/agents/LifecycleMonitor.ts` (+onGone), `src/agents/AgentManager.ts` (adhoc cleanup on kill), `src/extension.ts` (wiring + _wait), `test/e2e/bridge-host.ts` (monitors), unit/integration suites, `package.json` (0.3.0), `README.md`.

**Delete:** none.

## Alternatives considered

_At least one rejected approach with its reasoning. If there genuinely was no alternative, state that explicitly ("no real alternative — only viable approach is X because Y")._

### Control mode (F20) first, F19 on top

Rejected for ordering (user agreed after the seam discussion): waiters hang off monitor TRANSITIONS, which survive a detection-engine swap unchanged — layer 2 needs no rework when layer 1 lands. Doing the M/L refactor first would only delay the S-effort delegation primitive.

### Internal polling loop inside the tool handler

Rejected: the monitors already tick; a second poll loop per pending call wastes work. Event-driven waiters reuse the existing transitions and get faster for free under F20.

## Risks and unknowns

_What could go wrong, what we're not sure about, what assumptions we're making. Spell them out — surprises during implementation are usually pre-implementation risks that weren't named._

- MCP clients may cap tool-call duration below timeoutSec — mitigated: default 45s, "call again" semantics documented in the tool description.
- Long-held HTTP requests on the loopback Bridge — bounded (max 240s), flushed on extension disposal.
- Attention granularity is the 3s tick — F20 (control mode) tightens it without touching waiters.

## Research / citations

_Sources consulted (docs, blog posts, code references) that informed this plan. Satisfies `.agent0/context/rules/research-before-proposing.md`._

- sentinel /ws/events architecture (event push); MCP streamable-HTTP semantics; session seam discussion 2026-06-10.
