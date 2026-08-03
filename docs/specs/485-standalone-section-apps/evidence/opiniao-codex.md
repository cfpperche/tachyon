# Opinião Codex — perguntas abertas da SDD 485

_Consulta de desenho, 2026-08-02. Nenhum código foi alterado._

## 1. Host panel manager

### Recomendação

Criar **um `SectionPanelManager` genérico, configurado por uma entrada de superfície**, e instanciar/registrar essa configuração por app. O manager deve manter os painéis em um `Map` cuja chave inclua `viewId + workspace + identidade da rota/documento`; dashboards podem declarar cardinalidade singleton por escopo, enquanto task detail e outras telas de entidade declaram cardinalidade por identidade. Não criar doze classes de manager.

### Argumento

O repositório já provou exatamente essa separação entre mecanismo e dialeto. `StudioPanelManagerBase` recebe uma configuração declarativa de superfície (`viewType`, bundle, CSS, CSP, roots e ícone) em `src/webview/shared/studio/StudioPanelManagerBase.ts:31`, recebe config + adapter no construtor em `src/webview/shared/studio/StudioPanelManagerBase.ts:76`, e centraliza cardinalidade/reveal em um `Map` e numa chave composta em `src/webview/shared/studio/StudioPanelManagerBase.ts:77` e `src/webview/shared/studio/StudioPanelManagerBase.ts:135`. Ele também centraliza a criação pelo shell compartilhado e o estado mínimo persistido em `src/webview/shared/studio/StudioPanelManagerBase.ts:153` e `src/webview/shared/studio/StudioPanelManagerBase.ts:166`. Isso é evidência de que a diferença entre apps cabe em dados/adapters; não exige uma classe por app.

O contrato de conformidade também precisa de uma autoridade declarativa. `WEBVIEW_SURFACES` já é a fonte canônica (`src/webview/surfaces.ts:1`) e descreve `viewId`, bundle/mount e host (`src/webview/surfaces.ts:19`). Colocar nela (ou em um subobjeto tipado referenciado por ela) postura de shell, extensão usada, cardinalidade e identidade permite que o mesmo registro governe manager, build e teste. O guard existente já exige `main.tsx` e entrypoint para cada superfície convertida (`test/unit/webviewConvention.test.ts:23`) e cobre novos `createWebviewPanel` (`test/unit/webviewConvention.test.ts:56`); doze classes acrescentariam repetição sem acrescentar uma fronteira que o guard consiga verificar.

O genérico não deve repetir o singleton global atual. Hoje Control tem um único `panel` e uma única `currentRoute` (`src/webview/Cockpit.ts:792`), justamente a forma que impede duas task details. O manager genérico precisa parametrizar a política de identidade, não impor singleton universal.

### Rejeitado e por quê

Rejeito **doze managers escritos à mão**. Eles recriariam a triplicação que motivou `StudioPanelManagerBase` (`src/webview/shared/studio/StudioPanelManagerBase.ts:9`) e moveriam o contrato de conformidade para inspeção de classes heterogêneas. Também rejeito **um único manager-singleton de seção ativa**: seria Control com outro nome e falharia o caso motivador de duas instâncias.

## 2. Unidade de app e bundle

### Recomendação

Fazer de cada app **um entrypoint/mount independente e um bundle de entrada próprio**, mas construir todos os entrypoints editoriais numa única invocação esbuild ESM com `splitting: true`, permitindo chunks JavaScript compartilhados para Preact, kit e utilidades puras. Cada app deve ter shell, bootstrap, error boundary e CSS explícitos próprios. Subrotas do mesmo app podem continuar lazy dentro desse entrypoint. O budget deve passar a medir (a) o eager entry de cada app e (b) o total de chunks alcançáveis pelo conjunto, sem exigir que dependências comuns sejam duplicadas doze vezes.

### Argumento

A pergunta contrapõe “doze bundles” a “um grafo compartilhado”, mas essa dicotomia está mal posta. O build atual já usa ESM, `outdir`, nomes de chunks e `splitting: true` para Control (`esbuild.mjs:278`, `esbuild.mjs:294`), e o cliente já separa corpos por imports lazy (`src/webview/cockpit/App.tsx:68`). Esbuild aceita múltiplos entrypoints numa mesma build e pode extrair dependências comuns; portanto isolamento de bootstrap não exige doze cópias integrais do kit.

Um bundle único com doze mounts manteria o ponto de falha compartilhado que a 485 explicitamente quer remover. Hoje todas as seções entram pelo mesmo `cockpit.js` (`src/webview/Cockpit.ts:3100`) e pelo mesmo componente que escolhe corpo a partir de `model.section` (`src/webview/cockpit/App.tsx:1485`). Mesmo com lazy chunks, shell, listener principal, estado e error boundary continuam compartilhados; isso é code-splitting, não isolamento de app.

Entrypoints separados também alinham build e manifesto: o guard existente define uma superfície convertida como `src/webview/<view>/main.tsx` mais `dist/webview/<view>.js` (`test/unit/webviewConvention.test.ts:23`). Já o budget atual olha apenas `dist/webview/cockpit.js` (`test/unit/cockpitBundleBudget.test.ts:4`), logo ele deve ser generalizado a partir do manifesto, não preservado artificialmente através de um mega-entry.

### Rejeitado e por quê

Rejeito **um bundle/entrypoint com doze mounts lazy**. Ele economiza pouco além do que multi-entry splitting já pode compartilhar e preserva a falha comum no bootstrap/shell, contrariando o isolamento que justifica a reversão. Rejeito também **doze builds IIFE totalmente independentes**: o `sidebar` atual é IIFE (`esbuild.mjs:228`), mas repetir esse modelo por app impediria extração de chunks comuns e faria o custo que a pergunta teme virar inevitável.

## 3. Seletor de escopo de workspace

### Recomendação

Mover o seletor para o **Control launcher na sidebar** e fazer o **extension host** possuir uma store de escopo da janela. O launcher altera essa store; dashboards standalone recebem o escopo atual ao abrir e são atualizados quando ele muda. Rotas/documentos com identidade (`task-detail`, activity, handoff, studios) permanecem fixados ao `wsHash` com que foram abertos e não são redirecionados por uma troca global.

### Argumento

O launcher já é a autoridade de descoberta das doze seções: consome `CONTROL_SECTION_NAV` (`src/webview/sidebar/App.tsx:15`) e envia `openControl` com o `sectionId` escolhido (`src/webview/SidebarPrototype.ts:295`). O catálogo é derivado da mesma ordem do produto (`src/cockpit/sectionNav.ts:38`). Portanto a sidebar é o lugar neutro que existe mesmo quando nenhum app de seção está aberto; Overview não é.

Hoje o estado real já é host-owned, não Overview-owned: `controlWsHash` é variável de módulo no host (`src/webview/Cockpit.ts:879`), o seletor apenas emite `onSwitchWorkspace` (`src/webview/cockpit/App.tsx:1716`), e o host ressincroniza modelo e módulo ativo ao trocar (`src/webview/Cockpit.ts:2606`). A migração correta é extrair esse estado do singleton `Cockpit.ts` para uma store de janela observável pelos managers, não transferi-lo para outro app arbitrário.

É essencial separar escopo de dashboard de identidade de documento. O próprio router estabelece que task detail carrega `wsHash` imutável e nunca deriva identidade do seletor (`src/cockpit/route.ts:37`); activity repete a regra (`src/cockpit/route.ts:49`) e handoff também (`src/cockpit/route.ts:91`). Isso permite duas task details de workspaces diferentes lado a lado sem uma troca no launcher transformar uma delas em outro documento.

### Rejeitado e por quê

Rejeito **manter o seletor em Overview**: torna necessário abrir um app apenas para configurar os outros e deixa o estado sem dono quando Overview fecha. Rejeito **duplicar um seletor em cada app**: cria doze controles concorrentes sobre um conceito global e reabre a divergência que t-46eb4f fechou. Rejeito também **usar a seleção global para retargetar documentos já abertos**, porque o código atual declara isso um erro de identidade, não uma preferência de UX.

## 4. Estratégia de migração

### Recomendação

Fazer **cutover atômico, uma seção por PR**: no mesmo PR, adicionar o app standalone, mudar launcher/comandos para ele, converter restore/deep links antigos em redirects e remover o renderer/branch daquela seção de Control. Pode sobreviver um shim de compatibilidade sem UI; não podem sobreviver dois caminhos que renderizam a seção. Após a última seção, remover o singleton/router restante.

### Argumento

Essa é a imagem espelhada da disciplina que já funcionou na 410. Sua aceitação exigia um único host path após cada migração (`docs/specs/410-cockpit-single-app/spec.md:114`) e remoção explícita do bundle antigo (`docs/specs/410-cockpit-single-app/spec.md:126`); o plano registrou Foundation → PR por superfície e rejeitou big-bang (`docs/specs/410-cockpit-single-app/plan.md:122`). A direção mudou, mas a propriedade “um renderer vivo por superfície” não precisa mudar.

Compatibilidade de restore não exige manter a UI antiga. O código atual registra serializers de painéis pré-410 que dispõem o painel legado e redirecionam Board/task detail para Control (`src/extension.ts:2192` e `src/extension.ts:2202`), enquanto o helper de serializer dispõe estado inválido (`src/webview/shared/panelSerializer.ts:17`). Na volta, o mesmo padrão deve apontar o estado/rota antigo de Control ao app standalone correspondente. Isso satisfaz a SDD 361, que pede reidratação a partir de identidade mínima (`docs/specs/361-reload-restore-panels-terminals/spec.md:19`), sem pagar o custo de dois renderizadores.

O cutover precisa ser atômico também porque o host atual usa estado global compartilhado (`panel`, `currentRoute`, `navEpoch` em `src/webview/Cockpit.ts:792` e `src/webview/Cockpit.ts:805`). Manter a seção simultaneamente no novo manager e no Control cria duas inscrições, duas políticas de escopo e duas respostas possíveis ao mesmo comando — precisamente o drift que a 410 eliminou.

### Rejeitado e por quê

Rejeito **manter os dois caminhos de renderização vivos por seção**. Não oferece rollback limpo: oferece dois produtos ativos e torna impossível provar qual caminho o manifesto, conformance guard, refresh e serializer governam. Rejeito **big-bang das doze seções**, porque amplia o raio de falha sem necessidade e abandona uma disciplina incremental já comprovada. O rollback de um PR deve restaurar o renderer de Control daquela seção; não deve depender de um dual path permanente.

## Discordâncias com a 485

1. **“Doze bundles” versus “grafo de CSS compartilhado” é uma falsa dicotomia.** Entrypoints independentes numa build ESM com splitting podem compartilhar chunks JavaScript. CSS de shell/superfície deve continuar explícito por app; um grafo CSS global compartilhado seria justamente uma nova forma de bleed. A pergunta deve distinguir _entrypoint/bootstrap_ de _chunk físico compartilhado_.

2. **“Um hidden app costs nothing” é absoluto demais.** `retainContextWhenHidden: true` mantém o contexto (`src/webview/shared/studio/StudioPanelManagerBase.ts:156` e `src/webview/Cockpit.ts:1191`), logo haverá ao menos memória/iframe retidos. O critério verificável deve ser “nenhum refresh, coleta, subscriber callback ou post de modelo enquanto oculto; reveal faz catch-up”, que é o que os cenários da própria spec medem (`docs/specs/485-standalone-section-apps/spec.md:103`). Não prometer custo literalmente zero.

3. **“App de seção” não cobre sozinho o caso de duas task details.** As doze entradas de `CONTROL_SECTION_NAV` são top-level (`src/cockpit/sectionNav.ts:22`), enquanto task detail é uma rota identitária separada (`src/cockpit/route.ts:37`). O plano precisa declarar dois tipos de app/instância: dashboard por seção/escopo e documento por identidade. Sem isso, pode entregar doze abas e ainda falhar o caso motivador principal.
