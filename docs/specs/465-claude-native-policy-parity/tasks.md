# 465 — claude-native-policy-parity — tasks

_Generated from `plan.md` on 2026-07-26. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Fixar tuples medidos; registrar que o probe solicitado não provou o modelo efetivo.
- [x] Generalizar sources e validações do projector Claude.
- [x] Materializar selectors medidos e rejeitar os não suportados.
- [x] Provar equivalência e cleanup em fresh/restart/resume/fork.
- [x] Atualizar documentação e matriz.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Testes focados profile/harness/lifecycle passam.
- [x] Typecheck e verify:full:quiet passam.

**Headless check:** `npx vitest run test/unit/agentProfileConfigLoader.test.ts test/unit/harness.test.ts test/unit/agentManager.test.ts`
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `npx vitest run test/unit/agentProfileConfigLoader.test.ts test/unit/harness.test.ts test/unit/agentManager.test.ts`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** criar perfil Claude com global/workspace selectors no Agent Studio após `t-36b7f0`; esta slice não adiciona UI.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

**Visual QA Opt-Out:** mudança de policy/projeção sem nova superfície visual.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <465>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

<!-- **Cookbook:** yes -->
**Cookbook-Opt-Out:** policy interna; o fluxo de operador será documentado pelo Agent Form.
