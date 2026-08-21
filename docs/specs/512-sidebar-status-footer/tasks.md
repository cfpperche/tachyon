# 512 — sidebar-status-footer — tasks

_Generated from `plan.md` on 2026-08-17. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

**Fatia 0 — medir o volume antes de desenhar. Nada começa antes disso.**

- [x] Quantos `notify()` disparam por minuto em uso real? ~288 pontos alcançam a porta, e eu não sei
      a taxa. Instrumentar ou amostrar uma sessão de trabalho. **Se for alto, o rodapé vira
      piscadeira e o desenho do histórico muda.** Declarar a amostra.
- [x] Qual a distribuição por nível — `info`, `warn`, `error`? Ela decide o que merece persistir.

**Fatia 1 — o estado no engine, sem `vscode`.**

- [x] O aviso corrente entra na projeção que `buildSidebarFleet` monta, com nível como **campo**,
      nunca inferido de texto ou ícone.
- [x] `runtime-api/sidebarProjection.ts` — o contrato versionado ganha o campo.
- [x] Provar zero `vscode` em `packages/engine/src` e `packages/webview-ui/src`:
      `bash scripts/check-engine-boundary.sh`.

**Fatia 2 — o rodapé.**

- [x] Região fixa em `sidebar/App.tsx`, **fora do roteamento de abas**.
- [x] Escala herdada do host em `sidebar.css` — nada de valor escolhido nesta tela; a 0.93.7
      estabeleceu isso e a 511 manteve.
- [x] Sem temporizador: a última mensagem fica até ser substituída ou dispensada.
- [x] Caminho para o texto inteiro quando ele não cabe. **Cortar com reticências e mais nada é trocar
      uma célula que corta por outra que corta.**

**Fatia 3 — o provedor troca de destino.**

- [ ] `notify.ts` — o branch `setStatusBarMessage` sai; o aviso vai para o estado projetado.
- [ ] Os branches `modal` e `actions` ficam **intactos**.
- [ ] `vscode.window.setStatusBarMessage` deixa de existir no produto. Provar por busca, olhando o
      contexto de cada hit — substring engana.

**Fatia 4 — substituída por t-53f20d (decisão do dono, 2026-08-20).**

- [x] Os dois `StatusBarItem` saem da status bar nativa. O ladrilho Design Mode vira ação: gate off
      abre Settings com o campo destacado; gate on arma e abre o browser; fechar o browser desarma.
      URL e CDP aparecem no System. Nada vai para o rodapé: `StatusNoticeFooter` continua exclusivo
      para avisos e continua sem renderizar quando não há aviso.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [ ] Mensagem sem ação aparece no rodapé com o nível visível, e **não** na status bar do VS Code
- [ ] Passa de oito segundos e a mensagem continua lá
- [ ] Texto mais longo que a largura fica alcançável por inteiro
- [ ] A mensagem sobrevive à troca de aba
- [ ] **Com a sidebar fechada**, um `error` não se perde: ao reabrir, o dono o encontra
- [ ] `modal: true` continua nativo
- [ ] Notificação com `actions` continua com controle clicável
- [ ] Zero `vscode` em `packages/engine/src` e `packages/webview-ui/src`
- [ ] Nenhuma das ~288 chamadas de `notify()` mudou

**Headless check:** `npm run verify:full`

**Verify:** `bash scripts/check-engine-boundary.sh`
**Verify:** `npm test`

## Dogfood

**Dogfood:** `npm test`
<!-- O aviso vira estado projetado por funções puras do engine; nível, persistência e substituição
     são exercitáveis sem UI. O que exige olho humano está no Human dogfood. -->

**Human dogfood:**

1. Abrir a sidebar e disparar algo que hoje fala na status bar — por exemplo abrir **Review Changes**
   num agente sem mudanças, que emite *"Nothing to review"*
2. Conferir que a mensagem aparece no rodapé e **não** na status bar do VS Code
3. Esperar mais de oito segundos: ela continua
4. Trocar de aba: ela continua
5. **Fechar a sidebar, provocar um `error`, reabrir**: ele está lá
6. Conferir que os dois ícones do IDE Browser saíram da status bar nativa; t-53f20d verifica a ação
   Design Mode do launcher e URL/CDP no System. O rodapé não recebe esses controles.

## Visual QA

- [ ] Evidence: a sidebar em duas larguras, com uma mensagem curta e uma longa, e um `error` visível ao
      mesmo tempo que a lista de agentes
      (fatia 2 captured the footer half at 880/360 in `.tachyon/visual-qa/t-bd9fb8-sidebar-status-footer/`)
- [ ] Verdict:

## Cookbook

**Cookbook-Opt-Out:** a superfície é leitura passiva do dono na própria sidebar; não há tool, CLI nem
ciclo de vida que outro operador precise invocar.
