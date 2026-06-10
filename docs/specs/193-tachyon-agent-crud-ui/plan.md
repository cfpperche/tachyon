# 193 — tachyon-agent-crud-ui — plan

_Drafted from `spec.md` on 2026-06-10. Update this file if implementation reveals the plan is wrong; do NOT silently diverge._

## Approach

_One or two paragraphs. The strategy in plain language — what we'll build, in what order, and why this shape (not just any shape)._

`src/config/YamlConfigEditor.ts` — pure text→text transforms over yaml's Document API (addAgent/cloneAgent/deleteAgent/renameAgent/agentEntryLine), each validating names, preserving comments, cleaning layout references and returning warnings. Extension: a `mutateConfig` helper (read file → transform → write → reload config → rebuild watches → refresh views → surface warnings) + five commands (newAgent with optional args for automation; clone/rename/delete/edit as context-menu items under group 2_manage, gated by `viewItem =~ /^agent-/`). package.json contributes the commands/menus. Validation: unit (mutations, comments, errors) + live host integration (full CRUD via real commands, fixture restored).

## Files to touch

_Concrete list of files to be created, modified, or deleted. Group by category if it helps._

**Create:** `src/config/YamlConfigEditor.ts`, `test/unit/yamlEditor.test.ts`.

**Modify:** `src/extension.ts` (mutateConfig + 5 commands), `package.json` (commands/menus), `test/integration/extension.test.js`, `README.md`.

**Delete:** none.

## Alternatives considered

_At least one rejected approach with its reasoning. If there genuinely was no alternative, state that explicitly ("no real alternative — only viable approach is X because Y")._

### Webview form for agent editing

Rejected: a parallel form drifts from the schema as fields evolve; "open the yml at the entry" reuses the schema-validated editor for the long tail at a tenth of the cost.

### Plain YAML stringify (parse → mutate JS → dump)

Rejected hard: destroys user comments and formatting — the dealbreaker for a config-as-code product. yaml's Document API is the reason this feature is safe to build.

### Replicas syntax (agents.x.replicas: N)

Set aside in discussion: changes the identity model (template vs instance) right before F9's foundation refactor; the clone flow covers the need without touching the model.

## Risks and unknowns

_What could go wrong, what we're not sure about, what assumptions we're making. Spell them out — surprises during implementation are usually pre-implementation risks that weren't named._

- Rename of a running agent would orphan its session under the old name — guarded: refused while running.
- Mutations on an unparseable yml could destroy user content — guarded: editor throws before writing; file untouched.
- Cloned entries lose comments INSIDE the cloned block (values copied faithfully) — acceptable, documented in code.

## Research / citations

_Sources consulted (docs, blog posts, code references) that informed this plan. Satisfies `.agent0/context/rules/research-before-proposing.md`._

- yaml (eemeli) Document API docs — comment-preserving mutations; session discussion 2026-06-10.
