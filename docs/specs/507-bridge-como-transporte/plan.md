# SDD 507 — plano

Todo número vem da régua `scripts/research/measure-engine-bridge-imports.mjs`, medida em 2026-08-14 sobre `41f12294`.

## Decisões, e o que foi rejeitado

### D1 — a inversão vem antes do pacote, não depois

O instinto é criar `packages/bridge`, mover os arquivos e consertar o que quebrar. Isso não funciona aqui: enquanto o `Workspace.ts` fizer `new Bridge(...)`, o pacote nasceria com a engine declarando dependência do transporte — exatamente o contrário do que a SDD quer, e com um gate verde atestando o contrário do objetivo.

**Decisão:** inverter primeiro, dentro de `packages/engine`, até a régua marcar zero. Só então mover para um pacote. O movimento vira mecânico e o gate nasce dizendo a verdade.

**Rejeitado:** pacote primeiro. Custa uma exceção no `check:package-boundary` durante a transição, e uma exceção na fatia 1 é a prova de que o corte está errado — regra que a SDD 506 aplicou seis vezes.

### D2 — a engine expõe portas estreitas; o shell compõe

O `EngineHost` é o molde: a engine declara o que precisa do mundo, e quem tem o mundo implementa. Aqui é a mesma forma virada para o outro lado — a engine declara o que oferece a um transporte, e o transporte implementa contra isso.

**Quem instancia a `Bridge` passa a ser o composition root do app**, não a engine. Hoje é `Workspace.ts:1785`.

**Rejeitado:** injeção genérica por container. Maquinaria para um problema que três parâmetros resolvem, e o repositório já rejeitou isso antes.

**Rejeitado:** um port único e grande. Um contrato com 40 membros é a gaveta com nome melhor. O `EngineHost` tem 21 e cada um nasceu de necessidade medida.

### D3 — autenticação e ciclo de vida de cliente vão INTEIROS para o transporte

`token` (8 bindings), `callerIdentity` (6) e `clientRebind` (8) somam 22 das 31 arestas. Não são conceito emprestado: são o mecanismo pelo qual um cliente se conecta, prova quem é e se reconecta.

**A engine não deve ter opinião sobre nenhum dos três.** O que ela precisa é saber que uma requisição chegou e de quem — e isso é um dado no ponto de entrada, não um módulo importado.

### D4 — `stateMigration` é o ponto mais perigoso e ganha fatia própria

Ele migra estado persistido de token e rebind. Uma migração errada não falha no gate: falha no reload de alguém, depois, com sessão perdida.

**Decisão:** fatia isolada, com prova de leitura do estado antigo e do novo, antes e depois.

### D5 — a régua é o critério de pronto

Cada fatia roda `measure-engine-bridge-imports.mjs` e reporta. Chegar a zero é o aceite mecânico; o resto do desenho é julgamento e vai escrito.

## Ordem das fatias

Do mais barato e informativo para o mais caro, como na SDD 506.

    1  bridgeSlowRequestPolicy + AgentManager      2 arestas   prova o desenho
    2  extensionOperationService                   2 arestas
    3  stateMigration                              4 arestas   o perigoso, isolado
    4  Workspace: token, callerIdentity, rebind   17 arestas   o grosso
    5  Workspace: Bridge, derivePort, notifyAgent  6 arestas   a inversão do composition root
    6  packages/bridge nasce, gate impõe           0 arestas   movimento mecânico

**A fatia 1 é minúscula de propósito.** `bridgeSlowRequestPolicy` importa um tipo (`BridgeRequestCompleteInfo`) para observar requisições lentas, e `AgentManager` importa uma variável de ambiente. Se o desenho de porta estreita não servir para os dois casos mais simples, ele não serve para os outros, e descobrimos com 2 arestas em jogo.

## O que cada fatia tem de provar

- **Comportamento idêntico.** Nenhum teste de comportamento muda, só caminho e composição.
- **A régua andou.** De X para Y, com o script.
- **Nada afrouxou.** `check:package-boundary`, `check:engine-boundary` e `check-vscode-import-boundaries.mjs` verdes, exceções vazias.
- **As fatias 3, 4 e 5 provam autenticação.** Um teste que exercite conexão, identidade e rebind antes e depois. Errar aqui abre porta, não quebra teste.

## Riscos, e o que fazer quando acontecerem

- **O contrato incha.** Se passar de ~15 membros, pare e me avise: provavelmente a fronteira está no lugar errado, não o contrato pequeno demais.
- **A fatia 4 não cabe numa mudança.** 17 arestas em três mecanismos. Se ficar grande, parta por mecanismo — `token`, depois `callerIdentity`, depois `clientRebind` — e diga.
- **Um teste de comportamento precisa mudar.** É sinal de que a inversão mudou semântica. Pare e escreva o que mudou antes de ajustar o teste.
- **A fatia 6 exige exceção no gate.** Então a inversão não terminou. Volte, não abra a exceção.
