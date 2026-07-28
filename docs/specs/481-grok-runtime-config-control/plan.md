# 481 — grok-runtime-config-control — plan

_Drafted from `spec.md` on 2026-07-28. The approach, not the steps (those go in `tasks.md`)._

## Approach

1. Estender o envelope comum com o mínimo que Grok exige de verdade: runtime `grok`,
   `inputKind: "number"`, motivo de read-only e uma frase de impacto por documento.
2. Implementar `src/runtimeConfig/grokInventory.ts` com inspector e mutation no mesmo
   limite: escalares medidos só no documento global, MCP nos dois, trust read-only.
3. Reusar o padrão de escrita já provado (lock `wx`, CAS por digest do texto, patch de
   linha, temp + rename), sem reusar o esquema TOML do Codex.
4. Ligar serviço/extension/pending com a regra medida de impacto por escopo.
5. Cobrir com testes de segurança, conflito, escopo, MCP nativo e regressão Codex/Claude.
6. Dogfood contra o binário instalado, cobertura de UI em Chrome headless (sem VS Code) e
   atualizar `docs/runtimes/parity.md`.

## Key decisions

_Each decision + why this option over the alternatives considered._

- **Alcance é por documento, não por runtime** — o workspace chega ao agente pelo cwd mesmo
  sob `GROK_HOME` privado; o global depende de o agente ter perfil canônico. A primeira
  versão desta decisão dizia "o global não marca ninguém", medido quando todo agente Grok
  subia Bridge-only; `t-26f508` landou no meio da slice e passou a projetar famílias de
  `~/.grok/config.toml`, então a regra foi corrigida no merge em vez de deixada em drift.
  Rejeitado: manter uma frase medida que o produto já tinha superado.
- **Workspace não expõe escalar** — o README versionado 0.2.112 e o layering medido dizem
  que só `[mcp_servers]` é lido em escopo de projeto. Oferecer `models.default` ali seria
  um editor que grava e não faz efeito. Rejeitado: expor com aviso.
- **MCP usa o `enabled` nativo** — medido: `enabled = false` remove o servidor do
  `grok inspect`. Rejeitado: portar o marcador de comentário do Codex, que existe só
  porque o Codex não tem esse campo.
- **Trust é read-only** — conceder trust habilita execução de `.grok/hooks/`; é autoridade,
  não preferência. Rejeitado: checkbox de trust no Control.
- **Permissão/aprovação nunca é editável** — `features.support_permission`,
  `ui.permission_mode`, `ui.yolo` e afins aparecem como read-only *quando já configurados*,
  com motivo explícito. Rejeitado: esconder (o humano perde a leitura do risco) e
  rejeitado: editar (Control passaria a conceder autoridade).
- **CAS estrita por digest do texto** — diferente do Codex, que ignora `hooks.state`. O
  Grok reescreve o próprio `config.toml` (persistência de settings da TUI, marketplace),
  então qualquer divergência deve virar conflito e recarga, não sobrescrita silenciosa.
- **`grok inspect` não é fonte de proveniência** — medido: atribui `source.path` do config
  global a servidores declarados no projeto. O adapter lê os arquivos diretamente.

## Files touched

- `src/runtimeConfig/types.ts` — runtime `grok`, `inputKind: "number"`, `readOnlyReason`, `impact`.
- `src/runtimeConfig/grokInventory.ts` — inspector + mutation medidos (novo).
- `src/extension.ts` — snapshot, save e escopo por documento.
- `src/workspace/Workspace.ts`, `src/runtime-api/extensionOperations.ts` — pending Grok.
- `src/webview/{Cockpit.ts,cockpit/messages.ts,cockpit/App.tsx}` — labels, número, impacto.
- `test/unit/grokRuntimeConfigInventory.test.ts`, `test/browser/grokRuntimeConfigView.test.ts`.
- `docs/runtimes/parity.md`.

## Risks & unknowns

- Vazamento de payload no DTO: regressão serializa o snapshot inteiro e procura sentinelas.
- Patch TOML em tabela aninhada (`[mcp_servers.<n>]`): formas não-patcháveis (inline table,
  dotted key) precisam cair para read-only em vez de gravar errado.
- Home Grok em Dev Host: o inventário precisa respeitar o profile-home e não escapar para
  `~/.grok` via `GROK_HOME` herdado.
- Números: valor fora de faixa ou não-inteiro precisa ser recusado antes da escrita.

## Visual impact

Runtime Config ganha a opção Grok (logo PNG já existente), três documentos, campos
numéricos, motivo de read-only e a frase de impacto por documento. Verificado em Chrome
headless sobre o bundle publicado: agentes não abrem VS Code nem Dev Host neste projeto.

## Sources consulted

- `grok 0.2.112` instalado: `grok inspect --json`, `grok --help`, strings do binário,
  `~/.grok/README.md` (documentação versionada da própria release), `~/.grok/config.toml`.
- `src/harness/HarnessManager.ts` (`materializeBridgeMcpGrok`, `defaultRealGrokHome`).
- `src/runtimeConfig/{codexInventory,claudeInventory}.ts`, SDD 446 e 464.
- `docs/research/adhoc-runtime-parity-grok.md`, `docs/runtimes/parity.md`.
