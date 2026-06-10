# 194 — tachyon-sidebar-taxonomy — plan

_Drafted from `spec.md` on 2026-06-10. Update this file if implementation reveals the plan is wrong; do NOT silently diverge._

## Approach

_One or two paragraphs. The strategy in plain language — what we'll build, in what order, and why this shape (not just any shape)._

loadConfig gains EntryKind + KNOWN_AI_CLIS + inferKind(cmd) (launcher-aware basename match) and parses/validates `kind:`, flipping the attention default to kind-based. AgentInfo carries kind (ad-hoc spawns infer; undeclared survivors default agent). AgentsProvider renders Bridge + two collapsible group nodes filtering by kind; AgentTreeItem uses hubot/terminal as base icons with state colors layered on. newAgent (F13) confirms kind via quick-pick, persisting `kind:` only on divergence from inference (addAgent gains the param). Schema/docs updated; fixture prompter pinned `kind: agent` (sh would infer terminal and disable the attention live test).

## Files to touch

_Concrete list of files to be created, modified, or deleted. Group by category if it helps._

**Create:** none (extends existing modules).

**Modify:** `src/config/loadConfig.ts` (+inferKind/kind/attention default), `tachyon.schema.json`, `src/agents/AgentManager.ts` (AgentInfo.kind), `src/presentation/Sidebar.ts` (groups + kind icons), `src/config/YamlConfigEditor.ts` (addAgent kind), `src/extension.ts` (newAgent kind pick), tests (attention defaults migrated, inference table, integration kind assert), fixture, `README.md`, `examples/`.

**Delete:** none.

## Alternatives considered

_At least one rejected approach with its reasoning. If there genuinely was no alternative, state that explicitly ("no real alternative — only viable approach is X because Y")._

### Two top-level maps (agents: / terminals:)

Rejected: breaks every existing config, splits the namespace layouts/Bridge tools rely on, and forces every consumer to learn two collections for one concept. A kind attribute on a single map is non-breaking.

### Inference-only (no explicit kind)

Rejected: any list of known AI CLIs will miss custom wrappers (./meu-bot.sh) — the override is the escape hatch that keeps the list small.

## Risks and unknowns

_What could go wrong, what we're not sure about, what assumptions we're making. Spell them out — surprises during implementation are usually pre-implementation risks that weren't named._

- Behavior change: attention default for AI CLIs WITH watch globs flips from off to on (rare combo; documented). npm-dev-server outcome unchanged (watch correlates with terminal inference).
- KNOWN_AI_CLIS will age — additions are one-line, and `kind:` covers the gap meanwhile.
- Group nodes change TreeItem hierarchy — context menus keyed on viewItem =~ /^agent-/ unaffected (groups use group-* contextValues).

## Research / citations

_Sources consulted (docs, blog posts, code references) that informed this plan. Satisfies `.agent0/context/rules/research-before-proposing.md`._

- HiveTerm sidebar screenshot (user, 2026-06-10); VSCode codicons (hubot/terminal); session decision log.
