# 197 — tachyon-agent-lineage — plan

_Drafted from `spec.md` on 2026-06-10. Update this file if implementation reveals the plan is wrong; do NOT silently diverge._

## Approach

_One or two paragraphs. The strategy in plain language — what we'll build, in what order, and why this shape (not just any shape)._

AgentManager: spawn(name, adhocDef) → spawn(name, SpawnOptions {cmd?, cwd?, instructions?, parent?}); lineage Map child→parent (session-local, cleared on child kill); AgentInfo.parent. tools.ts: spawn_agent schema gains instructions+parent (description instructs agents to always pass parent). Sidebar: AgentsProvider renders three levels — group → roots (no parent or parent gone) → children (childrenOf(parent), any kind; "spawned by X" description). extension: internal `tachyon._spawn` as the integration seam. 1 new l10n key.

## Files to touch

_Concrete list of files to be created, modified, or deleted. Group by category if it helps._

**Create:** none.

**Modify:** `src/agents/AgentManager.ts`, `src/bridge/tools.ts`, `src/presentation/Sidebar.ts`, `src/extension.ts` (_spawn), l10n bundle, unit/integration suites, `README.md`.

**Delete:** none.

## Alternatives considered

_At least one rejected approach with its reasoning. If there genuinely was no alternative, state that explicitly ("no real alternative — only viable approach is X because Y")._

### Authenticated per-call identity (per-agent tokens) for parent

Rejected for now: real engineering (token per spawn, env plumbing) for marginal gain — lineage is a UX/coordination aid, not a security boundary. Self-declared matches the pins precedent.

### Cascade kill on parent death

Rejected: tmux sessions are independent; silently killing working children because their orchestrator died is the wrong default. Promotion keeps the tree honest.

## Risks and unknowns

_What could go wrong, what we're not sure about, what assumptions we're making. Spell them out — surprises during implementation are usually pre-implementation risks that weren't named._

- Self-declared parent can lie or dangle — render resolves: unknown parent ⇒ child at root.
- Genealogy lost on extension restart while sessions survive — children re-discovered flat (consistent with ad-hoc def behavior; documented).

## Research / citations

_Sources consulted (docs, blog posts, code references) that informed this plan. Satisfies `.agent0/context/rules/research-before-proposing.md`._

- HiveTerm demo video (user, 2026-06-10); pins authorship precedent (spec 192).
