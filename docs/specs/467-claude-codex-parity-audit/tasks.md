# 467 — claude-codex-parity-audit — tasks

_Generated from `plan.md` on 2026-07-26. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Mapear claims e evidências.
- [x] Rodar suíte focada comparativa.
- [x] Executar dogfood Agent Form para Claude e Codex.
- [x] Publicar relatório e reconciliar matriz.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Todos os claims possuem prova direta ou gap registrado.
- [x] Typecheck e verify:full:quiet passam.

**Headless check:** `npx vitest run test/unit/agentProfileStudio.test.ts test/unit/agentProfileConfigLoader.test.ts test/unit/codexRuntimeConfigInventory.test.ts test/unit/claudeRuntimeConfigInventory.test.ts test/unit/harness.test.ts test/unit/agentManager.test.ts`
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `npx vitest run test/unit/agentProfileStudio.test.ts test/unit/agentProfileConfigLoader.test.ts test/unit/codexRuntimeConfigInventory.test.ts test/unit/claudeRuntimeConfigInventory.test.ts test/unit/harness.test.ts test/unit/agentManager.test.ts`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** não requerido; Dev Host headless comparativo cobre a superfície real.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

- [x] Evidence: `.tachyon/dev-host/interactive-out/claude-codex-parity-audit.png`
  e `docs/reports/claude-codex-canonical-parity-audit-2026-07-26.md`.
- [x] Verdict: paridade atingida; Codex permanece `Limited` apenas pela
  indisponibilidade nativa de fork, sem truncamento ou contradição visual.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <467>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

<!-- **Cookbook:** yes -->
**Cookbook-Opt-Out:** auditoria não cria nova superfície operacional.
