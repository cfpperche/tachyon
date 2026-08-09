# 463 — claude-canonical-private-fork

_Created 2026-07-26._

**Status:** shipped
**Closure:** `t-088454` entrega fork Claude canônico com home privado novo, projeções
copiadas, seed cross-home/cwd, compensação de falha e evidência automatizada.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`

## Intent

O fork nativo de um Claude canônico hoje abandona o `CLAUDE_CONFIG_DIR` privado e as
projeções capturadas do perfil. A semeadura do transcript também consulta o home
global, embora a sessão de origem viva no namespace privado do agente.

Esta entrega faz o fork vivo rematerializar um home privado próprio a partir do
snapshot de projeções da origem e semear o transcript entre os homes exatos de origem
e destino antes de iniciar o processo.

## Acceptance criteria

- [x] **Scenario: fork canônico no mesmo checkout**
  - **Given** um Claude canônico vivo com transcript em seu home privado
  - **When** seu fork é confirmado
  - **Then** o destino recebe outro home privado, a mesma projeção nativa/capacidades e o transcript é semeado entre namespaces
- [x] **Scenario: fork canônico para outro worktree**
  - **Given** um Claude canônico vivo em worktree
  - **When** seu fork cria outro worktree
  - **Then** o seed usa home/cwd distintos e exatos para fonte e destino
- [x] **Scenario: falha fechada**
  - **Given** que a projeção ou o transcript não pode ser materializado/semeado
  - **When** o fork é tentado
  - **Then** nenhuma sessão sem contexto é mantida e o home criado é limpo quando seguro
- [x] A matriz de paridade registra evidência do fork Claude canônico.

## Non-goals

- Rename de agentes.
- Paridade de fork para outros runtimes.
- Persistência de um novo formato de snapshot para relançar o fork após reload do host.

## Open questions

Nenhuma.
