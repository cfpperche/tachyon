# 467 — claude-codex-parity-audit

_Created 2026-07-26._

**Status:** shipped
**Closure:** Comparative Agent Form dogfood, 545 focused regressions and the
integrated typecheck/full gate prove Claude↔Codex canonical capability parity;
the durable audit records Codex's legitimate native-fork limitation.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Auditar a paridade Claude↔Codex após Runtime Config, policy/projeção e Agent
Form, exigindo evidência direta para autoria, proveniência, lifecycle,
isolamento, auth externa, pending/next launch e fail-closed. A conclusão deve
distinguir equivalência de produto de diferenças nativas legítimas.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] Agent Form cria e reabre perfis Claude e Codex válidos.
- [x] Runtime Config global/workspace comprova inventário, CAS e pending por runtime.
- [x] Fresh/restart/resume preservam projeção; Claude fork usa home distinto e Codex fork permanece indisponível.
- [x] Auth externa, Bridge e capabilities permanecem; ambient state não cruza homes.
- [x] Policies/selectors inválidos falham antes do launch.
- [x] Relatório durável mapeia cada claim para arquivo/teste/dogfood nomeado.

## Non-goals

- Memória runtime-managed, Runtime Config de outros runtimes ou fork artificial no Codex.
- Reabrir diferenças sem evidência contraditória.

## Open questions

Nenhuma; contradições encontradas viram bugs/follow-ups conforme o roadmap.
