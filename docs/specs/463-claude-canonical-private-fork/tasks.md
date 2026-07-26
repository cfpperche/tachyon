# 463 — claude-canonical-private-fork — tasks

_Generated from `plan.md` on 2026-07-26. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Propagar o home exato da fonte e as projeções ao fork.
- [x] Materializar/aplicar o home privado do destino antes do seed.
- [x] Semear entre namespaces no mesmo cwd e em worktree.
- [x] Limpar home parcial em falha segura.
- [x] Atualizar testes e matriz de paridade.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Testes focados cobrem homes distintos, projeções e worktree.
- [x] Typecheck e verificação completa passam.

**Headless check:** `npm run verify:full:quiet`
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** Exige sessão Claude autenticada e viva; testes determinísticos cobrem home, transcript e cleanup.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** opcional
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

**Visual QA Opt-Out:** Mudança exclusiva de lifecycle/runtime, sem superfície visual.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <463>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

**Cookbook-Opt-Out:** Não introduz nova superfície de operador.
