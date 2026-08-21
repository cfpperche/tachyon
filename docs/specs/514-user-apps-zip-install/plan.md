# 514 — user-apps-zip-install — plan

_Drafted from `spec.md` on 2026-08-21. A abordagem, não os passos (esses vão em `tasks.md`)._

## Approach

Cinco movimentos. Os quatro primeiros são adição pequena; o quinto é subtração.

**1. Ler o catálogo do disco.** Um leitor novo varre `.tachyon/apps/*/app.json` e devolve as linhas de app válidas. Diretório ilegível é omitido com aviso, nunca com exceção. É a única fonte da verdade sobre quais apps existem — não há lockfile, não há índice, não há cache que possa divergir do disco.

**2. Abrir as três tabelas literais.** Hoje o catálogo de tela é fixado em compilação em três lugares que se checam mutuamente. Cada um ganha as linhas de runtime concatenadas às literais, e cada um troca o `throw` por aviso no caminho de runtime — mantendo o `throw` no caminho literal, onde ele pega erro de digitação no boot.

**3. Ladrilho e aba.** Um ladrilho de app abre uma aba do editor pelo `SectionPanelManager`, com cardinalidade `dashboard` (um painel por projeto; reabrir revela). O ícone é um `<img>` do arquivo que o app trouxe, não um codicon.

**4. Porta de zip na aba Apps.** Ação Adicionar → seletor de arquivo do VS Code → descompacta em diretório temporário → valida `app.json` e a existência do `entry` → move para `.tachyon/apps/<id>/`, substituindo o que houver. Falha em qualquer etapa não deixa diretório parcial.

**5. Tirar a tela do plugin.** `views` sai do `KNOWN_FIELDS`, o broker de ações sai, o modo `plugin` do `srcdoc` sai, `VIEW_FLEET_SCOPES` sai. O `terrarium` é **removido**, não migrado — o dono confirmou que era POC e não o usa. O spec 349 vira `superseded`. Nenhum caminho de compatibilidade: zero consumidores vivos.

## Key decisions

- **O ladrilho de um app se chama `app:<id>`, E o `ID_TOKEN` da ordem persistida se alarga para admitir um dois-pontos** — escolhido porque o prefixo torna colisão com seção embutida impossível por construção. Rejeitado validar o id na instalação: uma regra que alguém esquece de aplicar num segundo caminho de entrada, e cujo modo de falha é sombrear um ladrilho que o produto precisa (`settings`, `plugins`) sem que nada avise.

  **Correção da revisão adversarial (achado 4):** a primeira versão deste plano parou no prefixo e não conferiu quem valida o id depois. `packages/webview-ui/src/sidebar/launcherOrder.ts:23` define `ID_TOKEN = /^[a-z][a-z0-9-]*$/` e `isPersistedLauncherMode` rejeita qualquer ordem customizada com token fora dele — dois-pontos é inválido. Como `App.tsx:1674` faz update otimista, a ordem pareceria correta na sessão e não sobreviveria ao reload. Corrigido alargando o token para `/^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)?$/`. Rejeitado trocar para `app-<id>`: caberia no regex atual, mas devolveria a colisão ao terreno da convenção de nome, que é o que o prefixo existia para eliminar.

- **`SectionId` se alarga para incluir `` `app:${string}` `` em vez de nascer uma lista paralela de ladrilhos** — escolhido porque a máquina de ladrilho já existe inteira e passa a servir os dois: a reordenação por arrastar e por teclado, o memento `custom:id,id,…`, o descarte de órfão, o ícone. Rejeitada a lista paralela porque duplicaria a grade do launcher e criaria duas ordens que divergem.

- **Linha vinda do disco avisa; linha literal continua lançando** — escolhido porque os três `throw` de hoje (`sectionNav.ts:92`, `:112`, `:119`) existem para pegar erro de digitação no boot, e isso continua valendo para as doze embutidas. Conteúdo de disco não pode derrubar a extensão: é a regra do produto — config inválida avisa, nunca bloqueia. Rejeitado remover os `throw`: perderia a rede que protege as doze.

- **O relay fica; o broker sai** — escolhido porque o que o spec 349 construiu se divide em duas metades. O relay (`packages/webview-ui/src/webview/plugin-host/relay.ts`) transporta mensagem, e isso é útil. O broker (`apps/vscode-extension/src/plugins/ui/broker.ts`), a allowlist `PLUGIN_UI_ACTIONS`, o `connect-src 'none'` e o `srcdoc` são restrição, e restrição é exatamente o que esta spec dispensa. Rejeitado manter o broker desligado por flag: caminho morto se remove, não se mantém.

- **Extração de zip própria, não o motor de instalação de plugin** — escolhido porque o motor carrega source-spec de git, pin de tag, checksum, lockfile, fingerprint, consentimento e reconciliação de runtime, e todos são non-goal aqui. Rejeitado reusá-lo porque adaptá-lo custaria mais que descompactar um zip, e arrastaria conceitos que o usuário não pediu.

- **Reinstalar por cima é a porta de update** — escolhido porque é o comportamento mais simples que responde "como atualizo um app" sem inventar tela, versão ou confirmação. Rejeitado recusar id existente: obrigaria uma porta de desinstalar que é non-goal do MVP.

- **Ícone do app é imagem; os doze embutidos continuam codicon** — decisão do dono. A consequência de desenho é boa e é deliberada: ladrilho monocromático que herda a cor do tema é do Tachyon, ladrilho colorido é instalado. É a mesma leitura da tela de conectores do claude.ai, onde os logos são coloridos numa lista de itens do sistema.

## Files touched

**Novo**

| caminho | o quê |
|---|---|
| `packages/engine/src/apps/` | leitor de `.tachyon/apps/*/app.json`; o tipo `InstalledApp`; a validação; a instalação por zip |
| `docs/specs/514-user-apps-zip-install/` | esta spec |

**Alterado**

| caminho | o quê |
|---|---|
| `packages/webview-ui/src/sections/model.ts:29` | `SectionId` passa a admitir `` `app:${string}` `` |
| `packages/webview-ui/src/webview/sidebar/sectionNav.ts:67` | `LAUNCHER_ORDER` deixa de ser o catálogo único; as doze viram o prefixo fixo |
| `packages/webview-ui/src/webview/sidebar/sectionNav.ts:92,:112,:119` | os três `throw` ganham o caminho de runtime que avisa |
| `apps/vscode-extension/src/webview/webviewApps.ts` | `WEBVIEW_APPS` ganha as linhas de app do disco |
| `apps/vscode-extension/src/webview/shared/SectionPanelManager.ts` | abre um painel cujo HTML vem de `.tachyon/apps/<id>/` |
| `packages/webview-ui/src/webview/plugins/App.tsx` | a ação Adicionar na aba Apps |
| `packages/webview-ui/src/webview/plugin-host/relay.ts` | perde o `srcdoc` e a allowlist; ganha `window.tachyon.call` |
| `packages/engine/src/plugins/manifest.ts:213` | `views` sai de `KNOWN_FIELDS`; `:192` `VIEW_FLEET_SCOPES` sai |
| `packages/webview-ui/src/sidebar/launcherOrder.ts:23` | `ID_TOKEN` admite um dois-pontos (achado 4) |

**Portas que a primeira versão do plano omitiu — todas da revisão adversarial**

| caminho | o quê | achado |
|---|---|---|
| `packages/engine/src/runtime-api/extensionOperations.ts` | operação de instalação de app no engine; hoje não existe nenhuma | 2 |
| `packages/engine/src/engine-service/extensionOperationService.ts` | idem, o lado do serviço | 2 |
| `packages/webview-ui/src/webview/plugins/messages.ts:102` | mensagem de upload; hoje só há ações de plugin | 2 |
| `apps/vscode-extension/src/webview/PluginsPanel.ts:84,:324` | seletor de arquivo e staging do zip | 2 |
| `packages/webview-ui/src/webview/sidebar/messages.ts:24` | transporte do catálogo de apps até a sidebar | 2 |
| `apps/vscode-extension/src/webview/SidebarPrototype.ts:223,:316` | projeção do catálogo, e a porta de rota que hoje barra o id | 2, 3 |
| `apps/vscode-extension/src/sections/resolveSection.ts:5` | `isSectionId` deriva de `COCKPIT_SECTION_IDS` e rejeita `app:<id>` | 3 |
| `apps/vscode-extension/src/extension.ts:3548` | o comando `openControl` cai no System quando a seção não resolve | 3 |
| `apps/vscode-extension/src/plugins/engine.ts:381,:449,:480,:1117` | consumidores de `views` na instalação | 5 |
| `packages/engine/src/plugins/lockfile.ts:23,:428,:442,:530` | o target `kind: "view"` | 5 |
| `apps/vscode-extension/src/plugins/ui/host.ts:335` | leitura de `views` | 5 |
| `apps/vscode-extension/src/webview/PluginsPanel.ts:365,:694` | consentimento e abertura de superfície de plugin | 5 |
| `apps/vscode-extension/package.json:325,:459` | contribuições `openPluginSurface` e `tachyonPluginSurfaces` | 5 |

**Removido**

| caminho | por quê |
|---|---|
| `apps/vscode-extension/src/plugins/ui/broker.ts` | a allowlist de uma ação que a spec dispensa |
| o modo `plugin` de `packages/shared/src/webview/shared/untrustedSrcdoc.ts` | último consumidor sai junto |
| `docs/specs/349-plugin-ui-surfaces/` | vira `superseded`, não é apagada |

## Risks & unknowns

**R1 — RESPONDIDO pela revisão adversarial. O Bridge não roda no extension host, e o chamador que existe é `external`.**

Medido: `WorkspaceClient.ts:67-91` expõe operações do engine e `bridgeUrl`, mas **não** `callTool`. Não é preciso inventar protocolo — o engine já expõe `bridge.token` (`extensionOperations.ts:31-44`) e o pacote da extensão já depende do SDK MCP, com um cliente separado em `pi-bridge-extension/index.ts:101`. **Precisa nascer um cliente MCP fino no host principal.**

Esse cliente autentica como `external` (`callerIdentity.ts:318`). Consequência medida: `lifecycleScopeGuard` só escopa agentes (`lifecycleScope.ts:17`), então um token externo alcança `spawn_agent`, `kill_agent`, board, worktree, tmux e browser — inclusive encerrar um agente qualquer, o que `test/unit/auth.test.ts:284` cobre. Doze ferramentas resistem porque exigem `caller.kind === "agent"`; estão nomeadas em `spec.md`, e onze delas têm um agente por sujeito. A décima segunda, `run_host_action`, é a única perda de capacidade real e virou pergunta aberta para o dono.

**Risco residual:** o cliente MCP no host é peça nova e não medida em produção. É a primeira tarefa.

**R1b — o registro histórico do que este plano dizia antes.**

Medido: `packages/bridge/src/Bridge.ts:464` constrói o `McpServer`, e `packages/bridge/src/daemonMain.ts` é um entrypoint com `require.main === module` — o Bridge vive no **daemon do engine**, um processo separado, alcançado pelo `workspaceBridgePort`. O extension host não tem as ferramentas em escopo.

Então `window.tachyon.call()` atravessa três saltos: webview → extension host → daemon do engine → ferramenta do Bridge. **Isso não está desenhado.** Duas perguntas concretas precisam de resposta medida antes de qualquer código:

1. **Qual identidade o app apresenta?** `createMcp` recebe um `caller` (`BridgeDeps["caller"]`), há `callerRegistry` e `callerScope`, e o `lifecycleScopeGuard` em `fleet.ts` recusa alvo fora da linhagem do chamador. Um app não é agente e não tem linhagem. Ferramentas como `kill_agent` e `notify_agent` derivam comportamento dessa identidade. Ou o app ganha uma identidade de chamador própria, ou algumas ferramentas se comportam de um jeito que ninguém desenhou.
2. **Existe uma porta não-MCP para as ferramentas, ou o app fala MCP?** Se o extension host já tem um cliente do workspace bridge, o app pluga nele. Se não, o salto tem que nascer.

**Resolver R1 é a primeira tarefa, e é medição, não implementação.** Se a resposta for que não existe caminho barato, a spec muda — não o código.

**R2 — DECIDIDO: conter, e dizer no código que é higiene e não barreira.** A revisão apontou (achado 6) que deixar isso em aberto tornava T3 não-determinística: duas implementações conformes ao plano aceitariam zips diferentes. Decisão minha, revertível numa frase pelo dono. O raciocínio original fica abaixo.



Uma entrada de zip com `../` escreve fora de `.tachyon/apps/<id>/`. Custa poucas linhas conter. Mas o app, uma vez instalado, tem acesso irrestrito ao Bridge e portanto ao disco de qualquer forma — então conter na extração compra arrumação, não proteção. Registro como decisão explícita em vez de resolver sozinho: **conter, e dizer no código que é higiene e não barreira**, é a recomendação. O dono decide.

**R3 — alargar `SectionId` reverbera.** É um union usado na decodificação de rota, no memento de ordenação e no invariante de startup em `sectionNav.ts:118` ("toda seção que o Control renderiza tem ladrilho"). Apps não são renderizados pelo Control — abrem como aba standalone — então esse invariante não deve ser tocado. Verificar isso cedo; se estiver errado, o desenho do ladrilho muda.

**R4 — apagar a maquinaria do 349 derruba testes que a afirmam.** Existem ao menos `test/unit/pluginHostRelay.test.ts` e as asserções de CSP. Eles não devem ser silenciados: devem sair junto com o que afirmavam, ou virar a asserção nova.

**R5 — RESOLVIDO, e para menos trabalho.** A primeira versão deste plano tratava o Terrarium como migração obrigatória, com um repositório externo a reempacotar antes de a aceitação poder ser marcada. O dono confirmou em 2026-08-21 que é POC que ficou e que ele não usa. Some o repositório externo do caminho crítico, some o zip a produzir, e some qualquer compatibilidade: `views` sai sem sucessor. **O risco virou economia.**

**R5b — o primeiro app real ainda não existe.** Sem o Terrarium como caso de migração, nada exercita o caminho ponta a ponta além de um app mínimo de teste. O dogfood humano precisa de um app de verdade para valer alguma coisa; empacotar um é trabalho que ninguém fez ainda.

## Visual impact

O launcher ganha ladrilhos que não existiam e mistura dois tipos de ícone na mesma grade: codicon monocromático nas doze embutidas, imagem colorida nos apps. Isso é deliberado (ver decisão), mas é a coisa mais provável de ficar feia: tamanho, alinhamento óptico e comportamento no tema claro.

A aba Apps ganha uma ação Adicionar que hoje não existe naquela tela.

Prova exigida antes da entrega: captura do launcher com pelo menos um app instalado, nos dois temas, na largura de sidebar aberta e estreita.

## Sources consulted

- `apps/vscode-extension/src/webview/webviewApps.ts` — o registro de app embutido, `{view, viewId, section, host, cardinality}` e as três cardinalidades
- `packages/webview-ui/src/webview/sidebar/sectionNav.ts` — `LAUNCHER_ORDER`, `STANDALONE_APPS`, `controlSectionIcon` e os três `throw`
- `packages/engine/src/plugins/manifest.ts` — `KNOWN_FIELDS`, `VIEW_FLEET_SCOPES`, a validação de `views`
- `apps/vscode-extension/src/plugins/ui/broker.ts` — `PLUGIN_UI_ACTIONS`
- `packages/webview-ui/src/webview/plugin-host/relay.ts` — o transporte e a montagem de `srcdoc`
- `packages/bridge/src/Bridge.ts:464`, `packages/bridge/src/daemonMain.ts` — onde o Bridge realmente roda
- `docs/specs/349-plugin-ui-surfaces/` — o que está sendo substituído
- Medição de 2026-08-21: zero dos 17 pacotes de `cfpperche/tachyon-plugins` declara `views`; o único instalado é `terrarium`
- `.gitignore:16` — `.tachyon/` já é ignorado
