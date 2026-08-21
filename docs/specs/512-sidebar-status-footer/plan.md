# 512 — sidebar-status-footer — plan

_Drafted from `spec.md` on 2026-08-17. The approach, not the steps (those go in `tasks.md`)._

## Approach

O trabalho é trocar **um provedor**, não varrer chamadas. `NotificationService` já expõe
`UiNotificationPort` e `VsCodeNotificationProvider` é a única implementação
(`apps/vscode-extension/src/workspace/notify.ts`). As ~288 chamadas de `notify()` ficam intocadas.

O aviso deixa de ser evento de UI e passa a ser **estado projetado**, no mesmo caminho que a sidebar
já usa: `buildSidebarFleet` monta a projeção *"at the operational authority, never in the editor
shell"*, e `SidebarPrototype.ts:219` entrega por `postMessage`. O rodapé lê dessa projeção.

Essa escolha responde de graça duas perguntas abertas da spec: a mensagem sobrevive à sidebar fechada
porque o estado vive no engine, e sobrevive ao reload porque a projeção é remontada.

## Key decisions

- **O aviso vira estado projetado, não evento de UI** — escolhido porque o critério de aceitação
  exige que um `error` não se perca com a sidebar fechada, e evento entregue por `postMessage` a uma
  webview que não existe se perde por definição. Rejeitado *o provedor postar direto na webview da
  sidebar*: seria mais curto e teria exatamente o defeito que o cartão nasceu para consertar — falar
  para uma superfície que pode não estar lá.

- **O rodapé é região fixa da sidebar, fora do roteamento de abas** — o dono pediu *"footer da sidebar
  fixo e visível (fora das tabs)"*. Rejeitado *uma aba nova*, que esconderia o aviso atrás de um
  clique, e *uma linha dentro de cada aba*, que multiplicaria a mesma verdade por superfície.

- **Modal continua nativo, e não está em revisão** — decisão do spec 415. Tocar nisso é mudar
  autoridade de notificação, não trocar superfície.

- **Notificação com ação continua em `showQuickPick`, por ora** — o comentário de `notify.ts` dá o
  motivo e ele continua válido: *"A product picker needs somewhere to draw; this caller cannot promise
  one."* Com o rodapé às vezes há onde desenhar e às vezes não, e **palpite sobre visibilidade é
  exatamente a classe de defeito desta casa**. Rejeitado *mandar a ação para o rodapé agora*: só se
  justifica quando a visibilidade da sidebar for fato consultável, e isso é outro cartão.

- **O nível vem do dado, não da cor** — `error`, `warn`, `info` chegam como campo. Rejeitado
  *inferir o nível do texto ou do ícone*, que é derivar verdade de aparência.

- **A última mensagem fica até ser substituída ou dispensada** — sem temporizador. O defeito que o
  dono viu é literalmente *"erased on a timer"*. Um rodapé que apaga sozinho reintroduz o problema com
  outra pintura.

- **Fatia 4 substituída por t-53f20d (decisão do dono, 2026-08-20).** Os dois ícones não vão para o
  rodapé. `StatusNoticeFooter` não renderiza nada sem aviso para preservar a altura da lista; controles
  permanentes quebrariam essa guarda, e controles condicionados a um aviso apareceriam e sumiriam.
  O dogfood do dono substituiu o app por uma ação do ladrilho: gate desligado abre e destaca Settings;
  gate ligado arma e abre o browser; fechar o browser desarma. URL e CDP vivem no System. O rodapé
  continua sendo uma superfície de mensagem, não uma toolbar.

- **Nada de centro de notificações** — o rodapé mostra a atual e o histórico recente. O Human Inbox já
  é o lugar do que exige ação. Rejeitado *fila com badge de não lidos*: máquina é último recurso, e o
  dono já disse que alerta sem ação não serve.

## Files touched

**A porta e o provedor — o coração da mudança:**

- `apps/vscode-extension/src/workspace/notify.ts` — o branch `setStatusBarMessage` sai; o provedor
  passa a empurrar o aviso para o estado projetado. Os branches modal e `actions` ficam.
- `apps/vscode-extension/src/workspace/NotificationService.ts` — se precisar de forma nova no
  `NotificationRequest`; só se precisar.

**Engine — o estado, sem `vscode`:**

- `packages/engine/src/sidebar/` — o aviso corrente entra na projeção que `buildSidebarFleet` monta.
- `packages/engine/src/runtime-api/sidebarProjection.ts` — o contrato versionado ganha o campo.

**Webview — o rodapé:**

- `packages/webview-ui/src/webview/sidebar/App.tsx` — a região fixa, fora do roteamento de abas.
- `packages/webview-ui/src/webview/sidebar/sidebar.css` — escala herdada do host, como a 0.93.7
  estabeleceu; nada de valor escolhido nesta tela.

**Fatia 4 substituída (não pertence a esta implementação):**

- t-53f20d remove os dois `StatusBarItem`; a afordância passa para a ação Design Mode do launcher,
  enquanto URL e CDP passam para o System. Nenhum controle do IDE Browser entra no rodapé.

## Risks & unknowns

- **A sidebar fechada é o caso que decide o desenho.** Se o estado vive no engine, o aviso sobrevive;
  se alguém encurtar o caminho e postar direto na webview, o critério de aceitação quebra em silêncio.
  **Verificar cedo, com a sidebar fechada de verdade.**
- **Volume.** ~288 chamadas alcançam `notify()`. Não sei quantas disparam por minuto em uso real.
  Se for alto, o rodapé vira piscadeira. **Medir antes de desenhar histórico** — e a guarda de custo
  por tick é a lição da 0.93.5.
- **Truncar por largura é o defeito original.** O rodapé é estreito. Se a solução for cortar com
  reticências e nada mais, trocamos uma célula que corta por outra que corta. Precisa de caminho para
  o texto inteiro.
- **`packages/webview-ui/src` não pode importar `vscode`**, em valor e em tipo. Spec 233, tolerância
  zero, verificável por `scripts/check-engine-boundary.sh`.
- **Perder mensagem na transição.** Enquanto o provedor muda, existe janela em que um aviso não vai
  para lugar nenhum. Preferir que ele apareça nos dois lugares a que suma de um.

## Visual impact

Muda a sidebar: ganha uma faixa fixa no rodapé, presente em todas as abas. Some a fala do Tachyon na
status bar do VS Code, e somem dois ícones de lá.

O que pode ficar errado: o rodapé comendo altura de lista quando a sidebar é curta; mensagem de
`error` competindo com o conteúdo por atenção; e texto longo virando reticências sem saída.

A prova a capturar: a sidebar em duas larguras, com uma mensagem curta e uma longa, e um `error`
visível ao mesmo tempo que a lista de agentes.

## Sources consulted

- `apps/vscode-extension/src/workspace/notify.ts` — o provedor, os quatro branches, e o comentário do
  spec 415 sobre modal e sobre `showQuickPick`.
- `packages/engine/src/agents/AgentManager.ts:570` e
  `packages/engine/src/harness/HarnessManager.ts:1400` — o projeto criticando `setStatusBarMessage`
  por escrito, e o caso perdido de 2026-08-07.
- `apps/vscode-extension/src/webview/ide-browser-bridge/register.ts:61-112` — os dois
  `StatusBarItem` e a exigência de adjacência.
- `packages/engine/src/sidebar/sidebarFleetService.ts:109` — *"Builds the complete sidebar projection
  at the operational authority, never in the editor shell."*
- `apps/vscode-extension/src/webview/SidebarPrototype.ts:79,219` — o `postMessage` que entrega.
- `scripts/check-engine-boundary.sh` — spec 233.
- Medição original: 288 pontos alcançam `notify()`; 1 `setStatusBarMessage`; 2 `StatusBarItem`
  persistentes. t-53f20d removeu os dois pela superfície substituta descrita acima.
