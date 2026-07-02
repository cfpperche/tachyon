# 326 — sdd-visual-qa-light-contract — plan

_Drafted from `spec.md` on 2026-07-02. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add the lightest useful visual-review layer to the existing SDD conventions:

1. Update `SKILL.md` so agents know that visual/interface changes require an explicit visual pass before delivery.
2. Update `plan.md` and `tasks.md` templates with optional prose prompts:
   - `Visual impact` in the plan: surface(s), visual risks, proof expected.
   - `Visual QA` in tasks: inspect the real/previewed surface, record evidence, fix obvious layout problems.
3. Extend `sdd-close.sh` with a warning-only heuristic:
   - detect likely visual specs through broad text signals in `spec.md` only, so optional template prompts do not make every shipped spec warn;
   - suppress the warning if the spec records `Visual QA` evidence or a `Visual QA Opt-Out` reason;
   - report warning in human and JSON output without incrementing `total_findings`.
4. Validate with targeted shell fixtures plus the existing close script behavior.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Plain-prose visual impact, not an enum** — chosen because surfaces vary across browser pages, VS Code webviews, screenshots, terminal UI, and native-looking views; rejected `UI impact: none | web | vscode-webview | native` because it would be brittle and invite bikeshedding.
- **Warning-only close signal** — chosen because we want the habit without making SDD bureaucratic; rejected hard failure because existing shipped specs may not have visual proof and the heuristic will be imperfect.
- **Tool-agnostic proof** — chosen because the right proof may be a real screenshot, browser/preview run, human dogfood, or Visual QA verdict; rejected mandatory Playwright/Visual QA because VS Code webviews and local extension panels are not always browser-drivable.
- **Heuristic detector** — chosen because SDD specs are markdown conventions, not a schema; rejected adding a required field because the user explicitly wants to avoid rigid classification.

## Files touched

_The modules/files this will create or change, with a one-line note on each._

- `/home/goat/tachyon-plugins/sdd/skills/sdd/SKILL.md` — document visual-proof discipline and close warning in the plugin source.
- `/home/goat/tachyon-plugins/sdd/skills/sdd/templates/plan.md.tmpl` — add optional `Visual impact` prompt.
- `/home/goat/tachyon-plugins/sdd/skills/sdd/templates/tasks.md.tmpl` — add optional `Visual QA` prompt and opt-out convention.
- `/home/goat/tachyon-plugins/sdd/skills/sdd/scripts/sdd-close.sh` — warn on likely visual shipped specs with no proof/opt-out.
- `/home/goat/tachyon-plugins/sdd/skills/sdd/scripts/test-visual-close.sh` — focused warning/evidence/opt-out regression coverage.
- `docs/specs/326-sdd-visual-qa-light-contract/*` — this spec's contract, plan, tasks, and evidence.

## Risks & unknowns

_What could go wrong, what's not yet proven, what to verify early._

- Keyword detection can false-positive; warning-only severity keeps this low-cost.
- Templates can become noisy; keep visual sections optional and short.
- Agents may fill placeholder Visual QA text without actually looking; close should look for concrete `Evidence:` or `Verdict:` style lines, not merely the section header.

## Sources consulted

_Docs, code references, prior specs that informed this plan. Read the repo before proposing._

- `/home/goat/tachyon-plugins/sdd/skills/sdd/SKILL.md` — existing verify/dogfood/close contract.
- `/home/goat/tachyon-plugins/sdd/skills/sdd/templates/{plan,tasks}.md.tmpl` — current scaffold prompts.
- `/home/goat/tachyon-plugins/sdd/skills/sdd/scripts/sdd-close.sh` — current finding/warning output and JSON shape.
- `docs/specs/239-tachyon-agent-activity-log/*` — prior specs already mention UI impact and EDH visual validation informally.
- `docs/specs/324-activity-share-actions/*` — motivating example where headless validation missed bad UI composition.
