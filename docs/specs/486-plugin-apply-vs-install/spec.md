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
| **Applied to the workspace** | Tachyon materializes that contribution into each served runtime's project dir | the human, per contribution | un-applying, without uninstalling |
| **Delivered to an agent** | the skill is copied into that agent's private home | the human, when creating or editing a Saved Agent | de-selecting it |

### A plugin is not only skills, and the middle row is not only `skill-dir`

Raised by the maintainer, 2026-08-03, before ratification: *"plugins nao sao apenas de skills, podem ter
hooks, binarios e outras coisas … hooks vao poder ser habilitados e desabilitados tambem?"* The draft this
replaces said "skill" throughout and mentioned hooks exactly once — as a file path, not as a decision. The
answer is yes, and the reason it is yes matters more than the answer.

Two lists, and only one of them is this spec's subject. A plugin's manifest can declare seven kinds of
thing (`manifest.ts:213`): `blocks` (a runtime's native hooks), `gitHooks`, `tools` (author-pinned
binaries), `data`, `externalTools`, `config`, `views`. But what Tachyon **materializes into a place
something else reads** is a shorter, already-enumerated list — the lockfile's `TargetKind`
(`lockfile.ts:22`), which exists precisely because it is what a removal must be able to undo exactly:

| kind | what lands, and where | in this spec |
|---|---|---|
| `skill-dir` | a skill directory into `.claude/skills/`, `.agents/skills/`, `.grok/skills/` | **Phase A** |
| `settings-hook` | a hook entry MERGED into the runtime's settings file | **Phase A** |
| `mcp-server` | a server entry MERGED into the runtime's MCP config | **Phase C** |
| `view` | a UI surface inside Tachyon itself | **out** — see Non-goals |

**The case for gating hooks is stronger than the case for gating skills, not weaker.** A skill is text a
model MAY read. A hook is code that RUNS, on every event that matches, without anyone asking at the moment
it fires. If the principle is that installing must not silently put text in front of a model, then
installing must not silently ARM CODE is the same principle at higher stakes. Shipping this for skills
alone would leave a human in control of the quiet half and not the loud one.

What a plugin ships that is **not** projected is out by nature rather than by omission, and each for a
reason worth stating once so nobody re-opens it: `tools` and `data` are fetched content-addressed into
Tachyon's own directory and reached only through an explicit shim (`_tachyon-tool`, `_tachyon-data`) —
installing puts no binary anywhere a runtime discovers by itself, so there is nothing to "apply".
`externalTools` are declared and detected, never provisioned. `config` lives in the plugin's own payload
directory. None of the four enters a runtime's ambient scope, which is the only thing this spec regulates.

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
  - **When** a human installs a plugin that ships skills AND hooks
  - **Then** the payload exists under `.tachyon/plugins/<plugin>/`, **no** runtime project directory
    gained a skill — not `.claude/skills`, not `.agents/skills`, not `.grok/skills` — and **no**
    runtime settings file gained a hook entry
- [ ] **Scenario: applying is a separate, per-contribution act**
  - **Given** an installed plugin shipping several skills and at least one hook
  - **When** the human applies ONE of them to the workspace
  - **Then** exactly that contribution is materialized, into every runtime the plugin declares support
    for, and the others remain installed-but-unapplied
- [ ] **Scenario: un-applying does not uninstall**
  - **Given** a contribution applied to the workspace
  - **When** the human un-applies it
  - **Then** the materialization is removed from every runtime dir, the payload stays installed, and
    re-applying needs no refetch
- [ ] **Scenario: un-applying a hook un-merges rather than overwrites**
  - **Given** an applied hook whose runtime settings file the human has ALSO edited by hand
  - **When** the human un-applies that hook
  - **Then** Tachyon's entry is removed by the lockfile's adapter-owned removal identity and the
    human's own edits to that file survive untouched
- [ ] **Scenario: an armed hook is visible as armed**
  - **Given** a plugin installed with a hook not applied, and a second with its hook applied
  - **When** the human looks at the Plugins app
  - **Then** the two are distinguishable without opening a file — code that will run on the next
    matching event is never indistinguishable from code that will not
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
- **`view` is out, and not by oversight.** It is the one `TargetKind` that does not enter a *runtime's*
  ambient scope: a view is a surface inside Tachyon's own UI (spec 349), read by Tachyon and by nobody
  else. Toggling it is an interface preference, and modelling a preference as an authority grant would
  make the word "applied" mean two different things in one table. If views need a disable switch, that is
  its own small spec about UI, not this one about what a runtime can see. Written down so the omission is
  a decision the next reader can disagree with, rather than a gap they have to guess at.
- **`tools`, `data`, `externalTools` and `config` are out** — none is projected into a runtime-read
  location; see the table above for what each does instead. `${tool:<name>}` coupling is a sequencing
  question, recorded under Open questions.
- **`gitHooks` are out of Phases A–C.** They materialize into `.git/hooks/` through a Tachyon-managed
  chaining dispatcher with its own ownership registry (`gitHookRegistry.ts`), NOT through the lockfile's
  `TargetKind` — a different mechanism with a different removal story, and folding it in would mean
  designing two un-merges in one spec. It is a genuine follow-up, not an exclusion on principle: a git
  hook is code that runs too, and the argument above applies to it in full.

## Open questions

- **Where does "applied" live?** `plugins.lock.json` records what was installed and the paths it
  wrote. Applied-state is a different fact with a different lifetime (a human toggles it; an install
  does not). Same file with a new field, or its own record? The test is which one makes an
  un-applied skill impossible to resurrect by reload.
- **Does un-applying a hook mid-session need a different answer from un-applying a skill?** A1 already
  asks what each runtime does when a skill DIRECTORY disappears mid-session. A hook is sharper in two
  ways and the measurement must cover both: the entry lives in a settings file the runtime may have read
  once at start, so removal may not take effect until restart — and a hook may be MID-EXECUTION when its
  entry is removed. "It stops firing next time" and "the one currently running is killed" are different
  products; nobody has measured which one each runtime gives.
- **Does applying a skill that references `${tool:<name>}` require the tool first?** A skill's argv can
  reference a plugin-provisioned binary. Tools are out of the apply model (nothing to apply), but the
  ORDER still matters: applying a skill whose tool was never consented and provisioned delivers a skill
  that fails at first use. Either apply refuses with the reason, or the skill lands and fails later. The
  first is this repo's habit; it is not yet a decision.
- ~~**What does a fresh clone do?**~~ **RESOLVED by the maintainer, 2026-08-03.** Applied-state stays
  **local**. The rule stated is broader than this spec and worth recording as such: *"tachyon nunca
  deve viajar no repo … exceto o explicitamente declarado como as specs do plugin sdd"*.

  It is already the practice, which is why it is the right answer here rather than a preference:
  `.gitignore:13` closes `.tachyon/`, `:32` closes `tachyon.yml` itself, and the exceptions are
  re-opened BY NAME (`.tachyon/designs`, `.tachyon/evidence`, `.tachyon/reviews`, and the SDD
  plugin's `docs/specs/`). A fleet's own configuration does not travel; only deliberately published
  documents do.

  Consequence, and it is the correct default rather than a shortfall: a teammate who clones this repo
  gets the plugins declared and **nothing applied**. They choose, on their machine, exactly as this
  spec asks the first human to. The alternative would have handed someone skills they never selected,
  in a workspace they just opened — the same accident this whole spec exists to end, arriving through
  git instead of through install.

- ~~**Does the Temporary child's runtime filter already exist?**~~ **MEASURED, 2026-08-03 — yes.**
  `AgentManager.ts:1238` filters plugin targets with
  `candidate.kind === "skill-dir" && candidate.runtime === runtime`, over the four runtimes the
  toolkit admits (claude, codex, grok, pi). The shortfall IS reported: capture failure withholds the
  one skill BY NAME through `notifyDelegatedToolkitCondition` rather than failing the delegation
  (`t-b505b3` follow-up), and a digest conflict refuses rather than refreshing (`t-b0cfd4`). Nothing
  to build; Phase B only moves what it reads FROM.
