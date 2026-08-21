# 514 — user-apps-zip-install — tasks

_Gerado de `plan.md` em 2026-08-21. De cima para baixo. Se uma tarefa revelar que o plano está errado, corrija `plan.md` antes de seguir._

## Medição primeiro

- [ ] **T0 — resolver R1 antes de escrever qualquer código.** Medir como uma chamada sai da webview e chega numa ferramenta do Bridge, sabendo que o Bridge vive no daemon do engine (`packages/bridge/src/daemonMain.ts`) e não no extension host. Responder no `notes.md`, com caminho e linha: (a) o extension host já tem cliente do workspace bridge, ou o salto precisa nascer? (b) que identidade de chamador um app apresenta, dado que `createMcp` recebe `caller` e o `lifecycleScopeGuard` recusa alvo fora da linhagem? **Se não houver caminho barato, PARE e diga — a spec muda, não o código.**

## Implementação

- [ ] **T1** — `packages/engine/src/apps/`: o tipo `InstalledApp` e o leitor que varre `.tachyon/apps/*/app.json`. Diretório ilegível vira aviso na lista de resultado, nunca exceção. Sem cache, sem índice: o disco é a fonte.
- [ ] **T2** — validação de `app.json`: `id` (kebab minúsculo), `title`, `icon` (caminho relativo contido), `entry` (caminho relativo contido, arquivo existe). Erro nomeia o campo.
- [ ] **T3** — instalação por zip: descompacta em temporário, valida por T2, move para `.tachyon/apps/<id>/` substituindo o que houver. Falha em qualquer ponto não deixa diretório parcial. Aplicar a decisão de R2 sobre contenção de caminho, com o comentário dizendo que é higiene e não barreira.
- [ ] **T4** — `SectionId` admite `` `app:${string}` ``. Conferir que o invariante de `sectionNav.ts:118` não é atingido, já que app não é renderizado pelo Control.
- [ ] **T5** — as três tabelas concatenam linhas de runtime: `LAUNCHER_ORDER` vira prefixo fixo das doze; `WEBVIEW_APPS` recebe as linhas de app; `controlSectionIcon` desvia para o ícone-imagem quando o id começa com `app:`. Os `throw` do caminho literal ficam; o caminho de runtime avisa.
- [ ] **T6** — o ladrilho de app abre a aba pelo `SectionPanelManager` com cardinalidade `dashboard`, servindo o `entry` de `.tachyon/apps/<id>/`.
- [ ] **T7** — `window.tachyon.call(nome, args)` na página, sobre o caminho que T0 mediu. Sem allowlist. Erro volta para a página e morre lá.
- [ ] **T8** — ação Adicionar na aba Apps: seletor de arquivo, chamada da instalação, e o que falhou dito na tela.
- [ ] **T9** — o relay perde a montagem de `srcdoc` e o `connect-src 'none'` no caminho de app.
- [ ] **T10** — `views` sai de `KNOWN_FIELDS` (`manifest.ts:213`) com erro que nomeia o campo removido e aponta o caminho de app. `VIEW_FLEET_SCOPES` sai.
- [ ] **T11** — remover `apps/vscode-extension/src/plugins/ui/broker.ts`, `PLUGIN_UI_ACTIONS` e o modo `plugin` de `untrustedSrcdoc.ts`. Os testes que afirmavam esse comportamento saem junto ou viram a asserção nova — nenhum fica silenciado.
- [ ] **T12** — `docs/specs/349-plugin-ui-surfaces/spec.md` recebe `**Status:** superseded` apontando para a 514.
- [ ] **T13** — reempacotar o Terrarium como app (trabalho em `github:cfpperche/terrarium`), instalar pelo zip e conferir que ele abre pelo ladrilho.

## Verification

- [ ] instalar zip válido cria `.tachyon/apps/<id>/` e o ladrilho aparece sem reload
- [ ] reinstalar o mesmo id substitui o diretório sem prompt
- [ ] zip sem `app.json`, com `app.json` ilegível, ou sem o `entry` declarado: avisa e não deixa diretório parcial
- [ ] `app.json` corrompido no disco não impede o startup; o app some do launcher com aviso e o resto sobe
- [ ] clicar no ladrilho abre a aba; clicar de novo revela a mesma aba
- [ ] `window.tachyon.call("list_agents", {})` devolve à página o mesmo que a ferramenta devolve a um agente
- [ ] chamada a ferramenta inexistente volta como erro para a página, sem tela de erro do Tachyon e sem retry
- [ ] `loadManifest` recusa um `tachyon-plugin.json` com `views`, nomeando o campo
- [ ] `grep` por `PLUGIN_UI_ACTIONS`, `broker`, `VIEW_FLEET_SCOPES` e o modo `plugin` do `srcdoc` volta zero no código de produção
- [ ] a ordem de produto das doze embutidas não mudou, e arrastar continua funcionando com ladrilho de app na grade

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
6. Instalar o Terrarium reempacotado e abrir pelo ladrilho.

## Visual QA

Superfície: a grade do launcher, que passa a misturar codicon monocromático (as doze embutidas) com imagem colorida (os apps); e a aba Apps, que ganha a ação Adicionar.

Risco visual: tamanho e alinhamento óptico do ícone-imagem contra os codicons, e o comportamento no tema claro. Grade estreita com muitos apps.

- [ ] Evidence:
- [ ] Verdict:

## Cookbook

**Cookbook:** yes
<!-- superfície de operador nova: como empacotar um app (app.json, entry, ícone), como instalar,
     e o que `window.tachyon.call` alcança. Escrever no ship, com sdd-cookbook.sh 514. -->
