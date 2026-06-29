# 294 — product-foundation-plugin — plan

_Drafted from `spec.md` on 2026-06-29. The approach, not the steps (those go in `tasks.md`)._

## Approach

Port the Agent0 `/product` skill (8.1 MB: SKILL.md + `templates/pipeline/01..15`, `references/`, `schemas/`,
`scripts/`, `vendor/open-design/`, and the 6.3 MB / 151-vendor `design-systems/` bundle) into a self-contained
**skill-payload** Tachyon plugin at `tachyon-plugins/product-foundation/`, materializing as
`skills/product-foundation/` → `.claude/skills/product-foundation/` (mirrors how the `sdd` plugin's `skills/sdd/`
materializes). No new engine, no MCP block, no provisioned tools — `runtimes: ["claude"]` (D1), with a spec-276
`dependencies: ["agent-browser@^2.1.0"]` for the best-effort visual check (D3).

The port is a **wholesale copy + four targeted rewrite sweeps**, because the pipeline's substance (the 15 steps, gates,
judge protocol, state machine, design-system bundle) is migrated verbatim, NOT redesigned:

1. **Copy** the skill tree into the plugin's `skills/product-foundation/`.
2. **Rename** `product` → `product-foundation`: the skill dir, the SKILL.md `name:`/`argument-hint`, and every self-path
   `.claude/skills/product/...` → `.claude/skills/product-foundation/...` (35 files carry a path/name ref).
3. **Strip the dead MCP prose** (D2): remove `product_step_submit` / `{schema-incomplete}` / "the MCP regex-extracts" /
   "future delivery-plan MCP step" / `product_advance`/`gate_pass` from the step templates + references (31 files, 62
   occurrences). The live behavior these named **already lives in the skill body + scripts today** (the body writes
   `.state.json`, runs `craft-floor-check.ts`, and enforces each step's `schema.md` Layer-1 floors) — so the re-home is
   mostly a PROSE strip, with a verification pass that no stripped sentence was the only home of an invariant
   (`validation_mode:` extraction, the schema-completeness floors, atomic multi-file writes, explicit state transitions).
4. **De-Agent0** (D4): strip every `.agent0/…` path, `Agent0` name, and Agent0-harness assumption (e.g. the Phase-0
   `clear-target.sh` "Agent0 harness allowlist", the `bash .agent0/tools/agent-browser.sh` visual-check invocation, the
   spec-153 "no .mcp.json seed" framing) → generic / plugin-relative / the `agent-browser` PLUGIN. Re-point the Phase-5
   SDD handoff at the `sdd` plugin generically. Audit with `git grep -niE 'agent0|\.agent0|/home/'`.

Then validate (loadPlugin → headless install dogfood → a representative pipeline slice), run the codex impl dueto, fold,
and close.

## Key decisions

- **D1 claude-only v1** — chosen because codex sub-agent delegation is convention-only (not the enforced 5-field-brief
  dispatch the pipeline spine needs); rejected claude+codex-v1 because a hollow codex port is worse than a deliberate
  fast-follow spec. `runtimes: ["claude"]`.
- **D3 reuse `agent-browser` via a spec-276 dependency** — chosen because the dep is declared/surfaced/non-blocking/
  no-auto-install, so it adds the browser capability honestly without bloating the core install or blocking when absent;
  rejected bundling a browser primitive (reinvents shipped machinery) and rejected depending on `visual-qa` (it is
  real-URL/worktree-merge oriented; product-foundation needs the raw `file://` hi-fi sweep, so it depends on
  `agent-browser` directly, as `visual-qa` itself does).
- **OQ2 RESOLVED — keep validation body+script-driven, don't build a new validator** — chosen because the source ALREADY
  is (the body enforces per-step `schema.md` floors + writes state; `craft-floor-check.ts` is the only bundled checker,
  advisory anti-slop). Porting it verbatim re-homes the invariants by construction; rejected authoring a fresh Layer-1
  validator surface (the MCP never owned the logic — it only narrated it).
- **OQ3 RESOLVED — ship all 151 design-systems (6.3 MB)** — chosen because the catalog's value is breadth (Step 14 reads
  1–2 chosen `DESIGN.md` per run via `od-catalog-index.json`; the rest are lazily referenced), git distribution handles
  6.3 MB fine, and the engine's 200 KB cap is PER-ARTIFACT (no individual file is near it), not per-install; rejected a
  curated subset (silently narrows the design vocabulary the pipeline can pick from). Flag the size in the README.
- **Scripts stay TS run via the host runtime** — `craft-floor-check.ts` / `staleness-check.ts` / `build-report.ts` /
  `sync-open-design.ts` port as-is (the source invokes them with `bun`); the plugin keeps that, since the runtime that
  runs the skill has node/bun. No new tool provisioning.

## Files touched

- `tachyon-plugins/product-foundation/tachyon-plugin.json` — NEW manifest (name, version 0.1.0, description,
  `runtimes:["claude"]`, `dependencies:["agent-browser@^2.1.0"]`).
- `tachyon-plugins/product-foundation/skills/product-foundation/**` — the ported skill (SKILL.md + templates/ +
  references/ + schemas/ + scripts/ + vendor/ + design-systems/), renamed + MCP-stripped + de-Agent0'd.
- `tachyon-plugins/product-foundation/README.md` — NEW (what it is, the docs-first/not-a-runnable-app expectation, the
  agent-browser dependency + the 6.3 MB design-system note, claude-only v1).
- `tachyon-plugins/product-foundation/CREDITS` (or NOTICE) — carry the Apache-2.0 Open-Design attribution
  (`vendor/open-design/{LICENSE,NOTICE}`) intact.

## Risks & unknowns

- **A stripped MCP sentence was load-bearing.** Mitigation: after the strip, grep the 4 invariants by behavior
  (`validation_mode`, the schema floors, atomic writes, state transitions) and confirm each still has a body/script home;
  the impl dueto explicitly checks this.
- **Self-path refs missed → a runtime `Read`/`bash` 404.** Mitigation: after the rename sweep, `grep -rn
  'skills/product/' ` must return zero; the dogfood runs a slice that actually invokes a script path.
- **loadPlugin chokes on the SKILL.md frontmatter** (the recurring `': '` YAML trap from spec 291). Mitigation: validate
  loadPlugin = 0 errors early, before any other work; the description is long — audit it for unquoted `': '`.
- **Codex-only / Agent0-only assumptions baked deep in step prompts** (delegation-gate 5-field briefs, AskUserQuestion).
  Claude-only v1 keeps AskUserQuestion legitimately; the delegation-brief discipline ports as skill guidance (no
  Agent0 hook to enforce it — note that honestly).
- **Dogfood depth.** A full 15-step run is long + model-heavy; the dogfood proves the INSTALL + a representative slice
  (Phase 0 init + ≥1 step producing an artifact + a `.state.json` transition + a schema-floor rejection), not a full
  founder run. Note the bound.

## Sources consulted

- The source skill: `/home/goat/Agent0/.claude/skills/product/` (SKILL.md v0.6.0, `templates/pipeline/`, `references/`,
  `scripts/`, `design-systems/`, `vendor/open-design/`).
- `tachyon-plugins/sdd` + `transcribe` (skill-block layout: `skills/<name>/` auto-discovered → `.claude/skills/<name>/`).
- `tachyon-plugins/agent-browser` (v2.1.1) + `visual-qa` (the spec-276 dependency pattern).
- `docs/specs/276-plugin-dependencies` (declared/non-blocking/no-auto-install dep semantics).
- The 2026-06-29 codex design dueto: `.agent0/.runtime-state/codex-exec/product-plugin-dueto-result.md`.
