# SDD 506 — fatias

**Verify:** `npm run verify:full`
**Dogfood:** `npm run smoke:vsix`
**Human dogfood:** F5 no dev-host abre uma janela com a extensão carregada, e a sidebar lista os
agentes. Obrigatório em qualquer fatia que toque `launch.json`, `tasks.json` ou `dev-host/pointer.mjs`.

Cada fatia termina rodando `node scripts/research/measure-monorepo-graph.mjs` e comparando a contagem
do pacote com o que a fatia declarou ter movido. Divergência é defeito da fatia.

**Antes de mover, cada fatia mede o fecho de TIPO dos seus membros** (plan.md D7). O número de
runtime não enxerga módulo de tipo puro, porque tipo puro não emite JavaScript. A diferença entre os
dois números é resultado esperado; o pacote tem de compilar sozinho.

---

## Fatia 1 — workspaces ligados, `packages/shared`, e o gate de fronteira nasce

A menor e a mais importante. 36 módulos, zero alcançam `vscode`, direção já medida.

- [x] `package.json` da raiz declara `workspaces: ["packages/*"]`. Nenhum código de produto sai da raiz nesta fatia além dos 36.
- [x] `packages/shared/` recebe os 32 da interseção engine/navegador (Apêndice B do baseline), os 4 `.cjs` de `shared/` com seus `.d.cts`, e os 9 módulos de tipo exigidos pelo fecho de compilação medido durante a fatia.
- [x] Os consumidores medidos passam a importar `shared` pelo NOME do pacote, não por caminho relativo: 4 arquivos de `src/`, 3 scripts operacionais, 4 testes.
- [x] `tsconfig` do pacote existe, compila sozinho e a raiz o referencia (project references).
- [x] **Novo gate `scripts/check-package-boundary.mjs`**, entrando em `STATIC_GATES`: dentro de `packages/`, um import relativo não pode escapar da raiz do próprio pacote. Reusa o resolvedor de `scripts/research/measure-monorepo-graph.mjs` — não escreva um segundo resolvedor.
- [x] O gate **conta e reporta** o que não conseguiu resolver, em vez de descartar em silêncio. Os 3 JSON de manifesto ficam listados com o motivo.
- [x] O gate nasce com **lista de exceções VAZIA**.
- [x] `test/unit/ciWorkflowSingleSource.test.ts` atualizado para incluir o gate novo — a lista de gates é revisada por quem a muda, não cresce sozinha.
- [x] Existe um teste que prova que o gate FALHA num import que atravessa a fronteira.
- [x] Medido e registrado em `notes.md`: tempo de `npm ci` e tamanho do `package-lock.json`, antes e depois.

---

## Fatia 2 — `packages/engine`

355 módulos exclusivos. Fecho de `src/engine-service/{engineService,daemonMain}.ts`.

- [ ] Os 355 movidos por `git mv`, preservando histórico.
- [ ] Zero módulos do pacote importam `vscode`, e `check:engine-boundary` prova.
- [ ] O gate de fronteira cobre `engine` e continua com exceções vazias.
- [ ] `esbuild.mjs` produz o mesmo artefato de engine que produzia antes; comparar o output byte a byte ou explicar cada diferença.
- [ ] Contagem do script bate com 355.

---

## Fatia 3 — `packages/webview-ui`

174 módulos exclusivos. Fecho dos 27 `main.tsx`, menos os 32 compartilhados.

- [x] Os 174 movidos por `git mv`.
- [x] Zero módulos do pacote importam `vscode`, nem em valor nem em tipo. Hoje o fecho do navegador tem zero dos dois e isso não pode piorar.
- [x] Os 27 entrypoints continuam produzindo os mesmos bundles; `scripts/check-webview-tokens.mjs` e `check:theme-tokens` continuam verdes.
- [x] O harness de preview (`scripts/webview-preview/`) continua servindo as 23 views.
- [x] **Validação visual obrigatória** em 880 e 360, nos dois temas. Esta fatia move o código de tudo que se vê.
- [x] Contagem do script bate com 174.

---

## Fatia 4 — classificar os 212 residuais

Medição. Nada se move.

- [ ] Cada um dos 212 classificado num grupo, com o número de cada grupo escrito.
- [ ] Dito por escrito quais são app do VS Code, quais são hosts de webview, quais são entradas auxiliares, quais são validadores.
- [ ] **Não inventar um quinto pacote.** Se a medição pedir um, o número que pede tem de estar escrito antes do nome.
- [ ] Os 50 acoplados a `vscode` identificados dentro dos 212, e dito onde cada um cai.

---

## Fatia 5 — `apps/vscode-extension`, o manifesto sai da raiz

A mais arriscada. Vem por último de propósito.

- [ ] `package.json` da extensão em `apps/vscode-extension/`, com `main` relativo correto.
- [ ] `.vscodeignore`, `vsce`, `prepare-package`, `package-closure`, `record-provenance`, `ship-boundary`, `vsix-artifact`, `vsix-smoke` reendereçados.
- [ ] `.vscode/launch.json` e `.vscode/tasks.json` reendereçados; as cinco referências a `${workspaceFolder}[/...]/dist/**/*.js` conferidas uma a uma.
- [ ] `scripts/dev-host/pointer.mjs` reendereçado.
- [ ] **F5 provado por um humano** antes de notificar. Sem isso a fatia não sai.
- [ ] `npm run release` produz um VSIX e `npm run smoke:vsix` passa.
- [ ] A versão do produto **não muda** por causa desta fatia.
- [ ] A raiz não contém mais código de produto.
- [ ] **Nada assume um app único.** Build, scripts e `tsconfig` tratam `apps/` como plural — derivado, nunca com o nome do app cravado como literal. Um teste prova que um segundo diretório em `apps/` é enxergado sem editar script nenhum.

---

## Fatia 6 — fechar

- [ ] `measure-monorepo-graph.mjs` re-rodado; os números do baseline conferidos contra a árvore final e o documento atualizado.
- [ ] `docs/architecture/tachyon-monorepo-assessment.md` (2026-07-20) marcado como histórico e apontando para o baseline.
- [ ] `t-e4348c` fechada apontando para esta SDD.
- [ ] `docs/system-design.md` atualizado com a forma nova.
- [ ] O gate de fronteira continua com lista de exceções vazia. Se não estiver vazia, cada entrada tem motivo escrito e uma task que a retira.

---

## Armadilhas — valem para todas as fatias

- **Não corte por nome de pasta.** A medição já derrubou `agents`, `runtime` e `src/webview/` como candidatos. O corte é pelo fecho de entrypoint.
- **Não trate import de tipo como acoplamento de runtime.** Somar os 9 aos 42 infla o conjunto em 38 arquivos, 76% sobre os 50 reais.
- **Não mova o manifesto antes da fatia 5**, nem "só para adiantar".
- **Não troque de gerenciador de pacotes** no meio. Se aparecer dor medida, ela vira dado para reabrir a decisão, não motivo para trocar sozinho.
- **Não deixe o gate nascer com exceção.** Uma exceção na fatia 1 é a prova de que o corte está errado, não de que o gate é rígido demais.
- **Não confie em `npm workspaces` para impedir travessia.** Ele resolve instalação; caminho relativo atravessa qualquer fronteira em silêncio. Esse é o motivo do gate existir.
