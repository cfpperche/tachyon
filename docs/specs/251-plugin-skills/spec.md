# Spec 251 — Plugin skills (the second plugin capability, after hooks)

**Status:** DESIGN AGREED (the 5 forks were decided with the maintainer; see Decisions). One capability remains open as OQs (backup-on-Replace mechanics + manifest declaration shape). · **Follows:** [spec 250](../250-tachyon-plugin-system/) — the plugin engine, which ships hooks-only and already **reserves the `skill-dir` `TargetKind`** in the lockfile. · **Surface:** the plugin manifest (a neutral `skills/` payload), the materialization engine (a `skill-dir` install/remove path), the per-runtime adapters (claude + codex skill destinations), and the consent drawer (a skill section + a Keep/Replace collision choice). · **UI impact:** flow (the consent drawer gains a skill section + a per-collision Keep/Replace control; installed cards may surface a skill capability).

> **Origin.** Spec 250 shipped the plugin system as **hooks-only** — the highest-leverage *and* most-portable capability (claude + codex share the native hooks structure). The maintainer's chosen direction: keep the plugin system the **common denominator between runtimes**, and add **skills next** — skills are the most-used, most-loved AI capability today. The open design question was whether skills break the common-denominator thesis (they looked claude-specific). **Verified false:** Codex CLI loads the **same `SKILL.md` format** as Claude Code, at a project-level path (`.agents/skills/`), so a skill is genuinely portable — only its *install location* differs per runtime. Skills are therefore the *model example* of the common-denominator design, not an exception to it.

## Problem

A plugin can wire hooks into a workspace's runtimes, but **not skills** — today the most-used way to give an agent a new capability. The engine reserves a `skill-dir` `TargetKind` but never materializes one; `loadPlugin` requires a `hooks.json` in every block and ignores everything else. There is no way to package a `SKILL.md` (+ its scripts) once and have Tachyon install it — with consent, collision safety, and clean removal — into each present runtime that loads skills.

## Goal

A plugin may ship **skills** as a **runtime-neutral payload** (`skills/<name>/SKILL.md`, written once). On install, each present runtime's adapter materializes the skill into **that runtime's** skills location; a runtime with no skills loader is **skipped** (the same honest declare-and-skip model the hooks path already uses for an absent runtime). The consent drawer shows the skill (frontmatter + bundled scripts + destination) before any write; a name collision with the user's own skill is **the human's decision (Keep / Replace)**, never a silent clobber or a hard refuse; and **Replace is reversible** — Tachyon backs up the user's original and Remove restores it. Removal deletes exactly the skill-dirs Tachyon wrote (recorded in the lockfile), never a user's skill.

## Prior art (verified against official docs, 2026-06-23)

A skill is a directory `<name>/SKILL.md` with mandatory frontmatter (`name`, `description`) + optional `scripts/`, `references/`, `assets/`. **The format is shared** across the two v1 runtimes:

| Runtime | Project-level skills path | Notes |
|---|---|---|
| **claude** | `.claude/skills/<name>/` | also user-level `~/.claude/skills/` (out of scope) |
| **codex** | `.agents/skills/<name>/` | per the official Codex docs — scans `.agents/skills` from cwd up to repo root; **NOT** `.codex/skills/` (a third-party claim). Same `SKILL.md` format. Codex does not merge same-named skills — both appear in selectors. |

Sources: [Agent Skills — Codex (OpenAI)](https://developers.openai.com/codex/skills), [Customization — Codex](https://developers.openai.com/codex/concepts/customization).

The takeaway that drives the design: **the skill content is identical across runtimes; only the destination differs.** That is the inverse of hooks (where the *content* differs per runtime because event semantics differ), which is exactly why skills get a **neutral payload** and hooks keep **per-runtime blocks**.

## Decisions (agreed with the maintainer)

- **D1 — Skills are the next plugin capability; common-denominator-first.** MCP comes after skills. Verified: skills are portable across claude + codex (same `SKILL.md`), so adding them *strengthens* the common-denominator thesis rather than breaking it. (This corrects the initial in-conversation assumption that skills are claude-specific.)
- **D2 — Neutral skill payload, NOT per-runtime blocks.** A plugin ships `skills/<name>/` **once**; each adapter copies it to its runtime's location (claude → `.claude/skills/<name>/`, codex → `.agents/skills/<name>/`). Hooks stay per-runtime (`claude/hooks.json`, `codex/hooks.json`) because their content differs; skills do not.
- **D3 — A runtime with no skills loader is skipped.** Same declare-and-skip model as an absent runtime. Both v1 runtimes load skills, so neither skips today; the model is ready for a future runtime that has no skills.
- **D4 — Collision = the human decides (Keep / Replace), surfaced in the consent drawer.** If a same-named skill dir already exists at a runtime's destination, the adapter **does not auto-refuse** — the drawer shows the collision and offers **Keep** (skip this runtime's copy, leave the user's skill) or **Replace** (overwrite). The decision is per colliding destination.
- **D5 — Replace is destructive, gated by a DOUBLE confirmation (maintainer-decided 2026-06-23, overriding the earlier "reversible/backup" proposal).** No backup. On Replace the user's existing skill at the destination is permanently overwritten; Remove later deletes the materialized skill-dir (nothing to restore). The protection is consent, not reversibility: the consent drawer surfaces each collision and requires an explicit second confirmation for Replace (Keep is the safe default). At the engine layer this is fail-closed — applyInstall refuses a colliding destination unless an explicit `replace` decision is supplied for it (it never silently overwrites or silently skips). This simplifies the engine (no `.skill-backups/`, no restore-on-remove, no lockfile backup pointer) and OQ2 is resolved/closed.
- **D6 — Reuse the reserved `skill-dir` `TargetKind`.** The lockfile (spec 250) already declares it; each materialized skill-dir is recorded as a target for precise removal. No enum change.
- **D7 — Consent surface for skills.** The drawer's skill section shows the `SKILL.md` frontmatter (`name`/`description`), the **bundled scripts** (the real risk — a skill may carry arbitrary code its instructions invoke), and the destination path per runtime. Lower *direct* risk than a hook (a skill is instructions read on demand, not code auto-fired on an event), but bundled scripts are arbitrary code, so they are shown.
- **D8 — Project-level skills only in v1.** Materialize to the committed, per-workspace project paths (`.claude/skills/`, `.agents/skills/`), consistent with the hooks model (committed-by-default, re-hydrate on clone). User-level (`~/.claude/skills/`) is out of scope (not per-workspace, not committable).

> **Framing correction folded from the design chat:** a hook's security surface was loosely called "shell script." Corrected: a hook `command` can launch **any executable/interpreter** (`python3 …`, `node …`, a binary) and the `type` field is an extensible discriminator — the real surface is *arbitrary code execution on an event*, language-independent. The consent drawer already shows the literal command (which reveals what runs), so the UI is correct; only the description needed fixing. Recorded here so the skill consent section uses accurate language.

## Open Questions

- **OQ1 — How a plugin declares its skills.** Auto-discover the plugin's `skills/` dir (DRY, the dir is the source of truth — mirrors how `blocks` points at dirs), or an explicit manifest list `skills: [...]` (auditable, but redundant)? **Lean:** auto-discover `skills/`, with each immediate subdir that contains a `SKILL.md` treated as one skill; validate frontmatter at load.
- **OQ2 — CLOSED.** Backup-on-Replace was resolved by D5: there is NO backup. Replace overwrites permanently behind a double confirmation; no `.skill-backups/`, no restore.
- **OQ3 — Skill name & namespacing.** A skill is invoked by its `name` frontmatter. Does collision-check (and the installed name) use the bare `<name>` or a plugin-namespaced `<plugin>__<name>`? Namespacing avoids collisions but requires rewriting the materialized `SKILL.md`'s `name` (and changes how the user invokes it). **Lean:** install under the bare name (so the skill works as authored) and rely on D4 (Keep/Replace) for collisions — but pressure-test against a marketplace where name clashes are common.
- **OQ4 — Does the skill payload travel inside the existing committed plugin payload, or alongside it?** Spec 250 already copies the whole plugin dir to `.tachyon/plugins/<name>/` (committed). The skill destinations (`.claude/skills/`, `.agents/skills/`) are a SECOND copy at the runtime location. Is the runtime copy a copy, or a link back to the payload? **Lean:** a real copy at the runtime location (links are fragile across clones/OSes); the `.tachyon/plugins/<name>/` payload remains the re-hydrate source.

## Acceptance

- [ ] A plugin shipping `skills/<name>/SKILL.md` installs that skill into every present runtime that loads skills (claude → `.claude/skills/<name>/`, codex → `.agents/skills/<name>/`); a runtime without a skills loader is reported as skipped.
- [ ] The consent drawer shows, per skill: frontmatter (`name`/`description`), bundled scripts, and each runtime destination — before any write.
- [ ] A name collision at a destination surfaces **Keep / Replace** in the drawer; Keep leaves the user's skill untouched; Replace overwrites **and** backs up the original.
- [ ] Remove deletes exactly the skill-dirs recorded in the lockfile, restores any Replace backup, and never touches a user's own (Kept) skill.
- [ ] A plugin that mixes hooks + skills installs both; hooks stay per-runtime, skills come from the neutral `skills/` payload.
- [ ] Engine unit tests cover: install/skip per runtime, collision Keep, collision Replace + restore-on-remove, and a missing-backup-at-remove safe degrade. UI proven by driving the real built bundle (consent drawer skill section + Keep/Replace).
