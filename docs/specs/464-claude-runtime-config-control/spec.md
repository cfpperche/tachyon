# 464 — claude-runtime-config-control

_Created 2026-07-26._

**Status:** shipped
**Closure:** Shipped Claude's measured Runtime Config adapter with per-document CAS,
safe scalar JSON writes, local-shadow detection, read-only MCP inventory, runtime-scoped
pending, explicit unavailable state and functional Dev Host evidence in
`.tachyon/dev-host/interactive-out/result.json` (`ok: true`, 2026-07-26).
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Control → Runtime Config conhece somente o documento TOML do Codex. Claude possui
fontes JSON com layouts e precedências diferentes: settings global e workspace,
override local e MCP workspace em arquivo separado. Forçar esse conjunto ao formato
Codex criaria uma fonte composta fictícia e CAS enganoso.

Esta slice adiciona inventário e edição medidos para Claude Code, mantendo cada
documento versionado separadamente, ocultando payloads executáveis/sensíveis e
informando quando um override local impede a mudança de ser efetiva.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: inventário Claude seguro**
  - **Given** settings global/workspace, override local e MCP workspace
  - **When** Runtime Config inspeciona Claude
  - **Then** exibe somente escalares medidos, nomes MCP, nomes de chaves desconhecidas e resumos opacos, sem valores sensíveis ou comandos
- [x] **Scenario: edição JSON com CAS**
  - **Given** um documento settings inventariado
  - **When** o humano salva escalares suportados
  - **Then** chaves desconhecidas são preservadas, o arquivo é substituído atomicamente e conflito/parse inválido falha fechado
- [x] **Scenario: override local**
  - **Given** uma chave também presente em `.claude/settings.local.json`
  - **When** o settings workspace é exibido
  - **Then** a chave é marcada como sombreada e não pode ser editada pelo Control
- [x] **Scenario: lifecycle pending**
  - **Given** um Claude canônico vivo que seleciona a fonte alterada
  - **When** a mudança é salva
  - **Then** o agente aparece pending até Start, Restart ou Resume rematerializar a configuração
- [x] Codex permanece funcional no mesmo seletor de runtime.
- [x] `docs/runtimes/parity.md` registra somente a superfície medida.

## Non-goals

- Edição de permissions, hooks, statusLine, prompts, memória, auth ou payloads MCP.
- Tratar `settings.local.json` como fonte autorável.
- Policy canônica Claude e autoria no Agent Form (`t-fdd3a0`, `t-36b7f0`).

## Open questions

Nenhuma. A revisão adversarial `probe-fab094ec-923f-4323-8713-927719e8484c`
confirmou que os documentos precisam de versões independentes.
