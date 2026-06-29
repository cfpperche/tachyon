# 294 — product-foundation-plugin — tasks

_From `plan.md`. Check off as delivered._

**Verify:** `node -e "require('child_process').execSync('npx tsx -e \"import {loadPlugin} from process.env.PWD+\\'/src/plugins/engine.ts\\'\"')"` — see the dogfood task; the mechanical gate is **loadPlugin → 0 errors** + the headless install dogfood passing.

## T1 — scaffold the plugin shell
- [ ] `tachyon-plugins/product-foundation/tachyon-plugin.json` — name `product-foundation`, version `0.1.0`, description
      (audit for the `': '` YAML trap), `runtimes:["claude"]`, `dependencies:["agent-browser@^2.1.0"]`.
- [ ] `skills/product-foundation/` dir created (the materialized skill root).

## T2 — copy the skill payload
- [ ] copy SKILL.md + `templates/` + `references/` + `schemas/` + `scripts/` + `vendor/` + `design-systems/` from the
      source into `skills/product-foundation/`.
- [ ] confirm the 6.3 MB design-system bundle + the Apache-2.0 `vendor/open-design/{LICENSE,NOTICE}` came across intact.

## T3 — rename product → product-foundation
- [ ] SKILL.md `name: product-foundation`; update `argument-hint`, title, self-description, `metadata.skill-version` → 0.1.0.
- [ ] rewrite every `.claude/skills/product/…` self-path → `.claude/skills/product-foundation/…` (scripts, templates, refs).
- [ ] `grep -rn 'skills/product/' skills/product-foundation/` returns **zero**.

## T4 — strip the dead MCP prose (D2) + verify the invariants survive
- [ ] remove `product_step_submit` / `schema-incomplete` / "MCP regex-extracts" / "delivery-plan MCP" / `product_advance`
      / `product_gate_pass` from the 31 carrying files; reword to the skill-body reality.
- [ ] `grep -rniE 'product_step_submit|schema-incomplete|mcp[ _-]?regex|delivery-plan mcp|product_advance|product_gate_pass'`
      returns **zero** (the MCP `.mcp.json.example` legal/oss references that are GENUINE product-pipeline-doc content,
      not the dead pipeline-MCP, may stay — judge each).
- [ ] invariant survival check: `validation_mode:` extraction, the per-step `schema.md` floors, atomic multi-file writes,
      and explicit `.state.json` transitions each still have a body/script home (grep by behavior).

## T5 — de-Agent0 (D4) + agent-browser plugin wiring (D3)
- [ ] strip `.agent0/…` paths, `Agent0` names, the Agent0-harness allowlist framing in Phase 0 / `clear-target.sh`.
- [ ] the Phase-4 visual check points at the **agent-browser plugin** (its materialized skill), not
      `bash .agent0/tools/agent-browser.sh`; degrade-to-skip prose kept; never block.
- [ ] the Phase-5 SDD handoff references the `sdd` plugin generically (no Agent0 `/sdd` path).
- [ ] `git grep -niE 'agent0|\.agent0|/home/'` over the plugin tree returns **zero** (public-surface hygiene).

## T6 — validate
- [ ] `loadPlugin(product-foundation)` → **0 errors** (run early; the manifest + SKILL.md frontmatter parse).
- [ ] headless install dogfood (temp git workspace): the skill block materializes to `.claude/skills/product-foundation/`,
      the lockfile records the skill, the drawer/preview surfaces the `agent-browser` dependency (⚠ missing in a bare ws),
      install is non-blocking.
- [ ] representative pipeline slice: Phase 0 init writes a v6 `.state.json`; ≥1 step produces its artifact; a
      `.state.json` transition is recorded; a schema-floor violation is rejected (schema-incomplete-style) without
      advancing state; the visual check records a skip when agent-browser is absent.
- [ ] the bundled scripts run from the materialized path (`craft-floor-check.ts` over a fixture HTML).

## T7 — review + close
- [ ] codex impl dueto (security/path-rewrite-completeness/MCP-strip-correctness/invariant-survival/Agent0-leak/fidelity),
      verdict folded.
- [ ] spec 294 → status `shipped` + `**Closure:**`; acceptance boxes checked; handoff note appended.
- [ ] (gated, on owner OK) push tachyon-plugins + tag; bump the site banner.
