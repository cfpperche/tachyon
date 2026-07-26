# 464 — claude-runtime-config-control — plan

_Drafted from `spec.md` on 2026-07-26. The approach, not the steps (those go in `tasks.md`)._

## Approach

1. Introduzir envelope Runtime Config com variantes por runtime e documentos independentes.
2. Manter o adapter Codex compatível e projetá-lo no envelope comum.
3. Implementar inspector Claude para settings global/workspace e MCP workspace, lendo
   `settings.local.json` apenas para detectar nomes sombreadores.
4. Implementar mutation JSON estritamente para escalares medidos, com CAS, arquivo
   regular, escrita atômica e preservação estrutural de desconhecidos.
5. Generalizar mensagens/serviço/UI para seleção de runtime e documento.
6. Generalizar pending por runtime/source e provar Codex + Claude.
7. Fazer dogfood visual no Control e atualizar paridade.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Documento é a unidade de CAS** — Claude separa settings e MCP; rejeitada fonte composta.
- **Payloads executáveis são opacos** — hooks/statusLine/MCP podem conter comandos ou segredos.
- **`settings.local.json` só informa shadowing** — é override local, não fonte autorável.
- **MCP Claude é read-only nesta slice** — não há disable reversível nativo medido em JSON.
- **Escalares apenas** — permissions aninhadas pertencem à policy canônica seguinte.

## Files touched

- `src/runtimeConfig/*` — tipos comuns e inventory Claude.
- `src/runtimeConfig/claudeInventory.ts` — mutation JSON medida no mesmo limite do inspector.
- `src/extension.ts`, `src/workspace/Workspace.ts` — serviço e pending.
- `src/webview/{Cockpit.ts,runtime-config/messages.ts,cockpit/*}` — selector/editor.
- testes unitários/browser e `docs/runtimes/parity.md`.

## Risks & unknowns

- Vazamento de comandos em DTO: regressão serializa snapshot e procura sentinelas.
- Write sem efeito por override: chave sombreada não é editável.
- Regressão Codex no refactor: suite existente permanece integral.
- Arquivo ausente concorrente: CAS distingue expectativa ausente de revision existente.
- Dev Host precisa copiar `.claude`/`.mcp.json` e compartilhar o profile-home entre
  F5/headless para que dogfood nunca siga symlinks nem alcance configuração ambiente.

## Visual impact

Runtime Config ganha seletor Codex/Claude e seletor de documento. Inspecionar no Dev
Host largura, labels, estados read-only/shadowed, troca de runtime e pending.

## Sources consulted

- `src/runtimeConfig/codexInventory.ts`
- `src/config/{codex,claude}NativeConfigProjection.ts`
- `src/webview/cockpit/App.tsx`
- `docs/specs/446-runtime-config-control`
- `docs/specs/460-claude-native-config-inheritance`
- `.tachyon/probes/probe-fab094ec-923f-4323-8713-927719e8484c/result.json`
