# Design Mode sem chat próprio: o que o Orca realmente faz e o desenho para o Tachyon

_2026-08-13. Task `t-200636`. Pesquisa de fonte e proposta; nenhuma mudança em `src/`._

## Veredito

O comentário do dono está certo sobre a **forma**: o chat próprio não é necessário para esta função.
O Orca acumula anotações ligadas a elementos, forma um único prompt Markdown, deixa o humano escolher
um agente no momento do **Send** e entrega o texto no terminal daquele agente. Não há conversa,
arquivo de protocolo nem chamada direta a provedor nessa passagem.

Para o Tachyon, porém, copiar literalmente a implantação do Orca seria desfazer demais do híbrido D.
A proposta concreta é:

1. **matar a aba/chat do Design Mode**;
2. manter na página somente pick, popover curto, badges e uma bandeja resumida;
3. ao apertar **Send**, abrir um Quick Pick do VS Code com os agentes vivos e entregar o lote pela
   escada TUI que já existe;
4. manter a captura PNG de cada pick como anexo do lote, não como “mensagem no chat”;
5. mover os quatro presets de viewport para um Quick Pick no item de status do Design Mode;
6. fazer markup sobre uma captura em um editor webview temporário e enviar/copiar o PNG composto.

Isso preserva a experiência “marque na página, envie ao terminal escolhido” sem recriar conversa,
sem Chromium embarcado e sem inventar canal de entrega.

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
| hover/pick | runtime injetado de 794 linhas | inject fino de **30 linhas**, hit-test, outline e captura (`src/webview/ide-browser-bridge/designModeInject.ts:1-30`) | reusar; não trocar |
| PNG do elemento | annotations descartam imagem | `writePickScreenshot` grava crop e o caminho entra no prompt (`src/webview/ide-browser-bridge/manager.ts:342-384`; `pick.ts:190-192`) | preservar e ligar à anotação |
| anotação acumulável | até 20 por aba, popover + badges + tray | existe apenas `lastPick`/selection anexada ao chat | falta store de lote + UI mínima |
| destino | humano escolhe agente vivo no Send | Design Mode fixa `designAgent`, mas a entrega TUI já existe | trocar a escolha para Send; reusar entrega |
| entrega | prompt Markdown → PTY | `agent.input` chega a `sendSubmittedLine` com perfil de composer (`src/engine-service/extensionOperationService.ts:78,340-342`; `src/agents/agentInputService.ts:15-41`) | nenhuma nova porta |
| proteção TUI | elegibilidade e entrega pós-ready | escada t-a5b186 + recusa de draft + recibo | reusar integralmente |
| markup | overlay do renderer sobre screenshot; PNG clipboard | screenshot CDP e webviews já existem, mas não editor de markup | falta editor temporário sobre PNG |
| viewport | chrome do browser | quatro presets já estão no webview, e CDP aplica métricas (`src/webview/design-mode/App.tsx:9-13,39-43`; `cdpSession.ts:142-186`) | preservar backend; mover entrada |
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

### O preço de copiar o Orca

Uma cópia literal recolocaria **965 linhas** de runtime de página só para pick + badges (e ainda
precisaria implementar popover/tray no realm da página, porque o React externo do Orca não cabe por
cima do editor-browser). Isso multiplica a superfície atual por **32,2×** (965 / 30), antes da UI de
anotação. É uma conta ruim.

### O preço do híbrido proposto

O híbrido mantém o extrator atual e acrescenta apenas:

- modelo serializável de annotations no host;
- no inject: popover curto, badges e tray resumido;
- eventos page→host `annotation.add/delete/send`, pelo binding/fila existente;
- um push host→page para restaurar o lote depois de re-inject/navigation.

Não há implementação ainda, portanto não finjo uma contagem exata. O contrato deve ter um teto de
**300 linhas totais no `designModeInject.ts`**: no máximo +270 sobre as 30 atuais, **3,2× menor** que
os 965 do par Orca e **5,5× menor** que o corpo antigo de 1.657. Se popover + badges + tray não couberem
nesse teto, o tray sai da página e vira Quick Pick; não se aumenta silenciosamente o inject.

Em eval, a proposta reutiliza inject/re-inject e binding/fila e acrescenta **uma** família
host→page, `__tachyonDmAnnotationsSync(JSON)`, para restauração. Resultado: volta de cinco para
**seis famílias**, mas não reabre chat push nem texto de agente na página. Badge totalmente local
evitaria essa porta, porém perderia navegação/re-inject; é a economia errada.

## Desenho concreto

### Fluxo humano

1. O status item ativa Design Mode e arma o picker fino.
2. Hover continua mostrando outline/rótulo; click captura DOM + crop PNG via CDP.
3. Um popover na página pede texto e intenção Change/Question. Add grava no host, recebe índice e
   mostra badge. O tray da página lista só número, rótulo curto, comentário e delete.
4. Send posta apenas `{action:'annotation.send'}`. O host abre Quick Pick com agentes vivos/aptos.
5. Escolhido o destino, o host monta **um** prompt Markdown com todas as anotações e caminhos PNG,
   passa pela mesma proteção de draft/atenção/perfil de composer e `sendSubmittedLine`, e só então
   limpa o lote mediante recibo confirmado.

Ator × gatilho: humano cria/adiciona/remove/envia; navegação/reload/reconnect faz o Tachyon reinjetar
e ressincronizar; re-render/scroll/resize reposiciona por seletor quando possível e marca “alvo não
reencontrado” quando não; agente apenas recebe o lote no TUI. Nenhum desses caminhos cria uma
conversa paralela.

### Destino da captura que hoje aparece no chat

A captura **não morre** com o chat. `writePickScreenshot` continua sendo a fonte. O popover/tray pode
mostrar um thumbnail host-served, mas o valor durável é o caminho do PNG no item da anotação. O
formatador inclui `Screenshot: <path>` por item no lote entregue. Isso conserva exatamente a função
que landou em `t-49ef22` — contexto visual do elemento — sem transformar o lote em mensagens.

### Destino dos quatro presets de viewport

O backend CDP e os quatro valores Phone 375×812, Tablet 768×1024, Desktop 1280×800 e Reset ficam.
A UI sai da aba de chat: click secundário/command no item “Design Mode” abre Quick Pick “Viewport”
com os quatro presets e mostra o ativo no status/tooltip. Não devem voltar ao inject: viewport é
controle do browser/host, não propriedade da página. Assim o trabalho de `t-0807b2` é preservado em
vez de descartado.

### Markup sem inflar a página

O botão Markup captura o viewport por CDP e abre um editor webview temporário com canvas. O humano
desenha vetores localmente; Copy/Send rasteriza para PNG. Copy mantém a semântica Orca; Send usa o
mesmo Quick Pick de agente e a mesma escada TUI, com o caminho do PNG. Desenhar diretamente sobre a
página exigiria outro canvas/listeners no inject e empurraria a conta para perto do Orca; não vale a
superfície só para preservar a ilusão de página viva sobre uma imagem que, no Orca, já é congelada.

## O que morre, o que não se reconstrói

Morre a aba de chat do Design Mode: histórico, composer, espera de reply e a obrigação de o agente
chamar `design_mode_chat_reply`. Não se cria uma barra lateral substituta. Antes de apagar, o
formatador de lote, o seletor de destino, o thumbnail do pick e a entrada dos presets precisam estar
ativos; caso contrário seria remoção de função, não mudança de forma.

Continuam: Integrated Browser do VS Code via CDP, inject fino, crop PNG, ferramentas `ide_browser_*`,
presets CDP e a entrega TUI existente. Não entra Chromium embarcado, protocolo novo, arquivo de
conversa ou segundo mecanismo de submit.

## Limites e verificações exigidas numa eventual implementação

- Dois widths para a UI in-page: 880 e 360; badges e tray não podem bloquear a página inteira.
- Fail-before do teto de 300 linhas e da ausência de chat/composer/reply no inject.
- Testes pelos gatilhos humano create/add/delete/send; navigation/reload/reconnect; scroll/resize;
  re-render com seletor reencontrado e alvo perdido.
- Entrega precisa cobrir destino vivo, destino que ficou stale, composer ocupado, recibo não
  confirmado e agente novo; limpar annotations apenas no recibo confirmado.
- Gate visual deve mostrar também o Quick Pick de presets e o preview PNG fora do chat.

