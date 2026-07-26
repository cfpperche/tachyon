# 466 — claude-agent-form-parity — tasks

_Generated from `plan.md` on 2026-07-26. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Derivar policies Claude/Codex a partir do adapter.
- [x] Normalizar/validar mutation create/edit e troca de runtime.
- [x] Renderizar selectors e families Claude/Codex com textos localizados.
- [x] Cobrir round-trip, unsupported fields e regressões.
- [x] Executar Dev Host funcional e visual.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Testes focados Studio e profile passam.
- [x] Typecheck e verify:full:quiet passam.

**Headless check:** `npx vitest run test/unit/agentProfileStudio.test.ts test/unit/agentStudioDomain.test.ts`
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `npx vitest run test/unit/agentProfileStudio.test.ts test/unit/agentStudioDomain.test.ts`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** Dev Host Agent Studio New/Edit com Claude selecionado.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

- [x] Evidence: `claude-agent-form-parity.mjs` passou todos os asserts no Dev Host
  real; screenshot pós-save mostrou readiness Ready e policies Supported.
- [x] Verdict: controles Claude são legíveis, provider/service tier não aparecem
  e o perfil salvo preserva model/effort/permissions no round-trip.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <466>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

<!-- **Cookbook:** yes -->
**Cookbook-Opt-Out:** surface is self-describing in Agent Studio.
