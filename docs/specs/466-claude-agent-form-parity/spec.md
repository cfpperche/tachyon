# 466 — claude-agent-form-parity

_Created 2026-07-26._

**Status:** shipped
**Closure:** Shipped Claude New/Edit authoring for measured selectors and
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
**Dogfood:** `npx vitest run test/unit/agentProfileStudio.test.ts test/unit/agentStudioDomain.test.ts`
native-config sources, host-side fail-closed validation, readiness reconciliation
and a disposable Dev Host create/edit scenario; focused dogfood and both gates
passed on 2026-07-26.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Permitir criar e editar um agente Claude canônico pelo Agent Form com a mesma
fidelidade do contrato já aceito pelo backend: selectors medidos, famílias
native-config global/workspace, lifecycle e tooling autorizado. A forma deve
derivar os tuples do support resolver, esconder campos não suportados e gravar
um perfil que já passa na validação canônica sem edição manual do YAML.

## Acceptance criteria

- [x] **Scenario: criar Claude canônico**
  - **Given** o formulário de novo agente com runtime Claude
  - **When** o humano escolhe model/effort e fontes escalares válidas
  - **Then** a mutation contém selectors e policies Claude exatos, sem provider/service tier
- [x] **Scenario: editar sem drift**
  - **Given** um perfil Claude salvo com policy e tooling autorizados
  - **When** ele é aberto e salvo sem trocar escolhas
  - **Then** runtime, nativeConfig, lifecycle, worktree, Soul e capabilities preservam round-trip
- [x] **Scenario: superfície fail-closed**
  - **Given** um runtime ou valor não suportado
  - **When** o formulário serializa ou o host valida a mutation
  - **Then** campos incompatíveis são escondidos/limpos e tuples inválidos são recusados antes da escrita
- [x] Strings novas usam localização e a UI explica diferenças legítimas Claude/Codex.
- [x] Dev Host funcional e visual comprova criação Claude sem edição manual.

## Non-goals

- Runtime Config de outros runtimes, memória runtime-managed ou novos grants.
- Tornar provider/service tier autoráveis no Claude sem medição.
- Igualar artificialmente fork Codex ou mecanismos nativos inexistentes.

## Open questions

Nenhuma; a policy medida na SDD 465 fecha os campos suportados.
