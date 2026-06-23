# Spec 251 — notes

## Runtime-capability verification (2026-06-23) — the decision-driver

Before committing to skills-as-a-plugin-capability, verified the open assumption ("skills are claude-specific, so they'd break the common-denominator thesis") against **live official docs**, per the runtime-capabilities discipline (don't assert from training data).

**Result: the assumption was FALSE — skills are portable across both v1 runtimes.**

- **Codex CLI loads skills** in the **same `SKILL.md` format** as Claude Code. Project-level path = **`.agents/skills/`** (scanned from cwd up to repo root), per [Agent Skills — Codex (OpenAI)](https://developers.openai.com/codex/skills). A third-party blog claimed `.codex/skills/`; the official docs do **not** — `.codex/config.toml` is config, not skill discovery. Codex does not merge same-named skills (both appear in selectors).
- **Claude Code** loads project skills from `.claude/skills/<name>/` (well-established; Agent0 uses it).
- Both require frontmatter `name` + `description`; optional `scripts/`, `references/`, `assets/`.

**Design consequence:** the skill *content* is identical across runtimes; only the *destination* differs. That is the inverse of hooks (content differs per runtime → per-runtime blocks). Hence **D2: a neutral `skills/` payload** + per-runtime adapter destinations. Skills become the model example of the common-denominator thesis, not an exception.

## Decision trail (from the design chat)

1. Maintainer chose: keep the plugin system the **common denominator between runtimes**; **skills next**, **MCP after**.
2. I initially flagged skills as claude-specific (a risk to the thesis). **Self-corrected after verification** — skills are portable; the worry was unfounded (recorded so the spec doesn't carry the wrong premise).
3. Collision handling: maintainer's one objection to the first cut — the adapter must **not auto-refuse**; surface **Keep / Replace** to the human in the consent drawer (D4). Follow-on requirement: **Replace must be reversible** (D5) — back up the user's original, restore on Remove. This became OQ2 (the mechanics).
4. Framing correction (maintainer): hooks are not "just shell scripts" — a hook command can launch any executable/interpreter and the `type` is extensible; the real surface is arbitrary code execution on an event. Folded into spec.md so the skill consent section uses accurate language.

## Open questions carried into the build

- **OQ1** — auto-discover `skills/` vs explicit manifest list. Lean: auto-discover.
- **OQ2** — backup-on-Replace location + precise restore + safe degrade when backup missing. The crux of Step 3.
- **OQ3** — bare skill name vs plugin-namespaced; affects collision frequency + how the agent invokes the skill. Lean: bare name, rely on Keep/Replace.
- **OQ4** — runtime-location copy vs link back to the committed payload. Lean: real copy.
