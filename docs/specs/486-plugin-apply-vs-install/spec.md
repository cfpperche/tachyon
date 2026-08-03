# 486 — plugin-apply-vs-install

_Created 2026-08-03._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Installing a plugin today does three things at once, and only the first was asked for. The engine
fetches the payload into `.tachyon/plugins/<plugin>/`, **and** materializes every skill into every
served runtime's project directory (`.claude/skills/<x>`, `.agents/skills/<x>`, `.grok/skills/<x>` —
`plugins/engine.ts:108`), **and** thereby hands those skills to every agent whose cwd is the
workspace. One consent, three consequences, two of them invisible.

The workspace became an implicit inheritance channel, and it broke in the open on 2026-08-03: the
maintainer could not create a Grok agent at all. A canonical profile refuses ambient runtime input
because Grok has no `--setting-sources user` to close a project scope with, so the only guarantee
available is absence — and the plugin engine had filled exactly the directory the inspector required
to be empty. Both halves were correct on their own terms. `t-09be02` unblocked it by teaching the
inspector to subtract what the lockfile claims, which is right and is not enough: it makes the
workspace projection *tolerated*, while leaving it *automatic*. `t-84c678` then named the residue —
every canonical Grok agent sees every installed skill, because project discovery has no per-agent
granularity.

This spec fixes the level above both. **Installing stops applying.** The same distinction the
capability model already draws — *"Authorizing is not selecting… 'may have' and 'has' are different
facts, decided at different moments by the same person"* (`agentSkillAuthorization.ts`) — is drawn
one level up, so a plugin's payload arriving is separate from its skills reaching a workspace, which
is separate again from a particular agent holding them.

Three levels, each with an owner and a moment:

| Level | What exists | Who decides | Reversible by |
|---|---|---|---|
| **Installed** | payload under `.tachyon/plugins/<plugin>/`, nothing materialized | whoever installs | uninstall |
| **Applied to the workspace** | Tachyon materializes that skill into each served runtime's project dir | the human, per skill | un-applying, without uninstalling |
| **Delivered to an agent** | the skill is copied into that agent's private home | the human, when creating or editing a Saved Agent | de-selecting it |

The maintainer's rule for delegation is unchanged and rides on top: a **Temporary agent always gets
its own worktree**, and therefore its own cwd, and inherits the skills its **parent** can see,
filtered to those its own runtime supports. That is the existing delegated toolkit (`t-b505b3`); this
spec changes where it reads FROM, not what it does.

**Done** means: installing a plugin materializes nothing; a human applies and un-applies skills per
workspace without touching the install; a Saved Agent's skills are chosen for it; a Temporary agent
gets a worktree and inherits its parent's compatible skills; and a canonical Grok agent is creatable
without the inspector having to forgive anything.

### Why this is not re-opening inheritance

It is the ruling this repo already made, applied one level up. `worktreeProjection.ts` retired
`.claude/skills` / `.agents/skills` for agent worktrees under a standing ruling recorded in
`plugins/agentHookProjection.ts:25`:

> an agent given its own worktree that did not explicitly ask to inherit the workspace's
> configuration must not have it

Today that protects an agent from the workspace. This spec protects the **workspace** from an
install. Same sentence, one level out: *nothing inherits what nobody asked for.*

### Scope cut, 2026-08-03 — the third level moves out

The maintainer asked whether the agent-type duality should exist at all: one `Agent` with a lifetime,
rather than Saved and Temporary as species. Measured while answering: the 58 places that branch on
`lifetime` almost all read it as a FIELD already (`canDismiss = temporary && !running` is a lifetime
consequence, not a species one), and SDD 482 had already declared these "identity/lifetime semantics,
not technical species". The duality that remains is in the **capability layer** — a Saved agent gets
skills through profile grants, a Temporary through the delegated toolkit: one question answered by
two mechanisms.

That unification is SDD 487, and it rewrites exactly what this spec's third level would build. So the
third level moves out, and the maintainer's objection is the reason: *"vamos fazer 486 pra depois
remover codigo? se for nao faz sentido"*.

What stays here is what survives 487 untouched, because it is about the **workspace**, not about
agents: installing stops materializing, and a human applies or un-applies per skill. The delegated
toolkit's source change stays too — not by choice but by force: once install materializes nothing,
the toolkit breaks unless it reads the payload instead.

What leaves: Grok joining the skill-grant enum (`t-84c678`) and a Saved Agent's skill selection.
Both belong to the unified capability model, and building them against today's split would be work
done twice.

## Acceptance criteria

- [ ] **Scenario: installing materializes nothing**
  - **Given** a workspace with no plugins applied
  - **When** a human installs a plugin that ships skills
  - **Then** the payload exists under `.tachyon/plugins/<plugin>/` and **no** runtime project
    directory gained a skill — not `.claude/skills`, not `.agents/skills`, not `.grok/skills`
- [ ] **Scenario: applying is a separate, per-skill act**
  - **Given** an installed plugin shipping several skills
  - **When** the human applies ONE of them to the workspace
  - **Then** exactly that skill is materialized, into every runtime the plugin declares support for,
    and the others remain installed-but-unapplied
- [ ] **Scenario: un-applying does not uninstall**
  - **Given** a skill applied to the workspace
  - **When** the human un-applies it
  - **Then** the materialization is removed from every runtime dir, the payload stays installed, and
    re-applying needs no refetch
- [ ] **Scenario: a Temporary agent inherits its parent's, filtered by runtime**
  - **Given** a parent agent that can see a set of skills
  - **When** it spawns a Temporary child
  - **Then** the child gets its own worktree and cwd, and receives the parent's skills minus any its
    own runtime does not support — the shortfall named, never silent
- [ ] **Scenario: a canonical Grok agent is creatable with plugins installed**
  - **Given** plugins installed and nothing applied
  - **When** a human creates a canonical Grok agent
  - **Then** it is created, and the ambient inspector has nothing to forgive because nothing was
    materialized
- [ ] Applying and un-applying are recorded durably, so a reload does not resurrect an un-applied
      skill and a fresh clone does not silently apply one
- [ ] The delegated toolkit reads from the installed payload, not from a workspace materialization —
      so delegation works with zero skills applied

## Non-goals

- **No migration code.** Maintainer decision, 2026-08-03: after the release and before reload, the
  environment is cleaned by hand — plugins kept, materializations removed. Writing a migrator for a
  one-machine transition costs more than the transition.
- **Not a change to what a skill IS**, nor to the plugin fetch/integrity model. `plugins.lock.json`
  and its payload hashes stay the record of what was installed; this spec adds what is applied.
- **Not the per-agent grant model, and not a Saved Agent's skill selection.** Both moved to SDD 487
  by the scope cut above. `agentSkillAuthorization.ts` defines authorize → select → deliver for
  `claude` / `codex` / `pi`; whether **Grok** joins that enum (`t-84c678`) is answered there, against
  the unified model, rather than here against the split one.
- **Not the inspector's content check.** `t-09be02` stays: a materialization the lockfile claims is
  still not ambient. This spec makes that path rarer, not wrong.
- **Terminals are out of scope** — a terminal is not an agent and holds no skills.

## Open questions

- **Where does "applied" live?** `plugins.lock.json` records what was installed and the paths it
  wrote. Applied-state is a different fact with a different lifetime (a human toggles it; an install
  does not). Same file with a new field, or its own record? The test is which one makes an
  un-applied skill impossible to resurrect by reload.
- **What does a fresh clone do?** A teammate clones a repo whose `tachyon.yml` lists plugins. Does
  applied-state travel in the repo (so the team shares one answer) or stay local (so each machine
  decides)? These give opposite defaults and both are defensible; the maintainer decides.
- **Does the Temporary child's runtime filter already exist?** `AgentManager.ts:1256` captures parent
  skills per delegation and already withholds BY NAME on failure. Whether it filters on runtime
  support — and whether the shortfall is reported — must be measured before it is assumed.
