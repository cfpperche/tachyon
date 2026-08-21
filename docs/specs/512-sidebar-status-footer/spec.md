# 512 — sidebar-status-footer

_Created 2026-08-17._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

O Tachyon fala com o dono pela status bar do VS Code, e essa superfície é ruim para o que temos a
dizer. Palavras dele: *"é muito ruim utilizar a statusbar do vscode pra se comunicar"*.

O projeto já sabia disso e escreveu duas vezes, sem consertar o caso geral:

> *"an action-less notice is precisely the branch that routes to
> `vscode.window.setStatusBarMessage(…, 8_000)` — clipped by width, erased on a timer, no button.
> **That is where the owner's `— run grok login first` went on 2026-08-07**"*
> — `packages/engine/src/agents/AgentManager.ts:570`

> *"the recovery instruction was clipped by the width of one status-bar cell and erased eight
> seconds later"* — `packages/engine/src/harness/HarnessManager.ts:1400`

Na época o conserto foi abrir um canal separado para **um** caso — o de autenticação de runtime. Os
outros ~288 pontos que chamam `notify()` continuam caindo na mesma célula que corta o texto e apaga
em oito segundos.

**Feito é:** o Tachyon tem a própria barra de status, fixa no rodapé da sidebar, fora das abas e
sempre visível quando a sidebar está aberta. Ela mostra o que a status bar do VS Code mostrava, sem
cortar por largura e sem apagar por temporizador — a última mensagem fica até ser substituída ou
dispensada.

A arquitetura já favorece isso: **tudo passa por uma porta só.** `NotificationService` expõe
`UiNotificationPort`, e `VsCodeNotificationProvider` é a única implementação. O trabalho é trocar um
provedor, não varrer 288 chamadas.

## Acceptance criteria

- [ ] **Scenario: a mensagem sem ação aparece no rodapé da sidebar**
  - **Given** a sidebar aberta em qualquer aba
  - **When** qualquer ponto do produto chama `notify(mensagem, nível)` sem ações
  - **Then** a mensagem aparece no rodapé da sidebar com o nível visível, **não** na status bar do
    VS Code

- [ ] **Scenario: o rodapé não some por temporizador**
  - **Given** uma mensagem exibida no rodapé
  - **When** passam mais de oito segundos sem nada novo acontecer
  - **Then** a mensagem continua lá

- [ ] **Scenario: texto longo não é cortado por largura**
  - **Given** uma mensagem mais longa que a largura da sidebar
  - **When** ela é exibida
  - **Then** o texto inteiro fica alcançável — o rodapé não trunca sem dar acesso ao resto

- [ ] **Scenario: o rodapé sobrevive à troca de aba**
  - **Given** uma mensagem no rodapé e a sidebar na aba de agentes
  - **When** o dono troca para outra aba
  - **Then** a mensagem continua visível: o rodapé é fixo, fora das abas

- [ ] **Scenario: sidebar fechada não engole a mensagem**
  - **Given** a sidebar fechada ou não visível
  - **When** uma mensagem de nível `error` é emitida
  - **Then** ela **não** se perde em silêncio — ao reabrir a sidebar o dono a encontra

- [ ] **Scenario: modal continua nativo**
  - **Given** uma notificação com `modal: true`
  - **When** ela é emitida
  - **Then** ela continua usando o diálogo nativo do VS Code, inalterada

- [ ] **Scenario: notificação com ação continua com controle clicável**
  - **Given** uma notificação com `actions`
  - **When** ela é emitida
  - **Then** o dono continua conseguindo escolher a ação; a ação **nunca** vira texto sem controle

- [x] Os dois `StatusBarItem` persistentes do IDE Browser saem da status bar do VS Code. A fatia 4
  foi substituída por t-53f20d: o ladrilho Design Mode é uma ação do host — gate desligado abre e
  destaca Settings; gate ligado arma e abre o browser; fechar o browser desarma. URL e CDP vivem no
  System. O rodapé continua reservado a avisos.
- [ ] `vscode.window.setStatusBarMessage` deixa de existir no produto
- [ ] `packages/webview-ui/src` segue com **zero** import de `vscode` — a fronteira do spec 233 não é tocada
- [ ] Nenhuma das ~288 chamadas de `notify()` precisa mudar

## Non-goals

- **Não substituir o diálogo modal.** O spec 415 decidiu que segurança modal fica nativa, e essa
  decisão não está em revisão aqui.
- **Não construir centro de notificações.** O rodapé mostra o estado atual e o histórico recente,
  não uma caixa de entrada. O Human Inbox já existe para o que exige ação do dono.
- **Não mexer nas ~288 chamadas.** Se a refatoração precisar tocar call site, o desenho está errado:
  a porta existe justamente para isso.
- **Não inventar regra de segurança.** O dono é usuário único.
- **Não tornar a mensagem bloqueante.** Aviso que não vira ação não deve exigir clique para sumir.

## Open questions

- **O que acontece com a notificação que tem `actions` quando a sidebar está visível.** Hoje ela vira
  `showQuickPick`, e o comentário em `notify.ts` justifica: *"A product picker needs somewhere to
  draw; this caller cannot promise one."* Com o rodapé, às vezes há onde desenhar e às vezes não.
  **Resolver no plano** — e a resposta segura é manter o QuickPick até que a visibilidade da sidebar
  seja um fato consultável, não um palpite.
- **Onde a mensagem vive enquanto a sidebar está fechada.** O critério de aceitação exige que um
  `error` não se perca, e isso implica guardar. Quanto guardar, e por quanto tempo, é decisão de
  desenho. **Resolver no plano, com medição de volume real.**
- **Os dois ícones do IDE Browser vão para o rodapé ou para outro lugar.** Eles são afordância
  clicável, não mensagem. O comentário do arquivo exige que fiquem **adjacentes**. **Resolver no
  plano.**
- **Se o rodapé é uma superfície nova ou uma região da sidebar existente.** Owner: claude, decidir no
  plano contra a estrutura atual de `packages/webview-ui/src/webview/sidebar/`.
