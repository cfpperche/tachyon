# SDD 507 — fatias

**Verify:** `npm run verify:full`
**Dogfood:** `npm run smoke:vsix`
**Human dogfood:** F5 no dev-host abre uma janela com a extensão carregada e a sidebar lista os agentes. Obrigatório na fatia 6.

Cada fatia roda `node scripts/research/measure-engine-bridge-imports.mjs` antes e depois, e reporta os três números. Chegar a zero é o aceite mecânico da SDD.

Estado inicial: **31 bindings · 14 imports · 5 arquivos.**

---

## Fatia 1 — as duas arestas mais simples, para provar o desenho

`workspace/bridgeSlowRequestPolicy.ts` importa `BridgeRequestCompleteInfo` de `Bridge.ts`. `agents/AgentManager.ts` importa `URL_ENV_VAR` de `token.ts`.

- [x] A política de requisição lenta recebe o dado de que precisa em vez de importar o tipo do transporte.
- [x] O `AgentManager` recebe o ambiente de lançamento pronto; deixa de conhecer o nome da variável da bridge.
- [x] Régua: 31 → 29.
- [x] Nenhum teste de comportamento alterado.

**Se o desenho de porta estreita não servir para estes dois, ele não serve para os outros.** Pare e diga, em vez de forçar.

---

## Fatia 2 — `extensionOperationService`

Importa `BridgeDeps` de `tools.ts` e uma constante de canal de aprovação.

- [x] O serviço deixa de reusar o saco de dependências do adaptador MCP.
- [x] A constante de canal chega como valor do adaptador, não como import do caso de uso.
- [x] Régua: 29 → 27.

---

## Fatia 3 — `stateMigration`, isolada porque é a mais perigosa

4 arestas: `token` (2), `callerIdentity`, `clientRebind`. Migra estado PERSISTIDO.

- [x] A migração de estado privado de autenticação e rebind pertence ao transporte, não à engine.
- [x] **Prova de leitura**: estado gravado pela versão anterior é lido corretamente pela nova, e o contrário quando aplicável. Sem isso a fatia não sai.
- [x] Régua: 27 → 23.

**Uma migração errada não falha no gate. Falha no reload de alguém, depois.**

---

## Fatia 4 — `Workspace`: token, identidade e rebind

17 arestas em três mecanismos: `token` (5), `callerIdentity` (5), `clientRebind` (7).

- [x] Os três vão inteiros para o lado do transporte.
- [x] A engine sabe que uma requisição chegou e de quem, por dado no ponto de entrada — não por módulo importado.
- [x] **Teste que exercita conexão, identidade e rebind**, antes e depois. Errar aqui abre porta, não quebra teste.
- [x] Régua: 23 → 6.

Se não couber numa mudança, parta por mecanismo e diga. Não empurre os três de uma vez só porque a fatia foi escrita assim.

---

## Fatia 5 — a inversão do composition root

6 arestas: `Bridge` (2), `notifyAgent` (2), `agentTokenHeal`, canal de aprovação. É aqui que `new Bridge(...)` sai do `Workspace.ts:1785`.

- [x] Quem instancia a `Bridge` é o composition root do app, não a engine.
- [x] A engine recebe a porta estreita que declarou; não conhece o servidor.
- [x] Régua: 6 → **0**.
- [x] O contrato exposto tem **no máximo ~15 membros**. Se passar, a fronteira está no lugar errado — pare e avise.

---

## Fatia 6 — `packages/bridge` nasce e o gate impõe

Com a régua em zero, o movimento é mecânico.

- [x] `packages/bridge` com os módulos de transporte.
- [x] `package.json` do bridge declara `@tachyon/engine`; o da engine **não** declara `@tachyon/bridge`.
- [x] `check:package-boundary` verde com lista de exceções **vazia**. Se precisar de exceção, a inversão não terminou — volte, não abra a exceção.
- [x] Existe prova executável de que um transporte novo se escreve sem editar `packages/engine`.
- [x] ~~`npm run release` e `npm run smoke:vsix` passam; a versão não muda.~~ Transferido para o coordenador no checkout primário pós-merge: o build stable recusa linked worktrees por desenho. Rodados em 2026-08-15 sobre `94e28652`: vsix-smoke PASS, 5 portas mais a de recusa.
- [x] **F5 provado por um humano.**
- [x] `docs/system-design.md` atualizado.

## Dogfood humano — 2026-08-15

O mantenedor rodou os três testes no Extension Development Host, sobre o build de `94e28652`, e os
três passaram:

1. **agente sobe e usa tool** — o caminho inteiro pela bridge recém-empacotada; ele confirmou que os
   agentes listam pins;
2. **reload da janela com agente vivo** — o único teste que ninguém além dele podia fazer, porque
   `clientRebind` só é exercitado num reload de verdade. A fatia 4 moveu esse mecanismo inteiro para
   o transporte, e o teste automatizado só prova que a composição nova lê o disco antigo;
3. **`tachyon.yml` validado no editor** — prova que o schema, que mudou de `src/config/` para
   `apps/vscode-extension/`, chega ao VSIX E é encontrado pelo editor. Nenhum teste nosso cobre a
   segunda metade.

Com isso a SDD 507 está fechada de ponta a ponta.

---

## Armadilhas — valem para todas as fatias

- **Não crie o pacote antes da régua zerar.** O gate nasceria atestando o contrário do objetivo.
- **Não abra exceção no gate.** Exceção é prova de que o corte está errado.
- **Não deixe o contrato inchar.** Um port com 40 membros é a gaveta com nome melhor. O `EngineHost` tem 21 e cada um nasceu de necessidade medida.
- **Não mude teste de comportamento.** Se um precisar mudar, a inversão mudou semântica: pare e escreva o que mudou antes de tocar no teste.
- **Não invente régua.** Use o script; se achar o critério errado, diga.
- **Worktree nova não tem `node_modules`.** `npm install` antes do primeiro check.
- **Não conserte `t-5313dc` nem `t-65e80b`** de passagem.
