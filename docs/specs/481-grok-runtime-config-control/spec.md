# 481 — grok-runtime-config-control

_Created 2026-07-28._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred. -->

## Intent

Control → Runtime Config tem adapters medidos para Codex e Claude. Grok é a segunda
slice do roadmap `t-91df30` e não pode reusar nenhum dos dois contratos: seu documento
global é TOML como o do Codex mas com esquema diferente, seu documento de workspace
**só honra `[mcp_servers]`**, seu enable/disable de MCP é um campo nativo (não o truque de
comentário do Codex) e — decisivo — o config global **não alcança agentes Grok gerenciados**,
porque `materializeBridgeMcpGrok` reescreve o `GROK_HOME` privado a cada spawn.

Esta slice mede o Grok instalado (0.2.112) e entrega inventário e edição segura das fontes
comprovadas, dizendo a verdade sobre a quem cada documento se aplica.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts._

- [x] **Scenario: inventário Grok seguro**
  - **Given** `$GROK_HOME/config.toml`, `<workspace>/.grok/config.toml` e `trusted_folders.toml`
  - **When** Runtime Config inspeciona Grok
  - **Then** exibe apenas escalares medidos, nomes de servidores MCP, nomes de chaves
    desconhecidas e nomes de seções opacas — nunca comandos, env, headers, tokens de
    telemetria, chaves de provider, payloads de hook, memória ou credenciais
- [x] **Scenario: escrita TOML com CAS**
  - **Given** o documento global inventariado
  - **When** o humano salva um escalar medido
  - **Then** as chaves desconhecidas são preservadas, o arquivo é substituído
    atomicamente, e revisão divergente ou TOML inválido falha fechado
- [x] **Scenario: workspace só aceita MCP**
  - **Given** `<workspace>/.grok/config.toml`
  - **When** o documento de workspace é exibido
  - **Then** não oferece escalar editável algum, marca como ignoradas as seções que o
    Grok não lê nesse escopo, e uma tentativa de salvar escalar ali é recusada
- [x] **Scenario: MCP com enable nativo**
  - **Given** um servidor declarado como `[mcp_servers.<n>]`
  - **When** o humano o desabilita
  - **Then** Tachyon grava `enabled = false` no próprio bloco (comportamento nativo medido),
    e um servidor declarado em forma não-patchável aparece read-only
- [x] **Scenario: impacto honesto e pending por escopo**
  - **Given** agentes Grok vivos no workspace
  - **When** o documento global é salvo
  - **Then** nenhum agente é marcado pending (o `GROK_HOME` privado é reescrito no spawn) e
    a UI diz que o documento vale para o Grok fora do Tachyon; ao salvar o documento de
    workspace, os agentes Grok vivos aparecem pending até Start, Restart ou Resume
- [x] **Scenario: trust é leitura**
  - **Given** `trusted_folders.toml` do home Grok
  - **When** o documento de folder trust é exibido
  - **Then** informa se este workspace está confiado (o que decide se `.grok/hooks/` executa)
    e não oferece nenhuma edição
- [x] Codex e Claude permanecem funcionais no mesmo seletor.
- [x] `docs/runtimes/parity.md` registra somente a superfície medida.

## Non-goals

- Editar hooks, skills, plugins, marketplace, sandbox, telemetria, endpoints, providers
  de modelo, permissões/aprovação ou qualquer campo que conceda autoridade.
- Editar `auth.json` ou qualquer credencial; editar ou inventariar `memory/` (track `t-8c7431`).
- Conceder ou revogar folder trust pelo Control.
- Projetar config Grok no perfil canônico (`profileNativeConfig` segue Codex/Claude).

## Open questions

Nenhuma. As dúvidas de formato foram fechadas por medição do binário 0.2.112 e registradas
no journal de `t-ce83a2` e em `notes.md`.
