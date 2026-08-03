# Opinião Grok — SDD 485 open questions

_Agent: opiniaogrok. Date: 2026-08-02. Mode: design consultation — no product code changed._

Sources read before answering: `docs/specs/485-standalone-section-apps/spec.md` (primary checkout), `docs/specs/410-cockpit-single-app/{spec,plan}.md`, `src/webview/surfaces.ts`, `src/webview/Cockpit.ts`, `src/webview/cockpit/App.tsx`, `src/webview/cockpitSingleton.ts`, `src/webview/shared/studio/StudioPanelManagerBase.ts`, `src/webview/shared/shell.ts`, `src/webview/shared/panelSerializer.ts`, `src/cockpit/sectionNav.ts`, `src/cockpit/model.ts`, `src/webview/AgentPanePanel.ts`, `test/unit/controlWorkspaceScope.test.ts`, `test/unit/cockpitBundleBudget.test.ts`, `esbuild.mjs`, retired panel stubs (`TaskDetailPanel.ts`, `MissionControlPanel.ts`, studios), sidebar launcher (`src/webview/sidebar/App.tsx` ControlGrid).

---

## 1. Host panel manager: genérico por seção vs doze managers

### Recomendação

**Um `SectionPanelManager` genérico, parametrizado por config de seção (viewType, bundle, styles, collectNeeds, message dispatch, serializer state)** — singleton por `viewType` (reveal-on-reopen). **Não** herdar de `StudioPanelManagerBase`. Superfícies multi-instância por entidade (task detail e, se voltarem, activity/probes) usam um **segundo** base Map-keyed (`InstancePanelManager` / padrão de `AgentPanePanelManager` + `StudioPanelManagerBase.panels`), **não** oze managers de seção e **não** o protocolo dirty/save de studio.

### Argumento

1. **O paralelo com os ~10 studios está mal posto no código de hoje.** `StudioPanelManagerBase` existe para o lifecycle *entity-CRUD* (Map `entityType:wsKey:entityId`, dirty, save, restore snapshot) — ver `src/webview/shared/studio/StudioPanelManagerBase.ts:76-135` e o comentário em `:9-20`. Em produção, os studios de produto **já não** abrem esse base: migraram para `studioHost.ts` dentro do Control (`src/cockpit/studioHost.ts`, comment em `:3-5`). O único consumidor ainda vivo do base no host é o fake dev `PipelineStudioPanelManager` (`src/webview/PipelineStudioPanel.ts:29-34`). Copiar o *nome* "StudioPanelManagerBase" para seções colaria o protocolo errado (save/cancel/dirty) em dashboards que postam `model`/`snapshot`.

2. **Doze managers hand-rolled recriam exatamente o que 410 absorveu.** Os painéis de seção pré-410 viraram stubs de tipo + redirect (`TaskDetailPanel.ts:1-20`, `MissionControlPanel.ts:1-15`, `ApprovalPanel.ts:18-43`). A lógica real concentrou-se em `Cockpit.ts` (~3185 linhas) com um único `createWebviewPanel` + reveal (`Cockpit.ts:1175-1193`). Doze classes novas que triplicam open/html/serializer/dispose são o anti-padrão que o base de studios já documenta ter existido (`StudioPanelManagerBase.ts:10-13`: "ONE lifecycle every studio dialect triplicated").

3. **Config genérica casa com o manifesto e o contrato de conformidade.** `WEBVIEW_SURFACES` já é o inventário canônico (`surfaces.ts:1-7`, `19-44`); `renderWebviewShell` já é o único DOCTYPE (`shell.ts:1-9`, `:59-60`); `registerTrustedPanelSerializer` já é o revive genérico (`panelSerializer.ts:19-55`). Um manager parametrizado por `StudioSurfaceConfig`-like + section id faz **conform** ser o caminho default: o shell e o bundle passam pela mesma fábrica. `replace` é outro host path (declarado no manifesto), não uma subclasse espontânea.

4. **Multi-instância (motivo real da reversão) não é "uma seção"**.** Dois task details lado a lado exigem Map por `(wsHash, taskId)`, o mesmo shape que `StudioPanelManagerBase` usa em `:77` e `AgentPanePanelManager` em `AgentPanePanel.ts:78-79` (`byAgent`). Task detail **não** está em `CONTROL_SECTION_NAV` / `COCKPIT_SECTION_ORDER` (`sectionNav.ts:22-36`, `:38-46`) — é subrota. Tratar "doze seções ⇒ doze managers" deixa o caso motivador de fora.

### Rejeitado

| Opção | Por quê |
|-------|---------|
| 12 managers de seção hand-rolled | Recria triplicação pré-350/pré-410; sem ganho de conformidade (o contrato é sobre shell/manifesto, não sobre contagem de classes). |
| Estender `StudioPanelManagerBase` para seções | Protocolo studio (dirty/save/entity) ≠ model push de seção; base hoje quase só dev-fake. |
| Um manager só, sem ramo multi-instância | Não serve "dois task details" (485 intent; hoje o Control é singleton — `cockpitSingleton.ts:16-24`, `Cockpit.ts:1175-1176` reveal). |

### Formulação da pergunta

A dicotomia "doze vs um genérico" é incompleta. A divisão certa é **dois host kinds**: (A) singleton section manager genérico; (B) multi-instance entity manager. Studios já são um (B) com protocolo de formulário; task-detail é (B) com protocolo de projeção.

---

## 2. Unidade de "app": 12 bundles vs 1 bundle + 12 mounts lazy

### Recomendação

**Unidade de app = um `WebviewPanel` (aba do editor) + um `viewId` no manifesto**, não um entry esbuild. **Um grafo de bundle compartilhado** (entry shell tipo o cockpit atual com `splitting: true` + lazy chunks de seção — `esbuild.mjs:278-303`, `App.tsx:69-159`) carrega N abas; cada aba aponta o mesmo (ou o mesmo family de) `*.js` e importa o chunk da seção/rota. **Orçamento de eager** permanece numérico (sucessor do `cockpitBundleBudget.test.ts:4-18`, ≤ 350 KB no eager). **Não** reintroduzir 12 bundles eager independentes.

### Argumento

1. **Isolamento que justifica a 485 é de webview/aba, não de grafo de módulos.** Um painel crasha ou trava o seu iframe; o outro continua — isso já é verdade se Board e Task Detail forem dois `createWebviewPanel` distintos, mesmo ambos carregando `section-host.js`. O isolamento que 410 tirou foi **capacidade multi-aba** (Phase C: subroutes, `plan.md:75-83`), não "um processo V8 por App.tsx". A frase da 485 "um bundle enfraquece isolamento" confunde as duas.

2. **O orçamento de bundle é o problema que 410 mediu e resolveu mecanicamente.** Baseline cockpit ~244 KB, gate 350 KB (`410 plan.md:36-42`, `cockpitBundleBudget.test.ts:4-18`). Superfícies individuais já mediam 640 KB+ (`410 spec.md:87-89`). Doze entries eager reabrem esse buraco; lazy chunks por seção **já existem** e co-carregam CSS com o chunk (`App.tsx:71-76`, `lazySectionStyles`).

3. **CSS/kit compartilhados são feature do contrato, não bug.** O half de enforcement da 485 (conform/extend/replace no manifesto) **precisa** de um grafo CSS/kit único. Bundles peer com sheets próprias foi o modo de falha de 2026-07-18 (`410 spec.md:26-33`). Um grafo + contract test é o substituto de "um runtime".

4. **`WEBVIEW_SURFACES` conta viewIds que criam painel, não bundles.** Plugin host já reusa o mesmo `view: "plugin-host"` em dois viewIds (`surfaces.ts:140-142`). O precedente de N viewTypes / 1 bundle directory existe.

### Rejeitado

| Opção | Por quê |
|-------|---------|
| 12 bundles esbuild separados (eager) | Reabre o budget de 410 sem comprar isolamento de aba. |
| Um único painel Control com multi-split interno | Não usa colunas nativas do editor; rejeita a capacidade VS Code que motivou a 485. |
| Bundle por aba *sem* lazy | Mesmo problema de budget no primeiro open de cada tipo. |

### Nota sobre multi-instância e "app"

Task detail como **app multi-instância** (mesmo bundle, N painéis, state por taskId) é a unidade certa para o caso "dois details". Board é **app singleton** (um painel, reveal). Ambos podem compartilhar o host bundle; diferem no *manager*, não no entrypoint.

---

## 3. Onde fica o seletor de escopo de workspace?

### Recomendação

**Autoridade no host (serviço de escopo global, extrair o `controlWsHash` de módulo em `Cockpit.ts:882`)**; **UI no chrome compartilhado de cada section app** (mesmo controle, mesma action `switchControlWorkspace`, mesmo estado host). Overview deixa de ser dono visual. O invariante de t-46eb4f que se preserva é **um writer de escopo global**, não **um único sítio no DOM do Overview**.

### Argumento

1. **Hoje o seletor é Overview-only e o host é o writer.** UI: `App.tsx:1716-1731` (`data-testid="control-workspace-select"`). Host: `controlWsHash` module-scoped (`Cockpit.ts:882`) escrito por open-opts e `switchControlWorkspace` (`Cockpit.ts:1170-1172`, assignments contados em `controlWorkspaceScope.test.ts:57-64`). Toda projeção filtra por esse hash (`Cockpit.ts:995+`, `model.ts:366+`).

2. **Overview-only quebra no modelo N apps.** Se Board está numa coluna e Overview não está aberto, o humano não tem como mudar o root sem abrir outra aba. t-46eb4f moveu o seletor **para fora** do nav strip porque "nav escolhe SCREEN; root escolhe-se uma vez" (`App.tsx:2263-2265`). Com N apps, o chrome de cada app **é** o lugar de "screen chrome"; o seletor global cabe lá se todos leem/escrevem o mesmo host state.

3. **O teste fonte de t-46eb4f amarra a UI a um ficheiro** (`controlWorkspaceScope.test.ts:28-30`: só `cockpit/App.tsx` pode conter o testid). Isso **terá de mudar** — o teste está certo no *espírito* (um controlo, sem mirrors tipo `board-workspace-select` — linhas 46-55) e errado no *ancoramento* Overview se a 485 avança. Reescrever o teste para: um testid canónico no shell compartilhado; zero writers locais de escopo global nas seções; Board continua sem `switchWorkspace` (`mission-control` já limpo — `controlWorkspaceScope.test.ts:46-55`).

4. **Filtros locais permanecem locais.** tmux `useState("all")` não toca no global (`controlWorkspaceScope.test.ts:69-76`) — isso continua válido.

### Rejeitado

| Opção | Por quê |
|-------|---------|
| Overview continua dono exclusivo | Com Board/terminal side-by-side, Overview pode estar fechado; capacidade morta. |
| Cada app com escopo independente | Desfaz t-46eb4f; Board e Runtime "olham" roots diferentes sem o humano perceber. |
| Seletor só na sidebar | Sidebar tem multi-folder nativo (`sidebar/App.tsx` por `ws-scope`); Control é window-wide (`ControlGrid` comment `:1037-1043`). Misturar densidades e papéis; e o humano focado no editor não olha para a sidebar para filtrar o Board. Aceitável como *espelho read-only* futuro, não como único controlo. |
| Sem seletor (sempre all / always first root) | Multi-root é real (`fixtures` e t-d16a39); Settings Companion já exige single scope (`Cockpit.ts:678` string). |

---

## 4. Migração: dual-path durante transição ou cutover?

### Recomendação

**Cutover por superfície (espelho da 410): um PR por seção/app, no fim do PR o caminho Control para essa seção morre (ou redireciona só via serializer legacy).** Dual-path de *produto* (abrir a mesma seção como aba standalone **e** como tab interna do Control) **não** — foi o defeito piloto de Approvals (`410 plan.md:52-53`, `64`; `410 spec.md:130`). Dual-path de *revive* (serializer do viewType antigo → abre o novo app) **sim**, pelo tempo de uma janela de reload, no padrão já usado em `extension.ts` / stubs e em `cockpitSingleton.ts:1-14`.

### Argumento

1. **410 migrou uma superfície por PR e matou o painel antigo no fim** (`410 plan.md:40-41`, `72-73`; dual forever = non-goal, `410 spec.md:126-130`). A imagem espelhada é a formulação certa na 485 open question.

2. **O dual-path de produto dói e já tem cicatriz.** Approvals era standalone **e** seção; o pilot existiu para fechar isso (`410 plan.md:49-53`). Deixar "Control ainda tem Board" + "Board standalone" durante semanas recria dual open, dual commands, e revive races — o singleton claim nasceu exatamente de shims de revive a lutar com Control (`cockpitSingleton.ts:5-14`, `Cockpit.ts:1158-1166`).

3. **Serializer redirect é o dual *seguro*.** Stubs como `ApprovalPanelManager.deserialize` (`ApprovalPanel.ts:27-36`) e `TaskDetailPanel` comments (`TaskDetailPanel.ts:10-13`) já fazem dispose+redirect sem criar segundo produto. Na direção 485: painel Control persistido com `section: mission` → revive como app Board (ou abre app + dispose Control quando a última seção saiu).

4. **Ordem: Phase 0–1 da 485 antes de qualquer cutover.** Contrato de conformidade + visibility gating (`retainContextWhenHidden: true` em `StudioPanelManagerBase.ts:160`, `Cockpit.ts:1191-1193`; zero `onDidChangeViewState` no tree) são pré-requisitos escritos na 485 e o código confirma o gap.

### Rejeitado

| Opção | Por quê |
|-------|---------|
| Big-bang: todas as 12 de uma vez | Contraria migração incremental que 410 provou ser a única que manteve suite verde; Cockpit.ts é monolito demais. |
| Dual-path de produto por seção "até o fim" | Reabre Approvals dual-open; confunde launcher e serializers. |
| Manter Control forever com seções "também" standalone | A 485 pede remover machinery do single-app no fim; dual permanente contradiz o done. |

### Piloto sugerido (sequência, não dual)

1. Phase 0 (contract) + Phase 1 (visibility gate) sem mover seções.  
2. **Task detail multi-instance app** (caso motivador #2) — cutover da subrota.  
3. **Board singleton app** (caso motivador #1, lado a lado com terminal).  
4. Resto das seções, uma por PR, cutover cada.  
5. Remover router/navEpoch/singleton de Control quando a última seção sair.

---

## Discordâncias com a 485 (e com premissas)

### 1. A reversão da *capacidade* está certa; a reversão de *todas* as 12 seções como passo zero não está provada

Os casos motivadores na 485 (`spec.md` intent) são **Board + terminal** e **dois task details**. Isso exige:

- Board (e qualquer seção que se queira lado a lado) como painel editor próprio, **e**
- Task detail como **multi-instance**, que **não** é uma das doze entradas de `CONTROL_SECTION_NAV` (`sectionNav.ts:38-46`).

Dissolver Overview/Engine/Settings/Plugins/… no mesmo fôlego compra arquitetura limpa e paga o monolito `Cockpit.ts` inteiro. Preferível: **provar a capacidade nos dois casos motivadores primeiro**; só então generalizar. Se o piloto de Board+task-detail satisfizer o dono com Control ainda hospedando o resto, o "done" da 485 pode estreitar-se sem trair o intent.

### 2. "Um bundle enfraquece isolamento" não se sustenta no modelo VS Code

Ver §2. O isolamento pedido é multi-aba / multi-coluna / crash boundary por webview. Isso é `createWebviewPanel` N vezes (`Cockpit.ts:1191` vs `StudioPanelManagerBase.ts:156-161`), não N outfiles em `esbuild.mjs`. Manter essa confusão no plan empurraria 12 bundles e reabriria o budget de 410 sem ganho.

### 3. O paralelo "doze managers como os studios" está desatualizado

Os ~10 managers studio **não** são o runtime de produção atual; são stubs + `studioHost` no Control (`AgentStudioPanel.ts:6-13`, etc.). O base vivo é o *padrão Map + shell + serializer*, não a contagem de classes. O plan não deve copiar `StudioPanelManagerBase` para seções.

### 4. Premissa de enforcement: concordo e é a metade que salva a reversão

A frase de 410 (`spec.md:32-33`: kit não impõe runtime com N peers) continua verdadeira. A 485 acerta ao pôr **contrato mecânico (conform/extend/replace) antes** da migração e ao estender `WEBVIEW_SURFACES` em vez de inventário paralelo (lição P0-1 de 410, `plan.md:22-29`, `122-128`). Sem Phase 0, a reversão recria 2026-07-18.

### 5. Visibility gating: pré-requisito real, não cosmético

`retainContextWhenHidden: true` sem `onDidChangeViewState` (confirmado: base studio `:160`, cockpit `:1191-1193`; search sem hits de view-state no host product path) faz N apps multiplicarem o custo de eventos que t-b51923 acabou de baixar. Phase 1 da 485 é correta e deve bloquear migração de seções.

### 6. t-46eb4f Overview-only não sobrevive literalmente

Não discordo do *produto* (um escopo global). Discordo de ancorar a UI no Overview após N apps. O plan deve atualizar `controlWorkspaceScope.test.ts` no mesmo PR que move o chrome — senão o gate fonte bloqueia a 485 por desenho.

### 7. Control launcher (t-6e2952) continua certo

O grid na sidebar (`sidebar/App.tsx:1037-1055`) já é a porta "abre seção" sem segundo WebviewView. A 485 só muda o destino de `tachyon.openControl` de "reveal singleton + navigate" (`:1045-1047`) para "open/reveal app da seção". Não reabrir um view collapsible separado (já rejeitado em `surfaces.ts:47-50`).

---

## Telegrama das quatro recomendações

1. **Manager:** genérico `SectionPanelManager` (singleton) + base multi-instance separado para entity apps; não 12 classes; não `StudioPanelManagerBase` para seções.  
2. **App unit:** painel/viewId; **um** grafo bundle + lazy chunks; budget eager mantido.  
3. **Scope:** host-global `controlWsHash`; seletor no shell compartilhado de cada app; Overview deixa de ser dono.  
4. **Migração:** cutover por superfície (espelho 410); dual só em serializer revive; piloto task-detail multi + Board antes do resto.

_Fim. Nenhum `npm run verify` — sem mudanças de produto; só este artefato de evidência._
