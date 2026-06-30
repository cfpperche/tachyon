# 301 — sdd-headless-dogfood-contract — plan

_Drafted from `spec.md` on 2026-06-30. The approach, not the steps (those go in `tasks.md`)._

## Approach

Implement dogfood as an SDD markdown contract and bundled shell helper in the `sdd` plugin.

1. Add `scripts/sdd-dogfood.sh` beside `spec-verify.sh` and `sdd-close.sh`. It resolves a spec target the same way as `spec-verify.sh`, extracts `**Dogfood:** `<cmd>`` lines from `tasks.md` first, then `spec.md`, previews by default, executes only with `--run`, and appends results under `## Dogfood log` in `notes.md` with pass/fail, timestamp, and best-effort git SHA.
2. Extend `sdd-close.sh` with dogfood findings for shipped/shipped-partial specs: `dogfood-missing` (no Dogfood and no opt-out), `dogfood-unrun` (Dogfood declared but no passing dogfood log), and `dogfood-opt-out-empty` (opt-out present without a reason). Valid opt-outs should be visible in human/JSON output as warnings, not silent.
3. Update the SDD skill docs and tasks template so new specs get a visible headless dogfood slot and optional human dogfood route.
4. Formalize `shipped-partial` in the SDD docs/template status enum, because existing `sdd-close.sh` already recognizes it and this feature also references it.
5. Keep `Verify` separate from `Dogfood`: verify proves test/build checks; dogfood proves the feature has been exercised through a representative real/headless usage path.
6. Dogfood the dogfood feature with fixture specs in a temp workspace, then materialize/install through Tachyon as done for prior SDD plugin changes.
7. Use `probe_agent(runtime=claude)` for a design review before implementation and fold actionable feedback into this spec/plan/tasks.

## Key decisions

- **Dogfood is a separate contract from Verify** — chosen because a passing unit/build command does not prove a feature was exercised through the intended workflow; rejected overloading `Verify` because the names would stop communicating intent.
- **Preview-by-default command execution** — chosen because commands are selected from markdown and can be edited by a branch; rejected automatic execution because it would weaken the safety model established by spec 295.
- **Passing dogfood log required for shipped specs unless opted out** — chosen because the user explicitly wants headless dogfood mandatory if possible; rejected checking only `**Dogfood:**` declaration because that proves a string exists, not that dogfood actually ran.
- **Opt-out must carry a reason and remain visible** — chosen because an empty opt-out would make the mandatory contract toothless; rejected silent opt-out success because it hides debt.
- **Human dogfood is optional** — chosen because human approval can be valuable but cannot always be automated or required in CI/headless agent work; rejected making it blocking because it would stall agent-only specs.
- **New script instead of generalizing spec-verify** — chosen for clarity and a smaller change surface; rejected a generic `--kind` in v1 because it increases parser/logging complexity for little benefit.

## Files touched

- `/home/goat/tachyon-plugins/sdd/skills/sdd/scripts/sdd-dogfood.sh` — new preview/run/log helper for `**Dogfood:**` declarations.
- `/home/goat/tachyon-plugins/sdd/skills/sdd/scripts/sdd-close.sh` — add dogfood proof findings and visible opt-out reporting.
- `/home/goat/tachyon-plugins/sdd/skills/sdd/SKILL.md` — document `dogfood`, `Dogfood`, `Dogfood-Opt-Out`, and human dogfood.
- `/home/goat/tachyon-plugins/sdd/skills/sdd/templates/spec.md.tmpl` — formalize `shipped-partial` in the status enum if kept.
- `/home/goat/tachyon-plugins/sdd/skills/sdd/templates/tasks.md.tmpl` — add headless dogfood and optional human dogfood slots for new specs.
- `/home/goat/tachyon-plugins/sdd/tachyon-plugin.json` and `/home/goat/tachyon-plugins/README.md` — bump/describe the new SDD capability.
- `docs/specs/301-sdd-headless-dogfood-contract/*` — Tachyon-side spec, plan, tasks, and evidence notes.

## Risks & unknowns

- `sdd-close` will start flagging existing shipped specs. The opt-out convention must be clear enough that historical specs can be closed intentionally rather than rewritten, and the output must make opt-outs visible.
- Duplicating resolution/parsing logic from `spec-verify.sh` risks drift; keep the helper small and parallel in style, or share only after tests prove value.
- Human dogfood syntax should not be over-engineered. A heading/checklist in tasks is enough for v1.
- The SDD plugin lives in `/home/goat/tachyon-plugins`; Tachyon workspace specs record the intent/evidence, but plugin changes must be committed/pushed separately when shipping.

## Sources consulted

- Pin `p-2c37de`: "Dogfood headless para SDD"; owner lean = headless mandatory if possible, human opt-in.
- `docs/specs/295-sdd-verify-close/` — existing `verify`/`close` safety model and preview-by-default decision.
- `docs/specs/296-sdd-worktree-spec-allocation/` — recent real SDD dogfood evidence style.
- `/home/goat/tachyon-plugins/sdd/skills/sdd/scripts/spec-verify.sh` and `sdd-close.sh` — current helper contracts.
- Anthropic Claude Code hooks documentation — useful reference for Stop/SubagentStop enforcement patterns, but runtime-specific and therefore not the v1 SDD contract.
- OpenAI Codex CLI `exec` documentation — useful reference for headless/non-interactive runs, but the SDD contract should remain generic shell-driven.
- Claude probe `probe-31453057-ffc9-42ef-af08-d1479d2d8226` — found three design corrections before implementation: require execution log, make opt-out non-empty/visible, and resolve `shipped-partial` status drift.
