# Design Mode sem chat próprio: o que o Orca realmente faz e o desenho para o Tachyon

_2026-08-13. Task `t-200636`. Pesquisa de fonte e proposta; nenhuma mudança em `src/`._

## Veredito

O comentário do dono está certo sobre a **forma**: o chat próprio não é necessário para esta função.
O Orca acumula anotações ligadas a elementos, forma um único prompt Markdown, deixa o humano escolher
um agente no momento do **Send** e entrega o texto no terminal daquele agente. Não há conversa,
arquivo de protocolo nem chamada direta a provedor nessa passagem.

Para o Tachyon, a correção não é manter a página magra: **UI na página é a forma requerida**. O
defeito anterior era uma aplicação inteira escrita como template string manual de 1.657 linhas, não
o fato de ela executar no browser. Há também uma restrição física que decide o desenho: o Orca pode
pintar React na moldura Electron por cima do webview que ele controla; uma extensão VS Code não pode
pintar um webview por cima do editor-browser nativo. Se o painel separado morre, a página é a única
superfície disponível para popover, tray, badges, presets e markup. Logo nosso bundle de página pode
ser maior que os 965 linhas de scripts do Orca, e isso está correto; manutenibilidade, build e portas
de execução são as métricas úteis. A proposta concreta é:

1. **matar a aba/chat do Design Mode**;
2. substituir o inject manual por uma **aplicação Preact de página**, construída pelo `esbuild.mjs`
   como bundle IIFE autocontido e injetada por CDP;
3. pôr nessa aplicação picker, popover, badges, bandeja, seletor de agente, captura, presets e markup;
4. ao apertar **Send**, entregar o lote ao terminal do agente selecionado pela escada TUI existente;
5. manter a captura PNG de cada pick como preview/anexo da anotação, não como mensagem de chat;
6. deixar do webview atual somente código reutilizável migrado ao overlay; o `DesignModePanel` morre.

Isso entrega literalmente “marque na página, envie ao terminal escolhido” sem recriar conversa, sem
Chromium embarcado e sem inventar canal de entrega.

## Fonte do Orca e reprodução

Fonte lido: `stablyai/orca`, MIT, commit
`93334dc53fccdb7348d09fc28067ba6d3dec36ea` (`fix(browser): fail-closed cookie clear after a partial
import wipe (STA-4090) (#14191)`, 2026-08-13 07:38:53 -0700).

O clone ficou fora do produto e fora de `/home/goat/tachyon`, em
`/tmp/orcadesign.oI7HQC/orca-src`. Todas as referências `orca:` abaixo são contra esse commit.
Para reproduzir: `git clone https://github.com/stablyai/orca`, depois
`git checkout 93334dc53fccdb7348d09fc28067ba6d3dec36ea`. Não foi copiado código do Orca.

## As cinco perguntas

### 1. Como a anotação chega no agente e qual é o payload?

**Como texto Markdown submetido ao composer do TUI.** O Send reutiliza
`ReviewNotesSendMenuContent` com `promptDelivery="submit-after-ready"`
(`orca:src/renderer/src/components/browser-pane/BrowserAnnotationSendMenuContent.tsx:17-27`). Para
um agente já vivo, a escolha chama `sendNotesToActiveAgentSession` com `tabId`, `leafId` e o prompt
(`orca:src/renderer/src/components/editor/ReviewNotesSendMenuContent.tsx:147-177`). Para um agente
novo, a mesma lista oferece `QuickLaunchAgentMenuItems` e passa o mesmo prompt com entrega pós-ready
(`ReviewNotesSendMenuContent.tsx:182-209`). Portanto: não é arquivo, protocolo de edição nem mensagem
de chat; é texto entregue ao terminal.

O prompt exato é um documento `## Design Feedback: <path>` com URL, id da aba e viewport; por
anotação leva intenção, seletor, caminho DOM, fonte/React quando detectados, bounds, classes, texto,
vizinhança, estilos computados, full DOM path, trecho HTML e feedback
(`orca:src/renderer/src/components/browser-pane/browser-annotation-output.ts:155-227`).

O objeto capturado antes da formatação contém contexto da página (URL sanitizada, título, viewport,
scroll, DPR e instante), alvo (seletor, caminhos, texto/HTML, atributos, acessibilidade, retângulos de
viewport e página, estilos), textos/ancestrais próximos e screenshot
(`orca:src/shared/browser-grab-types.ts:9-98`). A anotação persistida **remove o screenshot**
(`browser-grab-types.ts:95-98`); o prompt de annotations não leva imagem nem caminho de imagem. As
coordenadas viajam como bounds de viewport no Markdown
(`browser-annotation-output.ts:171-223`).

### 2. Quem escolhe o agente e quando?

O **humano escolhe no clique de Send**, não no começo do modo e não por inferência. O menu enumera
todos os agentes em execução do worktree, não só o pane em foco
(`orca:src/renderer/src/components/editor/ReviewNotesSendMenuContent.tsx:60-97`), mostra “Send notes
to” e cada destino elegível (`ReviewNotesSendMenuContent.tsx:182-195`). O mesmo menu permite lançar
um agente novo (`:197-209`). O botão Send existe tanto no banner de captura quanto na bandeja
flutuante (`orca:src/renderer/src/components/browser-pane/BrowserPane.tsx:5256-5291,5464-5500`).

### 3. Quanto pesa o overlay injetado?

Há dois corpos de página, e separar os dois evita uma conta enganosa:

| corpo | fonte | linhas de fonte | linhas do script principal |
|---|---|---:|---:|
| pick/extrator | `orca:src/main/browser/grab-guest-script.ts` | **955** | `ARM_SCRIPT`, linhas 32–825: **794** |
| badges/viewport | `orca:src/shared/browser-annotation-viewport-bridge.ts` | **257** | template, linhas 86–256: **171** |

Assim, com pick armado e badges ativos, o Orca carrega **965 linhas de JavaScript de página** nos dois
scripts principais (794 + 171). A UI grande — popover, banner, bandeja e markup — é React no renderer
do Orca, por cima do `webview`, não parte desses 965 (`orca:BrowserPane.tsx:5433-5578`). Esse detalhe
é crucial: Electron controla a moldura do seu próprio webview; uma extensão VS Code não pode pintar
React por cima do editor-browser nativo.

### 4. A que o badge sobrevive?

- **Scroll e resize: sim.** O bridge escuta scroll em window/document e resize, agenda por RAF e
  recalcula a posição (`orca:src/shared/browser-annotation-viewport-bridge.ts:191-220,240-254`).
- **Re-render do framework: só visualmente e por acaso geométrico.** O badge não guarda referência ao
  elemento nem consulta novamente o seletor; usa os retângulos capturados (`:191-203`). Se o elemento
  mover num re-render sem scroll/resize, fica no lugar velho. Mesmo havendo evento, apenas a posição
  baseada no retângulo velho é recalculada.
- **Navegação/reload: o registro sobrevive no store da aba, e o badge é reinjetado no `dom-ready`**
  (`orca:BrowserPane.tsx:3534-3583`; annotations ficam por `browserPageId` em
  `src/renderer/src/store/slices/browser.ts:1651-1663`). Mas continua usando o retângulo da página
  anterior: é sobrevivência de estado, não religação semântica ao elemento.
- **Reinício/hidratação da aplicação: não.** A hidratação zera `browserAnnotationsByPageId`
  (`orca:src/renderer/src/store/slices/browser.ts:1866`).

### 5. Markup é imagem ou vetor?

**Os traços são vetores apenas durante a edição; a saída é uma imagem PNG rasterizada.** O modelo
mantém pen/highlight/arrow/rect/ellipse/text em coordenadas CSS e usa a mesma lista no canvas vivo e
no compositor (`orca:src/renderer/src/components/browser-pane/markup/markup-drawing-model.ts:1-53`).
Na conclusão, screenshot e shapes são desenhados num canvas e codificados como `image/png`
(`markup-screenshot-compose.ts:1-22,106-128,144-188`). A entrega v1 copia essa imagem para o
clipboard; o humano cola no terminal, onde a infraestrutura existente materializa o arquivo e passa
o caminho ao TUI (`markup-clipboard-delivery.ts:5-18`). Não se envia JSON vetorial.

## Mapa Orca → Tachyon: reusar e faltar

| função | Orca | Tachyon hoje | decisão |
|---|---|---|---|
| hover/pick | runtime injetado de 794 linhas | inject manual de **30 linhas**, hit-test, outline e captura (`src/webview/ide-browser-bridge/designModeInject.ts:1-30`) | portar a lógica para componentes/hooks do bundle |
| PNG do elemento | annotations descartam imagem | `writePickScreenshot` grava crop e o caminho entra no prompt (`src/webview/ide-browser-bridge/manager.ts:342-384`; `pick.ts:190-192`) | preservar e ligar à anotação |
| anotação acumulável | até 20 por aba, popover + badges + tray | existe apenas `lastPick`/selection anexada ao chat | falta store de lote + UI no overlay |
| destino | humano escolhe agente vivo no Send | Design Mode fixa `designAgent`, mas a entrega TUI já existe | seletor fica no overlay; Send reusa entrega |
| entrega | prompt Markdown → PTY | `agent.input` chega a `sendSubmittedLine` com perfil de composer (`src/engine-service/extensionOperationService.ts:78,340-342`; `src/agents/agentInputService.ts:15-41`) | nenhuma nova porta |
| proteção TUI | elegibilidade e entrega pós-ready | escada t-a5b186 + recusa de draft + recibo | reusar integralmente |
| markup | overlay do renderer sobre screenshot; PNG clipboard | screenshot CDP existe, mas não editor de markup | implementar canvas no bundle de página; saída PNG |
| viewport | chrome do browser | quatro presets já estão no webview, e CDP aplica métricas (`src/webview/design-mode/App.tsx:9-13,39-43`; `cdpSession.ts:142-186`) | preservar backend; mover os quatro controles ao overlay |
| conversa | não participa das annotations | aba Preact com histórico/composer/reply | retirar da função e depois apagar o contrato de reply específico |

## A conta honesta da superfície de página

### O que foi ganho ontem

Antes do híbrido D, o inject tinha 1.657 linhas de corpo e 1.470 eram chrome que saiu da página
(`docs/specs/488-ide-browser-design-mode/hybrid-d-path.md:18-51,222-239`). No tree atual,
`designModeInject.ts` inteiro tem **30 linhas**. A F6 enumerou seis famílias/portas de eval: eval
HTTP/MCP, click codificado, inject/re-inject, push de chat e probes/fila; depois do híbrido, o push
`window.__tachyonDmChatPush` morreu e virou host→webview postMessage
(`docs/specs/488-ide-browser-design-mode/notes.md:220-226`). Contando HTTP e MCP como as duas entradas
que a F6 separou, há hoje **cinco** famílias que chegam a `Runtime.evaluate`.

### O que o número de linhas diz — e o que não diz

Uma cópia literal das duas strings do Orca recolocaria **965 linhas** de runtime de página só para
pick + badges, **32,2×** as 30 linhas atuais. Mas esse multiplicador não é argumento para negar UI na
página. Ele mede fonte manual injetada, não complexidade de um artefato compilado. O número que
importa para a decisão é: 1.657 linhas antigas eram um programa escondido numa string TypeScript;
1.470 delas eram chrome sem fronteiras de componente. Um bundle Preact de tamanho semelhante é
testável como componentes antes de virar artefato e não tem a mesma dívida estrutural.

### O preço do overlay compilado proposto

O overlay novo reúne:

- modelo serializável de annotations no host;
- app Preact de página: picker, popover, badges, tray, agentes, preview PNG, presets e markup;
- eventos page→host `annotation.add/delete/send`, pelo binding/fila existente;
- um push host→page para restaurar o lote depois de re-inject/navigation.

Não há implementação, portanto não existe contagem honesta do bundle final. **Não deve haver teto de
linhas de UI injetada.** O ratchet correto é estrutural: `designModeInject.ts` deixa de conter markup,
CSS ou aplicação manual; ele somente lê o artefato gerado e chama seu `mount(config)`. Tamanho do
bundle deve ser medido em bytes no build/metafile e acompanhado como custo de carregamento, não usado
como substituto de arquitetura.

Em eval, a proposta reutiliza inject/re-inject e binding/fila e acrescenta **uma** família
host→page, `__tachyonDmOverlay.sync(JSON)`, para estado/restore. Resultado: volta de cinco para
**seis famílias**, mas não reabre chat push nem texto de agente na página. Presets e Send saem pelo
binding existente; respostas do host (roster, estado, recibo, PNG) voltam pela única porta de sync.

## Como o bundle é construído e injetado

O repositório já compila Preact para browser. `esbuild.mjs:228-243` define a base browser (`platform:
browser`, JSX automático/Preact, target ES2020) e `:295-319` monta os apps webview. O overlay deve
reusar essa base, mas **não** entrar no grafo ESM com chunks dos webviews: uma página arbitrária não
consegue buscar `dist/webview/chunks/*`, e CDP precisa de um artefato autocontido.

Desenho do build:

1. novo entrypoint `src/webview/design-mode-overlay/main.tsx`, com `App`, hooks, protocolo tipado e
   estilos de overlay;
2. novo target em `esbuild.mjs`, derivado da base Preact, `bundle: true`, `platform: "browser"`,
   `format: "iife"`, `splitting: false`, `minify` igual aos builds existentes, saída única
   `dist/webview/design-mode-overlay.js`;
3. um loader do target importa `overlay.css` como módulo de texto; o mount põe esse texto em
   `style.textContent` dentro do ShadowRoot. Assim CSS entra no próprio artefato sem `<link>`,
   `innerHTML` ou chunk relativo que a página precise resolver;
4. o target entra em `targets` (`esbuild.mjs:560-565`), no typecheck browser e no fechamento do VSIX;
   o metafile registra bytes do artefato para a conta de custo;
5. testes importam `App`/reducers/protocolo diretamente; preview harness monta o mesmo App a 880 e
   360. O IIFE recebe apenas um smoke de install/cleanup, não testes por grep de string.

Desenho do runtime:

1. a extensão lê e cacheia `dist/webview/design-mode-overlay.js` a partir de `extensionUri`; falha
   fechado se o artefato não existe — nunca recompila em runtime;
2. `setDesignMode(true)` continua habilitando Page/Runtime e registrando o binding antes do install
   (`src/webview/ide-browser-bridge/cdpSession.ts:529-575`);
3. uma única `Runtime.evaluate` executa o IIFE e chama
   `globalThis.__tachyonDmOverlay.mount({bindingName, theme, initialState})`; configuração e estado
   entram por `JSON.stringify`, nunca por concatenação de texto da página;
4. mount cria um host com ShadowRoot, instala Preact e devolve versão/capabilities. Re-inject primeiro
   chama `unmount`, depois executa o mesmo artefato e sincroniza estado;
5. presença testa `__tachyonDmOverlay.version`, não um seletor visual; cleanup remove listeners,
   observers, RAFs, shadow host e globals;
6. navegação, reload e reconnect passam pela mesma porta de install + sync já usada pelo ciclo CDP.

O bundle continua sendo JavaScript avaliado por CDP — isso é inevitável para UI dentro da página —,
mas deixa de ser JavaScript **autorado como string** dentro do host. Fonte, build, artefato e install
viram quatro objetos auditáveis.

## Desenho concreto

### Fluxo humano

1. O status item ativa Design Mode e arma o picker fino.
2. Hover continua mostrando outline/rótulo; click captura DOM + crop PNG via CDP.
3. Um popover na página pede texto e intenção Change/Question. Add grava no host, recebe índice e
   mostra badge. O tray da página lista número, preview, rótulo, comentário e delete.
4. O tray contém o seletor dos agentes vivos/aptos. A página não decide elegibilidade: o host envia
   o roster e valida novamente o id escolhido no momento do Send.
5. Send posta `{action:'annotation.send', targetAgent}`. O host monta **um** prompt Markdown com todas
   as anotações e caminhos PNG,
   passa pela mesma proteção de draft/atenção/perfil de composer e `sendSubmittedLine`, e só então
   limpa o lote mediante recibo confirmado.

Ator × gatilho: humano cria/adiciona/remove/envia; navegação/reload/reconnect faz o Tachyon reinjetar
e ressincronizar; re-render/scroll/resize reposiciona por seletor quando possível e marca “alvo não
reencontrado” quando não; agente apenas recebe o lote no TUI. Nenhum desses caminhos cria uma
conversa paralela.

### Destino da captura que hoje aparece no chat

A captura **não morre** com o chat. `writePickScreenshot` continua sendo a fonte. O popover/tray do
overlay mostra o thumbnail; o host fornece os bytes/URL segura pela porta de sync, e o valor durável
é o caminho do PNG no item da anotação. O
formatador inclui `Screenshot: <path>` por item no lote entregue. Isso conserva exatamente a função
que landou em `t-49ef22` — contexto visual do elemento — sem transformar o lote em mensagens.

Essa é uma divergência deliberada do Orca. Ele descarta screenshots da anotação persistida para não
guardar megabytes por seleção (`orca:src/renderer/src/components/browser-pane/BrowserPane.tsx:340-348`)
e compensa com um payload textual muito mais rico: acessibilidade, caminhos, vizinhança, React/source,
estilos e HTML (`orca:src/renderer/src/components/browser-pane/browser-annotation-output.ts:171-223`). O pick atual do Tachyon captura tag,
id, classe, texto, HTML, bounds e 18 estilos (`src/webview/ide-browser-bridge/designModeInject.ts:4,21`),
mas texto não preserva sobreposição, clipping, hierarquia visual, pseudo-elementos, canvas, imagens
ou o aspecto exato no viewport. O PNG recém-landado cobre justamente essa lacuna e já viaja como
**caminho**, não como base64 no composer.

Mantê-lo não significa persistência sem limite: um lote conserva no máximo um crop delimitado por
anotação, com orçamento de bytes/quantidade e limpeza junto do lote após entrega confirmada ou Clear.
Se a captura falhar, a anotação textual continua válida. Assim a imagem é contexto visual
complementar e degradável, não uma cópia acidental do chat nem requisito para Send.

### Destino dos quatro presets de viewport

O backend CDP e os quatro valores Phone 375×812, Tablet 768×1024, Desktop 1280×800 e Reset ficam.
A UI sai da aba de chat e **desce para a toolbar do overlay** com os mesmos quatro botões e estado
ativo. O clique manda `{action:'viewport.set', preset}` ao host; só o host chama
`cdpSession.setResponsivePreset`, e o sync devolve sucesso/erro + preset efetivo. Assim o trabalho de
`t-0807b2` é preservado inteiro: mesmos valores, mesmo backend CDP, nova morada na página.

### Markup no overlay

O botão Markup captura o viewport por CDP e o próprio bundle troca para um canvas sobre a imagem
congelada. Os shapes ficam vetoriais enquanto editáveis; Copy/Send pede ao host que persista o PNG
composto. Copy mantém a semântica Orca; Send usa o agente selecionado e a mesma escada TUI, com o
caminho do PNG. Isso pode aumentar o bundle, e está correto: é componente testável, não uma string
manual. O canvas nunca precisa observar ou reescrever DOM da aplicação inspecionada.

## O que morre, o que não se reconstrói

Morre a aba de chat do Design Mode: `DesignModePanel`, histórico, composer, espera de reply e a
obrigação de o agente chamar `design_mode_chat_reply`. Não se cria uma barra lateral substituta.
`src/webview/design-mode/App.tsx` não sobrevive como segundo app: componentes úteis de agent selector,
selection preview e viewport são movidos ao novo entrypoint; depois o entry `design-mode` sai de
`WEBVIEW_APP_VIEWS` (`esbuild.mjs:308`) e de `WEBVIEW_APPS` (`src/webview/webviewApps.ts:95`). O host
mantém somente controller/store/protocolo do overlay, não um webview visual.

Continuam: Integrated Browser do VS Code via CDP, crop PNG, ferramentas `ide_browser_*`, presets CDP
e a entrega TUI existente. O inject fino é absorvido pelo bundle Preact; não fica como segunda
implementação. Não entra Chromium embarcado, arquivo de conversa ou segundo mecanismo de submit.

## Limites e verificações exigidas numa eventual implementação

- Dois widths para a UI in-page: 880 e 360; badges e tray não podem bloquear a página inteira.
- Fail-before estrutural: o host não contém markup/CSS de overlay, o artefato é IIFE autocontido sem
  imports/chunks, e não existe `DesignModePanel`/chat/composer/reply após o cutover.
- Registrar bytes minificados do bundle e portas de eval; não usar linhas como veto de UI.
- Testes pelos gatilhos humano create/add/delete/send; navigation/reload/reconnect; scroll/resize;
  re-render com seletor reencontrado e alvo perdido.
- Entrega precisa cobrir destino vivo, destino que ficou stale, composer ocupado, recibo não
  confirmado e agente novo; limpar annotations apenas no recibo confirmado.
- Gate visual deve mostrar seletor de agente, quatro presets e preview PNG dentro do overlay.
