# 514 — user-apps-zip-install — tasks

_Gerado de `plan.md` em 2026-08-21. De cima para baixo. Se uma tarefa revelar que o plano está errado, corrija `plan.md` antes de seguir._

## Medição primeiro

- [x] **T0 — R1 respondido pela revisão adversarial `t-535eaa`** (`notes.md`). Não existe `callTool` no `WorkspaceClient`; precisa nascer um cliente MCP fino no host, autenticando como `external`. Doze ferramentas exigem `caller.kind === "agent"` e estão nomeadas em `spec.md`.

## Implementação

- [x] **T1** — `packages/engine/src/apps/`: o tipo `InstalledApp` e o leitor que varre `.tachyon/apps/*/app.json`. Diretório ilegível vira aviso na lista de resultado, nunca exceção. Sem cache, sem índice: o disco é a fonte.
- [x] **T2** — validação de `app.json`: `id` (kebab minúsculo), `title`, `icon` (caminho relativo contido), `entry` (caminho relativo contido, arquivo existe). Erro nomeia o campo.
- [x] **T3** — instalação por zip: descompacta em temporário, valida por T2, move para `.tachyon/apps/<id>/` substituindo o que houver. Falha em qualquer ponto não deixa diretório parcial. Aplicar a decisão de R2 sobre contenção de caminho, com o comentário dizendo que é higiene e não barreira.
- [x] **T4** — `SectionId` admite `` `app:${string}` ``. Conferir que o invariante de `sectionNav.ts:118` não é atingido, já que app não é renderizado pelo Control.
- [x] **T5** — as três tabelas concatenam linhas de runtime: `LAUNCHER_ORDER` vira prefixo fixo das doze; `WEBVIEW_APPS` recebe as linhas de app; `controlSectionIcon` desvia para o ícone-imagem quando o id começa com `app:`. Os `throw` do caminho literal ficam; o caminho de runtime avisa.
- [x] **T6** — o ladrilho de app abre a aba pelo `SectionPanelManager` com cardinalidade `dashboard`, servindo o `entry` de `.tachyon/apps/<id>/`.
- [x] **T7** — cliente MCP fino no host principal, autenticando com o `bridge.token` que `extensionOperations.ts:31` já expõe. Ler `pi-bridge-extension/index.ts:101` antes de escrever: já existe um cliente MCP no pacote, e duas formas de falar com o mesmo Bridge é a divergência que esta spec existe para evitar.
- [x] **T7b** — `window.tachyon.call(nome, args)` na página, sobre T7. Sem allowlist. Erro volta para a página e morre lá.
- [x] **T7c** — o contrato de identidade escrito onde o autor de app lê: o app é `external`, e estas doze ferramentas não são dele. Vai no `cookbook.md`.

### As portas que a revisão adversarial achou faltando

- [x] **T14 (achado 2, instalação)** — operação de instalação de app no engine (`runtime-api/extensionOperations.ts`, `engine-service/extensionOperationService.ts`), a mensagem de upload (`webview/plugins/messages.ts:102`) e o seletor de arquivo com staging (`PluginsPanel.ts:84,:324`). Hoje não existe nenhuma dessas; sem elas o usuário não consegue escolher o zip.
- [x] **T15 (achado 2, catálogo)** — projeção do catálogo de apps do engine até as DUAS webviews. `sidebar/messages.ts:24` e `SidebarPrototype.ts:223` não transportam catálogo hoje, e `sectionNav.ts:67` monta `CONTROL_SECTION_NAV` estaticamente dentro do bundle, que não lê `.tachyon/apps`. Inclui atualizar depois de instalar ou remover, sem reload.
- [x] **T16 (achado 3, rota)** — o clique em `app:<id>` hoje cai no System. `App.tsx:2086` manda tudo por `openControl`; `SidebarPrototype.ts:316` chama `isSectionId`, que deriva de `COCKPIT_SECTION_IDS` (`resolveSection.ts:5`) e falha; `extension.ts:3548` cai no fallback. Precisa da porta de rota dinâmica que entrega o app resolvido ao `SectionPanelManager`.
- [x] **T17 (achado 4, persistência)** — `ID_TOKEN` em `launcherOrder.ts:23` admite um dois-pontos. Teste de ida e volta: reordenar com ladrilho de app, recarregar, conferir que a ordem sobreviveu. Sem isso o update otimista de `App.tsx:1674` faz parecer que funcionou.
- [x] **T18 (achado 5, remoção completa)** — os consumidores de `views` que T10/T11 não listavam: `plugins/engine.ts:381,:449,:480,:1117`, o target `kind: "view"` em `lockfile.ts:23,:428,:442,:530`, `plugins/ui/host.ts:335`, consentimento em `PluginsPanel.ts:365,:694`, e as contribuições `openPluginSurface` / `tachyonPluginSurfaces` em `package.json:325,:459` com o wiring em `extension.ts:1678,:3418,:4000`. Parar antes disso deixa erro de compilação ou superfície morta com target de lockfile ainda aceito.
- [x] **T19** — o relay NÃO é apagado em bloco. A revisão mediu que os modos de protótipo do `srcdoc` têm outros consumidores; só o modo `plugin` sai.
- [x] **T8** — ação Adicionar na aba Apps: seletor de arquivo, chamada da instalação, e o que falhou dito na tela.
- [x] **T9** — o relay perde a montagem de `srcdoc` e o `connect-src 'none'` no caminho de app.
- [x] **T10** — `views` sai de `KNOWN_FIELDS` (`manifest.ts:213`) com erro que nomeia o campo removido e aponta o caminho de app. `VIEW_FLEET_SCOPES` sai.
- [x] **T11** — remover `apps/vscode-extension/src/plugins/ui/broker.ts`, `PLUGIN_UI_ACTIONS` e o modo `plugin` de `untrustedSrcdoc.ts`. Os testes que afirmavam esse comportamento saem junto ou viram a asserção nova — nenhum fica silenciado.
- [x] **T12** — `docs/specs/349-plugin-ui-surfaces/spec.md` recebe `**Status:** superseded` apontando para a 514.
- [x] **T13** — remover o plugin `terrarium` da instalação. Era POC, o dono não usa, e nada é migrado. Conferir depois que nenhum plugin instalado declara `views`.

## Verification

- [x] instalar zip válido cria `.tachyon/apps/<id>/` e o ladrilho aparece sem reload
- [x] reinstalar o mesmo id substitui o diretório sem prompt
- [x] zip sem `app.json`, com `app.json` ilegível, ou sem o `entry` declarado: avisa e não deixa diretório parcial
- [x] `app.json` corrompido no disco não impede o startup; o app some do launcher com aviso e o resto sobe
- [x] clicar no ladrilho abre a aba; clicar de novo revela a mesma aba
- [x] `window.tachyon.call("list_agents", {})` devolve à página o mesmo que a ferramenta devolve a um agente
- [x] chamada a ferramenta inexistente volta como erro para a página, sem tela de erro do Tachyon e sem retry
- [x] `loadManifest` recusa um `tachyon-plugin.json` com `views`, nomeando o campo
- [x] `grep` por `PLUGIN_UI_ACTIONS`, `broker`, `VIEW_FLEET_SCOPES`, o modo `plugin` do `srcdoc`, o target `kind: "view"` do lockfile e as contribuições `openPluginSurface` / `tachyonPluginSurfaces` volta zero no código de produção
- [x] reordenar com ladrilho de app, recarregar a janela, e a ordem sobreviveu (achado 4 — o update otimista mascara a falha)
- [x] um app alcança `spawn_agent` e `kill_agent`; as doze ferramentas agent-only recusam com a mensagem que nomeia a razão
- [x] a ordem de produto das doze embutidas não mudou, e arrastar continua funcionando com ladrilho de app na grade

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood-Opt-Out:** o caminho ponta a ponta é upload de arquivo por diálogo do VS Code seguido de clique em ladrilho e render de webview; não há comando headless que exercite essa sequência sem simular o próprio diálogo, o que provaria o simulador e não o produto. A prova é o dogfood humano abaixo mais os testes de T1–T3, que cobrem a instalação sem a tela.

**Human dogfood:**

1. Empacotar um app mínimo (`app.json`, `index.html` que chama `list_agents`, um ícone) num zip.
2. Aba Apps → Adicionar → escolher o zip.
3. Conferir o ladrilho novo, abrir, ver a lista de agentes renderizada pela página.
4. Subir de novo o mesmo zip com o `title` mudado e conferir que o ladrilho reflete a mudança.
5. Corromper o `app.json` à mão, recarregar a janela, e conferir que o Tachyon sobe com os outros ladrilhos.
6. Conferir que o `terrarium` sumiu da lista de plugins e que nenhum plugin instalado declara `views`.

## Visual QA

Superfície: a grade do launcher, que passa a misturar codicon monocromático (as doze embutidas) com imagem colorida (os apps); e a aba Apps, que ganha a ação Adicionar.

Risco visual: tamanho e alinhamento óptico do ícone-imagem contra os codicons, e o comportamento no tema claro. Grade estreita com muitos apps.

- [x] Evidence:
- [x] Verdict:

## Cookbook

**Cookbook:** yes
<!-- superfície de operador nova: como empacotar um app (app.json, entry, ícone), como instalar,
     e o que `window.tachyon.call` alcança. Escrever no ship, com sdd-cookbook.sh 514. -->

## Fecho (2026-08-23)

Entregue. Desvios do plano, com o porquê:

- **T6 não usa o `SectionPanelManager`.** Aquela classe é construída sobre uma linha do manifesto de
  apps, renderiza um bundle do build e recusa linha que não declare `host: "section"`. Um app
  instalado não tem nenhuma das três coisas. `UserAppPanels` faz o mesmo trabalho de cardinalidade
  (um painel por app, reabrir revela) sem dar ao gerente de seção um segundo modo sem manifesto —
  que é a deriva que o `throw` dele existe para impedir.
- **T7 não precisou de decisão nova.** O cliente MCP fino nasceu como `userAppBridgeCaller`, com o
  `bridge.token` que o engine já expõe, uma conexão por workspace, derrubada quando falha.
- **T9 foi mais longe que o texto.** O relay inteiro saiu, não só o `srcdoc`: com o host de
  superfícies removido, o bundle `plugin-host` não tinha consumidor. Os dois modos de protótipo do
  `untrustedSrcdoc` ficaram, que era o ponto do T19.
- **Três guardas do repositório pegaram coisa real** e nenhuma foi silenciada: o botão "Add app"
  dentro da grade virava um décimo-terceiro destino; `posture: "replace"` ganhou seu primeiro
  usuário (e as regras de bundle preact e `acquireVsCodeApi` passaram a excetuá-lo); e o serializer
  do app é dispose-only, porque entre uma janela e outra o app pode ter sido reinstalado ou removido.
- **Os dois ids `tachyonPluginSurface*` FICAM** no laço dispose-only, mesmo com a capacidade morta:
  uma aba aberta durante a atualização ainda precisa ser descartada em vez de revivida em nada.
- **T13 não teve o que fazer**: o terrarium não estava instalado (resíduo do incidente de 21/08, não
  desta task). O código que aceitava `views` é que estava intacto, e saiu.

## Slice F — o armazenamento da página, medido (2026-08-23)

A única afirmação que tinha ficado sem medição na 514. Medida contra a orientação do próprio VS Code
(`code.visualstudio.com/api/extension-guides/webview` + as notas que dizem *"All instances of a webview
will now run on the same origin ... be sure to partition any data/state that is document specific per
resource"*), e a resposta trouxe dois fatos que não estavam na spec:

1. **Todo app compartilha UMA origem.** Toda aba de app é criada sob o mesmo `viewType`
   (`tachyonUserApp`) — e tem que ser, porque o VS Code não registra serializer para um tipo que ele só
   conhece depois da ativação. Origem compartilhada significa `localStorage` compartilhado: um app lia
   e sobrescrevia o dado de outro.
2. **O uninstall não conseguia limpar nada.** Nenhuma API entrega o armazenamento de uma webview a uma
   extensão, então o diretório sumia e o que a página tinha escrito ficava, invisível e sem dono.

**O que foi feito:** o shim passou a dar a cada app o seu próprio prefixo (`tachyon.app.<id>.`) em
`localStorage` e `sessionStorage`. Isso torna o dado *identificável*, e identificável é o que o torna
removível — uma página da mesma origem pode apagar o prefixo de outra, então toda página de app varre,
ao carregar, os prefixos de apps que não estão mais instalados.

**O limite, dito na confirmação em vez de implícito:** o dado de um app sai na próxima vez que
QUALQUER app abrir, não no instante do uninstall. Nada nosso roda naquela origem enquanto nenhuma aba
de app está aberta, e abrir uma aba escondida só para varrer piscaria um painel na cara do humano por
uma tarefa doméstica. Um app determinado também ainda alcança o store cru por trás do namespace: isto
particiona por convenção aplicada no shim, e um app instalado já era confiável por definição.
