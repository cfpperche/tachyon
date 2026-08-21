# 514 — user-apps-zip-install

_Created 2026-08-21._

**Status:** draft

## Intent

Tachyon hoje tem duas maneiras de desenhar uma tela, e só uma delas é do usuário — a outra exige publicar um pacote num repositório git.

**Telas embutidas** são apps de primeira classe: uma linha em `apps/vscode-extension/src/webview/webviewApps.ts`, um ladrilho em `LAUNCHER_ORDER`, uma aba do editor gerida pelo `SectionPanelManager`, confiança total. São doze, e são fixas em tempo de compilação.

**Views de plugin** (spec 349) são a porta de terceiros: declaradas no campo `views` do `tachyon-plugin.json`, renderizadas num iframe `srcdoc` com `connect-src 'none'`, um único escopo de dado (`fleet: "summary"`) e uma única ação (`focusAgent`), alcançadas pelo painel de Plugins — nunca pelo launcher.

**Medido em 2026-08-21: essa segunda porta tem exatamente um consumidor no mundo.** Zero dos 17 pacotes do repositório `cfpperche/tachyon-plugins` declara `views`. O único `views` instalado é o do `terrarium`, que vem do próprio repositório dele (`github:cfpperche/terrarium`). Toda a maquinaria do spec 349 — broker de ações, relay, CSP, montagem de `srcdoc`, o backlog aberto em `t-8c0a7d` — existe para servir uma tela.

Esta spec parte o conceito em dois e move o consumidor para o lado certo:

| conceito | fica com | perde |
|---|---|---|
| **Plugin** | skills, hooks, MCP, tools, externalTools, git-hooks, config, data | `views` — deixa de poder desenhar tela |
| **App** | tela em aba do editor, ladrilho no launcher, instalável pelo usuário | — |

Um **app** é HTML estático que o usuário instala subindo um `.zip` pela aba Apps. Ele é descompactado em `.tachyon/apps/<id>/`, ganha um ladrilho no launcher e abre numa aba do editor. Ele fala com o Tachyon pelo Bridge — a mesma superfície que os agentes usam — sem restrição de ação, sem CSP, sem allowlist. O usuário instalou; o usuário consentiu.

O Terrarium deixa de ser plugin-com-view e passa a ser app. O campo `views` sai do manifesto de plugin, e o spec 349 sai junto com ele.

**Por que agora.** A porta de terceiros tem um consumidor e um backlog aberto para alargá-la (`t-8c0a7d`). Alargar a porta errada custa mais do que trocá-la de lugar. E a capacidade que falta — usuário criar a própria tela sem publicar pacote — é a que o produto não tem de jeito nenhum hoje.

## Acceptance criteria

### Instalação

- [ ] **Scenario: instalar um app por zip**
  - **Given** a aba Apps aberta, e um arquivo `.zip` contendo `app.json`, `index.html` e um arquivo de ícone
  - **When** o usuário usa a ação Adicionar e escolhe esse zip
  - **Then** o conteúdo é descompactado em `.tachyon/apps/<id>/`, um ladrilho novo aparece no launcher com o ícone do app, e nenhum reload da janela é exigido

- [ ] **Scenario: reinstalar por cima é a porta de update**
  - **Given** um app já instalado com id `foo`
  - **When** o usuário sobe um zip cujo `app.json` declara o mesmo id `foo`
  - **Then** o diretório `.tachyon/apps/foo/` é substituído pelo conteúdo novo, sem prompt de confirmação, e o ladrilho reflete o `app.json` novo

- [ ] **Scenario: zip inválido avisa e não derruba nada**
  - **Given** um zip sem `app.json`, ou com `app.json` ilegível, ou sem o `entry` que ele declara
  - **When** o usuário tenta instalar
  - **Then** a aba Apps mostra o que faltou, nenhum diretório parcial fica em `.tachyon/apps/`, e os apps já instalados continuam funcionando

- [ ] **Scenario: app quebrado no disco não impede o Tachyon de subir**
  - **Given** um diretório em `.tachyon/apps/<id>/` cujo `app.json` foi corrompido ou apagado à mão
  - **When** a extensão inicia
  - **Then** o Tachyon sobe, os outros apps e as doze telas embutidas aparecem, e o app quebrado é omitido do launcher com um aviso — nenhuma exceção sobe do startup

### Execução

- [ ] **Scenario: abrir um app instalado**
  - **Given** um app instalado e seu ladrilho no launcher
  - **When** o usuário clica no ladrilho
  - **Then** o `entry` do app abre numa aba do editor, com o título e o ícone que o `app.json` declara

- [ ] **Scenario: reabrir revela em vez de duplicar**
  - **Given** um app já aberto numa aba do editor para o projeto corrente
  - **When** o usuário clica no ladrilho de novo
  - **Then** a aba existente é revelada; não nasce uma segunda

- [ ] **Scenario: o app chama o Bridge**
  - **Given** um app aberto cuja página chama `window.tachyon.call("list_agents", {})`
  - **When** a chamada resolve
  - **Then** a página recebe o mesmo resultado que a ferramenta `list_agents` do Bridge devolve a um agente

- [ ] **Scenario: chamada que falha volta como erro para o app**
  - **Given** um app que chama uma ferramenta inexistente, ou uma ferramenta que rejeita a entrada
  - **When** a chamada resolve
  - **Then** a página recebe o erro e o Tachyon não mostra tela de erro própria, não repete a chamada e não enfileira nada

- [ ] Não existe allowlist, categoria ou escopo no caminho do app. Nada é negado a um app por uma lista que o Tachyon mantenha.
- [ ] A página do app não roda sob `connect-src 'none'` nem sob a montagem de `srcdoc` do spec 349.
- [ ] Um app alcança `spawn_agent`, `kill_agent`, `list_agents`, as ferramentas de board, worktree, tmux e browser — a superfície que um agente alcança, sem intermediário que filtre.

**As doze ferramentas que um app não alcança, e por quê.** Medido em 2026-08-21: o chamador que o host consegue autenticar é `external`, e doze ferramentas exigem `caller.kind === "agent"` porque o *sujeito* delas é um agente:

| ferramenta | por que exige agente |
|---|---|
| `propose_saved_agent`, `cancel_saved_agent_proposal` | a proposta é do agente que a fez |
| `propose_saved_agent_removal`, `cancel_saved_agent_removal_proposal` | idem |
| `request_human_approval`, `get_approval_status`, `cancel_human_approval` | aprovação é pedida *por* um agente, para o humano |
| `flag_for_human`, `clear_human_flag`, `request_human_attention` | a bandeira nomeia quem a levantou |
| `attach_task_prototype` | o protótipo tem autor |
| `run_host_action` | `host-action/policy.ts:63` exige principal de agente resolvido |

Isso não é restrição de poder — é o significado da ferramenta. Um app não tem nome de agente para ser sujeito de nenhuma delas. A única perda de capacidade real da lista é `run_host_action`.

- [ ] O contrato de identidade do app está escrito onde alguém que autora um app vai ler, nomeando as doze.

### O plugin perde a tela

- [ ] **Scenario: manifesto de plugin com `views` é recusado**
  - **Given** um `tachyon-plugin.json` que declara o campo `views`
  - **When** ele passa pelo `loadManifest`
  - **Then** o manifesto não carrega e o erro nomeia `views` como campo removido, apontando o caminho de app

- [ ] O Terrarium está instalado como app, aberto pelo ladrilho do launcher, e não aparece mais como plugin com view.
- [ ] `PLUGIN_UI_ACTIONS`, o broker de ações de plugin, o modo `plugin` de `assembleUntrustedSrcdoc` e o `VIEW_FLEET_SCOPES` foram removidos do código, não deixados desligados.
- [ ] `docs/specs/349-plugin-ui-surfaces/spec.md` tem `**Status:** superseded` apontando para esta spec.

### Catálogo

- [ ] O launcher lista as doze telas embutidas seguidas dos apps instalados, e a ordem de produto das doze não muda.
- [ ] A reordenação por arrastar e por teclado funciona com ladrilhos de app misturados aos embutidos, e desinstalar um app não corrompe a ordem gravada.
- [ ] Um id de app não pode colidir com um id de seção embutida, por construção e não por validação.

## Non-goals

**Segurança.** Não há sandbox, allowlist, escopo, consentimento por capacidade nem auditoria de chamada. O usuário instalou o app; isso é o consentimento. Qualquer proposta de restringir o que um app pode fazer está fora desta spec — não é adiamento por falta de tempo, é decisão do dono em 2026-08-21.

**Marketplace.** Não há catálogo remoto, busca, publicação, assinatura, checksum, pin de versão nem source-spec de git. A única porta é o zip local.

**Build.** O app é HTML estático. O Tachyon não compila, não empacota, não faz bundle e não roda passo de build. Quem autora o app empacota o app.

**Sidebar e painel.** App só existe como aba do editor. Nada de widget de sidebar, nada de painel inferior. A `ViewSurface` do spec 349 tinha dois valores; o app tem um.

**SDK versionado.** Não há contrato de versão entre app e Tachyon, nem shim, nem tipos publicados, nem política de compatibilidade. `window.tachyon.call(nome, args)` sobre as ferramentas do Bridge que existem hoje.

**Armazenamento.** O Tachyon não oferece persistência ao app. O que a webview guarda em `localStorage` é do app e some com ela se o VS Code descartar o estado.

**Sync remoto.** `.tachyon/` continua local à máquina do usuário e fora do git. A sincronização para ambiente remoto é trabalho futuro e não é premissa desta spec.

**Desinstalar pela UI.** Fora do MVP. Apagar o diretório à mão desinstala; o catálogo é lido do disco.

**Multi-projeto no zip.** Um zip é um app. Um app é um `app.json`.

## Open questions

**Aberta — `run_host_action` é a única capacidade que um app perde.** As outras onze da lista acima são ferramentas cujo sujeito é um agente, e um app não é um. Essa é diferente: é rodar algo na máquina, e um app poderia querer. Fechar essa lacuna significa dar ao app uma identidade de agente, o que muda a semântica de identidade do Bridge — trabalho real, não ajuste. Decisão do dono. Se ele disser "fica de fora do MVP", esta pergunta vira um non-goal.

Fechadas em 2026-08-21:

| pergunta | resposta |
|---|---|
| App vive em aba do editor ou pode reivindicar sidebar? | editor por enquanto |
| Todo app vira ladrilho no launcher? | sim |
| Qual é a stack de um app? | HTML estático |
| Onde mora o app instalado? | `.tachyon/apps/<id>/`, ignorado pelo git |
| De onde vem o ícone do ladrilho? | arquivo dentro do app |
| Onde fica a porta de upload? | aba Apps |
