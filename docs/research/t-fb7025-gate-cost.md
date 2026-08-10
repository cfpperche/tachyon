# O custo real do `verify:full` — medição de 2026-08-09 (t-fb7025)

Medido por `gatecost` em 2026-08-09/10, na mesma máquina do dono (24 CPUs lógicas, 16 GB RAM,
WSL2). Nada aqui é impressão: cada número tem a fonte ao lado e o comando que o produziu.

**Resposta curta.** A proposta do corpo da task **não se paga**, e o achado novo do coordenador
(gate rodando sobre árvore que a suíte não lê) vale **2 de 99 rodadas** — 3 minutos do dia. O que
paga, medido em experimento controlado: **o pool de workers do gate está dimensionado 2× acima do
joelho**. Baixar de 15 para 8 workers **cortou o pico de load pela metade (16,67 → 8,63) e custou
3 segundos de parede (91 s → 88 s)**. O sintoma do dono é o pico, não a frequência.

---

## 0. Duas premissas do briefing morreram antes da medição

Registro primeiro porque elas mudam a forma da resposta, não só um número.

**1. `settings.verify.affected` não existe mais.** O briefing e o corpo da task dizem que
`npx vitest related --run` está declarado no `tachyon.yml` deste repositório e é servido ao agente
pelo primer. Verificado no ponto de uso, não por grep de texto:

- `/home/goat/tachyon/tachyon.yml` tem 16 linhas e **nenhum bloco `verify:`**.
- `grep -rn 'affected' src/config/loadConfig.ts` → **zero ocorrências**. O parser não conhece a chave.
- `git log -S'affected' -- src/config/loadConfig.ts` → `c7aaff71 Remove project settings.verify config (t-f559b6)`,
  de **2026-08-08 22:35 -03**.

A `t-f559b6` é decisão explícita do dono: *"voce vai remover essa config do tachyon e isso nao
aparece no primer, projeto deve declarar via verify da worktree e so"* — e o journal da entrega diz,
textual, *"`affected` essa sim tem zero consumidores"*.

Ou seja: o tier barato não está "pronto e ocioso". Ele foi **deliberadamente removido do produto há
21 horas**. O passo 1 da proposta do corpo não é "usar o que já existe"; é reconstruir, por outro
caminho, algo que o dono acabou de apagar. `npx vitest related` continua existindo como capacidade
do vitest — o que não existe é a porta que entregaria isso ao agente.

**2. "19 rodadas para landar 9 commits" (2,1 por commit) não é o número de hoje.** Hoje foram
**99 rodadas para 60 estados de trunk** = **1,65 por estado landado**. Piorou em volume absoluto,
melhorou em razão.

---

## 1. Contagem real de gates por commit landado hoje

### Como contei (e por que a contagem é completa)

`scripts/verify-full.mjs` só apaga o diretório temporário `/tmp/tachyon-verify-full-*` no caminho
**verde** (`rmSync` na linha 752, imediatamente antes do `return 0`). E `recordVerification` só
escreve o ref no caminho verde. Logo:

| fonte | o que é | contagem hoje |
|---|---|---|
| `refs/tachyon/verify/<tree>` | rodada que terminou **verde** | **66** |
| `/tmp/tachyon-verify-full-*` retido | rodada que **não** chegou ao verde (vermelha ou abortada) | **33** |
| | **total de execuções do gate** | **99** |

Os 66 refs cobrem exatamente o dia local 2026-08-09 (03:36 UTC → 01:44 UTC do dia seguinte), 66
árvores distintas, **zero árvore verificada duas vezes** — o mecanismo de reuso por árvore continua
100 % efetivo, como a medição de 2026-08-04 já dizia.

### Contra o que landou

```
git log --first-parent main --since='2026-08-09 00:00 -0300'
  60 estados de trunk  =  40 merges  +  20 commits diretos
  (150 commits no total, contando os das branches)
```

**99 execuções / 60 estados de trunk = 1,65 gate por commit landado.**

### Quem pagou cada um dos 66 gates verdes

Classificado pelo assunto do commit atestado:

| classe | gates | quem paga |
|---|---:|---|
| commit de trabalho na branch | **27** | o agente, na própria branch |
| merge de reintegração (`Merge branch 'main' into <branch>`) | **16** | o agente, porque a `main` andou embaixo dele |
| merge de integração (`merge(t-…)`) | **10** | o coordenador, na árvore combinada |
| commit só de documentação na branch | **8** | o agente |
| commit de release | **5** | o coordenador |

Os **16 merges de reintegração são 24 % de todos os gates verdes do dia** — é a colisão que o
coordenador descreveu, e ela é real e cara. Mas ver a seção 5: só ~5 deles trouxeram exclusivamente
documentação.

### Ocupação — o gate está ocioso, mas não quando importa

Somando as 99 rodadas (verdes estimadas em 84 s, vermelhas com duração exata do diretório retido):

```
tempo de gate no dia      2,27 h   sobre um span de 22,3 h  →  10 % de ocupação
maior trecho contíguo     6 min
51 das 99 rodadas começam a menos de 2 min do fim da anterior   (rajada, confirmada)
```

Por hora local (minutos ocupados / 60):

```
09h  25 min  42%  #############
14h  22 min  37%  ###########
20h  23 min  39%  ############
22h   9 min  15%  ####
```

**O detalhe que decide a recomendação:** o dono reclamou às **22:44**, numa hora de **15 % de
ocupação**. Ele não foi atropelado por frequência — foi atropelado por **uma** rodada. Cortar a
contagem em 4× leva a hora de pico de 40 % para 10 %; não muda nada do que acontece durante uma
rodada. E foi durante uma rodada que ele travou.

---

## 2. Decomposição do full em etapas, com tempo

### Etapas (129 diretórios retidos, 2026-08-05 → 09; horários de nascimento dos arquivos de log)

| etapa | p50 | p90 | roda em | load que adiciona |
|---|---:|---:|---|---|
| `check:source-diffable` + `check:engine-boundary` + `typecheck` | **23 s** | 32 s | sempre | **+0,7** |
| `esbuild.mjs` | **2 s** | 3 s | sempre | ~0 |
| suíte unitária (716 arquivos, 8135 testes) | **59 s** | 81 s | sempre | **+13,8** |
| suíte de browser | **39 s** | 69 s | 12 de 129 rodadas (9 %) | não medido (ver nota) |
| **total sem browser** | **84 s** | 123 s | | |

Cronometragem individual das três etapas estáticas (medida agora, isoladas):

```
check:source-diffable   0,20 s   maxRSS   67 MB
check:engine-boundary   0,81 s   maxRSS  212 MB
typecheck              23,25 s   maxRSS 1587 MB     ← 97% da metade estática
```

### A metade portátil-rápida existe, e é extrema

Classificando os 716 arquivos da suíte por conterem chamada real de subprocesso / tmux / socket
(`execFileSync|spawn|child_process|TmuxService|tmux|systemd-run|net.createServer|…`), com o custo de
cada arquivo tirado do `vitest-report.json` de uma rodada real:

| metade | arquivos | testes | CPU-parede somada | arquivo mais longo |
|---|---:|---:|---:|---:|
| máquina real (subprocesso/tmux/socket) | 186 (26 %) | 2762 (34 %) | **356 s (91 %)** | 55 s |
| puramente portátil | 530 (74 %) | 5373 (66 %) | **36 s (9 %)** | 14 s |

**66 % dos testes custam 9 % do trabalho.** A resposta à pergunta 2 do corpo é sim, e com folga:
a suíte separa, e a separação é quase perfeita.

### Mas o tempo de parede não segue o custo — segue UM arquivo

```
50% de todo o trabalho da suíte está em   8 arquivos (1,1%)
80%                                      26 arquivos (3,6%)

 55,0 s  test/unit/engineSupervisor.test.ts        (13 testes)
 46,5 s  test/unit/grokauthfixBehavior.gen.test.ts ( 1 teste)
 21,8 s  test/unit/humanDraftHoldsNotice.test.ts
 19,7 s  test/unit/agentManager.test.ts
```

A fase unitária dura 59 s e o arquivo mais longo dura 55 s. **A suíte inteira é do tamanho de um
arquivo.** Nenhuma seleção de testes, por mais esperta, desce abaixo de 55 s enquanto
`engineSupervisor.test.ts` estiver no conjunto selecionado.

### E o segundo maior é uma duplicata do próprio gate

`test/unit/grokauthfixBehavior.gen.test.ts` tem **um** teste, e ele é:

```js
it("cmd:npm run typecheck", () => {
  expect(() => execFileSync("npm", ["run", "typecheck"], { … })).not.toThrow();
}, 200_000);
```

O `verify:full` **já rodou `npm run typecheck` 35 segundos antes**, como primeira etapa estática, em
23,25 s. Dentro do pool, disputando com 15 workers, o mesmo comando leva **46,5 s**. Confirmado ao
vivo pelo amostrador: `tsc` aparece com 2 processos na fase estática (02:11:41) **e outra vez na
fase de testes** (02:12:05 → 02:12:38).

Custo: **46,5 s de CPU × 99 rodadas = 77 minutos de CPU por dia**, gastos recomputando algo que a
mesma execução já provou. Dentro do `verify:full` a cobertura desse teste é **exatamente zero**.

> Nota honesta sobre a fase de browser: nas duas rodadas que cronometrei ela **não** rodou — o
> `browserGateDecision` declinou corretamente (nenhuma mudança sob as raízes do suite). Os 39 s p50
> vêm dos 12 diretórios retidos em que ela rodou. Os 5 chrome headless que o coordenador viu às
> 22:44 são dessa fase; eu não os medi. O que medi é que **51 processos chrome já estavam na máquina
> antes do meu gate começar** (39 no primeiro sample) — são do dono, não do gate. Não atribuo carga
> de chrome ao gate nesta medição.

---

## 3. `affected` × full sobre mudanças reais de hoje

### 3.1 Os dois vazamentos já medidos, reproduzidos

O journal de 2026-08-06 registra duas falhas que escaparam de uma seleção manual e foram para a
`main`. Rodei `vitest related` sobre a causa de cada uma:

| caso | arquivo que mudou | `vitest related` selecionou | o teste que quebrou entrou? |
|---|---|---:|---|
| 1 | `scripts/dogfood/run.mjs` | **0 arquivos, 0 testes** (3,5 s) | **NÃO** |
| 2 | `src/bridge/lifecycleScope.ts` | 50 arquivos, 534 testes (20,1 s) | **sim** — `temporaryWorktreeLifecycle.test.ts` |

O caso 1 é fatal para a proposta e a causa é estrutural, não um bug: **`vitest related` percorre o
grafo de IMPORTS**. `dogfoodRunner.test.ts` não importa `scripts/dogfood/run.mjs` — ele o executa com
`execFileSync(process.execPath, ["scripts/dogfood/run.mjs", "--list"])`. Um arquivo lido por `fs` ou
executado como filho é invisível para o `related`.

Isso não é um caso raro neste repositório. Testes que leem arquivos reais da árvore por caminho, e
que portanto o `related` nunca associa à mudança:

- `projectGuidanceOwnership/VerifyHandles/RetiredFlags.test.ts` → `docs/project-guidance.md`
- `runtimeObservabilityReference.test.ts` → `docs/research/runtime-observability-reference.json`
- `devHostNoSlots.test.ts` → varre `scripts/`, `src/`, `test/`, `docs/runbooks/` inteiros
- `savedAgentProposalCommit.test.ts` → `docs/specs/482-unified-agent-instance/spec.md`
- `workspacePresentationBoundary.test.ts` → um inventário `.txt` em `docs/specs/382-…`
- `snBoundaryLocksBehavior.gen.test.ts`, `packageCleanGate.test.ts` → `package.json` lido por `fs`

Toda a família de guardas estruturais deste repositório — a que existe justamente porque
"arquivos disjuntos não são superfícies disjuntas" — é cega para o `related`.

### 3.2 Dez merges reais de hoje

Para cada merge, passei ao `related` a lista de arquivos que o merge tocou e medi a seleção. O custo
em CPU vem do cruzamento com o `vitest-report.json` da suíte cheia, então é comparável direto:

| merge | arquivos mudados | testes selecionados | % da suíte | CPU selecionada | arquivo mais longo selecionado |
|---|---:|---:|---:|---:|---:|
| `9168dccc` | 2 | 65 | 0,8 % | 12 s | 9 s |
| `22011b2e` | 5 | 190 | 2,3 % | 19 s | 9 s |
| `371ec736` | 23 | 546 | 6,7 % | 88 s | 22 s |
| `dca34e6d` | 18 | 677 | 8,3 % | 124 s | 22 s |
| `93332a0c` | 79 | 891 | 11,0 % | 117 s | **55 s** |
| `c474b836` | 3 | 982 | 12,1 % | 118 s | 22 s |
| `fc3be5cb` | 11 | 990 | 12,2 % | 201 s | **55 s** |
| `6949f2cd` | 7 | 1158 | 14,2 % | 228 s | **55 s** |
| `2c88fd90` | 31 | 1706 | 21,0 % | 234 s | **55 s** |
| `1d3fab4c` | 4 | 2207 | 27,1 % | 238 s | **55 s** |
| **mediana** | | **~936 (11,6 %)** | | **~160 s de 392 s (41 %)** | |

Três leituras, e as três derrubam a proposta:

1. **`affected` seleciona 12 % dos testes mas 41 % do custo.** O grafo de imports é denso: um arquivo
   de `src/bridge/` alcança 50 arquivos de teste. A economia é 2,4×, não 30×.
2. **Em 5 dos 10 merges o `related` puxa `engineSupervisor.test.ts` (55 s) assim mesmo.** Nesses
   casos a fase de testes "barata" dura ~55 s contra os 59 s da suíte inteira: **economia de 7 %**.
   Somando o `typecheck` que a proposta mantém na branch (23 s), o gate barato custaria ~78 s contra
   os 84 s do full. **Não vale trocar cobertura por 6 segundos.**
3. **O pico de carga não muda em nada.** Todo `npx vitest` passa pelo mesmo `vitest.config.ts` e toma
   o mesmo orçamento host-wide. A minha sonda de 3,5 s imprimiu, literal:
   `[vitest] host vitest budget: pool 8060MB → workers=16 (claiming 7168MB)`.
   Pior: `explicitTestFileCount()` só limita workers quando os argumentos são **arquivos de teste**;
   `vitest related` recebe arquivos de **fonte**, então cai no "escopo desconhecido" e leva o teto
   cheio. Trocar um full de 84 s por um `related` de 55 s troca uma rajada de 16 workers por outra
   rajada de 16 workers, um pouco mais curta.

### 3.3 O que a proposta economizaria de verdade

Aplicada aos 66 gates verdes de hoje, a proposta removeria 27 (trabalho na branch) + 8 (docs na
branch) + 16 (reintegração) = **51 gates**, deixando ~15 (10 integração + 5 release). É uma redução
de 4× na contagem. Mas:

- cada um dos 51 vira um check de 55–78 s no lugar de 84 s → a economia de **tempo de máquina** é
  ~20 %, não 75 %;
- o pico de load de cada um continua idêntico;
- e ela aposta tudo no "um full na árvore combinada antes do push", disciplina que **hoje já falha
  40 % das vezes**: dos 60 estados de trunk de hoje, **36 têm registro verde e 24 não**, e **8
  desses são merges cujo conteúdo nenhum gate jamais viu**.

Tirar a rede da branch para depender de uma disciplina medida em 60 % de aderência é trocar um custo
conhecido por um risco não contabilizado.

---

## 4. `assertStableBuildSource` e o gate de push mudam?

**`assertStableBuildSource` não muda em nenhum cenário — e não mudaria nem se tudo o resto mudasse.**
Verificado no ponto de uso: `esbuild.mjs:13` só o chama quando
`resolveEngineReleaseChannel() === "stable"`, e o `verify:full` constrói no canal `dev` (default).
Ele **nunca executa dentro do gate**. O que ele exige — checkout primário, branch `main`,
`HEAD == refs/heads/main == refs/remotes/origin/main`, árvore limpa — é uma afirmação de
proveniência de release e **não consulta o registro de verificação em momento nenhum**. Confirmado.

**O gate de push muda, mas só na opção 3 (cache parcial).** O hook `pre-push` é um dispatcher com
verificação de integridade que resolve `npm run verify:full`; ele só dispara para
`refs/heads/main`/`master` no remoto. Hoje o veredito que ele consome é `decideReuse`, chaveado pela
**árvore exata**, fail-closed em toda direção. Duas consequências:

- Na proposta do corpo (branch barata + um full combinado): **não muda nada.** O hook continua
  exigindo registro da árvore exata; só muda quem produziu esse registro.
- Em qualquer reuso "por conteúdo" (seção 5): **muda o significado da prova.** Passa de "esta árvore
  exata foi verificada" para "uma árvore que difere só em caminhos que eu declarei inertes foi
  verificada". Isso não é um detalhe de implementação; é o enfraquecimento de um invariante que hoje
  é a única coisa ligando o verde ao que vai para a `main`.

Um dado que vale registrar: o hook dispara **uma vez por push**, não por merge. É por isso que 24
dos 60 estados de trunk de hoje não têm registro — eles atravessaram entre dois pushes.

---

## 5. Quantos gates rodaram sobre árvore que a suíte não lê

Este é o achado novo do coordenador, e é o número que ele pediu explicitamente.

**Método.** Para cada uma das 66 árvores atestadas, subi pelos ancestrais até o commit mais próximo
cuja árvore já estivesse atestada **antes** daquela rodada, e classifiquei o diff entre os dois. Duas
definições de "inerte", porque a resposta depende dela:

- **estrita** — `docs/specs/**` (menos os 2 arquivos que testes leem de verdade), `CHANGELOG.md`,
  `.vscode/**`, `.tachyon/**`;
- **generosa** — a estrita mais `docs/**` em geral, preservando `docs/project-guidance.md`,
  `docs/runbooks/**`, `docs/runtimes/**` e `docs/research/runtime-observability-reference.json`, que
  **são** lidos por testes.

**Resultado:**

| definição | gates cujo diff desde a árvore atestada mais próxima é 100 % inerte |
|---|---:|
| estrita | **2 de 66** (3 %) |
| generosa | **11 de 66** (17 %) |

Os 11 da definição generosa custaram ~15 minutos das 2,27 h de gate do dia. Cinco deles são da última
hora (23:00–23:20), da destilação de specs — dois com diffs de **730 arquivos** e três de **173**,
todos exclusivamente documentação. É desperdício real, e é concentrado.

Contexto que o volume esconde: `docs/specs` respondeu por **986 das mudanças de caminho** nos 60
estados de trunk de hoje, contra 216 de `test/unit` e 100 de `src/webview`. Documentação domina o
diff do dia por larga margem — e mesmo assim só 2 (estrita) ou 11 (generosa) rodadas foram
integralmente inertes, porque a maioria dos commits mistura doc com código.

**Resposta à pergunta 3 do corpo (cache por árvore parcial vale?): não.** O ganho medido é 3 % a
17 % das rodadas, ~3 a 15 minutos de máquina por dia. O custo é declarar e manter para sempre o
conjunto exato de arquivos que a suíte lê — e este repositório já pagou duas vezes para aprender que
uma lista escrita à mão apodrece: `t-e2c8a2` (o gate de browser disparava só em `src/webview/` e
ignorava `src/sidebar`, `src/agents`, `src/cockpit` e o próprio `test/browser/`) e SDD 485 D15 (nove
entradas copiadas contra um launcher que já tinha doze). A resposta daquele repositório foi **derivar**
a lista andando pelo suite (`browserSuiteRoots`), não escrevê-la. Derivar o conjunto de leituras por
`fs` exigiria instrumentar cada teste. Uma entrada errada nessa lista não é um gate lento: é uma
mudança real que landa sem gate nenhum. **15 minutos por dia não compram esse risco.**

---

## 6. O experimento que mudou a resposta

Rodei o `verify:full` **duas vezes para medir**, como o briefing autorizou (a 6.1 registra as
execuções de atestação que vieram depois, e por que elas viraram evidência). Ambas na árvore
`4c141272` (a ponta da `main` — exatamente a árvore que o coordenador pegou saturando a máquina às
22:44), com um amostrador passivo lendo `/proc` a cada 2 s (nunca sinaliza nem seleciona processo).

| rodada | horário local | workers | parede | **pico de load1** | MemAvailable consumido | vitest procs |
|---|---|---:|---:|---:|---:|---:|
| 1 (padrão) | 23:11:33 | 15 | **91 s** | **16,67** | 4145 MB | 17 |
| 2 (`TACHYON_VITEST_MAX_WORKERS=8`) | 23:15:13 | 8 | **88 s** | **8,63** | 3454 MB | 18 |

**Metade dos workers. Metade do pico de load. Três segundos a mais de parede — dentro do ruído.**

E não é coincidência de amostra: a teoria prevê exatamente isso. O trabalho total da suíte é 392 s de
CPU e o arquivo mais longo é 55 s, então o *makespan* é `max(392/W, 55)`:

```
W = 15 →  max(26, 55) = 55 s
W =  8 →  max(49, 55) = 55 s      ← ainda limitado pelo arquivo, não pela CPU
W =  6 →  max(65, 55) = 65 s      ← aqui começa a doer
```

**O joelho é 7–8 workers.** Tudo acima disso é load pura, comprada por zero segundos. O teto atual
(`HARD_CAP_WORKERS = 16` em `shared/host-resource-cost-inputs.cjs`) está **2× acima do joelho**.

Por que o dimensionador não viu: ele modela **só memória**. `decideHeavyGate` divide
`MemAvailable − reserva` por 320 MB/worker e corta no teto de 16 — não há termo de CPU, de load, nem
de "existe um humano usando esta máquina". No experimento 1 ele reservou 7168 MB e a rodada consumiu
4145 MB de pico: **a folga que ele estava protegendo era RAM, e o recurso que degradou foi CPU.**
Perfil por fase confirma onde: fase estática pico de load **3,59** (baseline 2,90 — ou seja, +0,7);
fase de testes pico **16,67**. **100 % do pico vem do pool do vitest.**

> Divergência honesta na rodada 2: ela ficou vermelha em uma asserção,
> `runtimeOpsSnapshotService.test.ts:608` — `expected 8 to be greater than 8`. Não é regressão. O teste
> chama `recommendVitestMaxWorkers(...)` e afirma `alone > 8`; essa função lê
> `TACHYON_VITEST_MAX_WORKERS` do ambiente, e eu tinha acabado de exportar `=8`. A suíte inteira
> executou (é como a asserção foi coletada), então os 88 s e o pico de 8,63 são medidas válidas. Mas
> isso revela um defeito lateral real: **a manopla documentada `TACHYON_VITEST_MAX_WORKERS` não pode
> ser usada com o `verify:full`, porque um teste da própria suíte a confunde com uma medição do
> host.** Registrado como task à parte (`t-325fe6`), com fail-before/pass-after verificado:
> `TACHYON_VITEST_MAX_WORKERS=8 npx vitest run test/unit/runtimeOpsSnapshotService.test.ts` falha em
> 1,35 s; sem a variável, 23 passam em 1,32 s.

### 6.1 O gate ficou VERMELHO na entrega deste relatório — e isso não é digressão

Este documento é um único `.md` novo em `docs/research/`, mais a reintegração da `main`. A árvore
combinada foi gateada às **23:24:04 -03** e o `verify:full` **falhou**, em 82 s:

```
2 de 8135 testes falharam
  test/integration/plugin-ui.e2e.test.ts
  test/unit/taskStore.test.ts
```

Os dois passam isolados, imediatamente depois, sem nenhuma alteração:

```
npx vitest run test/unit/taskStore.test.ts            → 45 passed  (305 ms) · repetido: 45 passed
npx vitest run test/integration/plugin-ui.e2e.test.ts →  4 passed (13,2 s)
```

Os dois são sensíveis a tempo. O `plugin-ui.e2e` posta uma mensagem em `setTimeout(6_100)` e a colhe
depois de `sleep(6_250)` — **150 ms de margem**, num Chrome real, disputando com 15 workers. O
`taskStore` afirma sobre a última entrada de um journal escrito por uma operação assíncrona.

**Isto é a `t-efb7cc` acontecendo ao vivo, na entrega de um relatório que não toca uma linha de
código de produto.** Não é um argumento retórico sobre o risco de não agir; é o risco, medido, no
mesmo dia, contra a mesma máquina. Um gate que fica vermelho por contenção ensina o operador que o
vermelho não significa nada — e o journal de 2026-08-06 já registra o passo seguinte: o coordenador
substituiu o gate por seleção manual e essa seleção falhou em 2 de 4 merges.

Isso levou o total de execuções desta sessão a quatro: duas de medição (as da tabela acima), a
atestação vermelha desta seção, e uma re-execução para atestar a árvore entregue. As duas últimas não
são medição e não alimentam nenhum número deste relatório.

---

## 7. Recomendação

> **Não implementar a proposta do corpo. Dimensionar o gate pelo joelho medido em vez de pela RAM:
> teto de 8 workers, e apagar o `typecheck` duplicado de dentro da suíte. Manter todas as 99
> rodadas.**

### Por que esta, e não "rodar menos vezes"

O objetivo declarado da task é rodar o full menos vezes. A medição diz que esse é o eixo errado para
o sintoma que abriu esta rodada:

- o dono travou às 22:44, numa hora de **15 %** de ocupação — atropelado por **uma** rodada;
- reduzir a contagem em 4× (o melhor caso da proposta do corpo) leva a hora de pico de 40 % para
  10 % e **não muda em nada** o que acontece durante a rodada que o atropela;
- baixar o teto de workers **corta o pico pela metade em todas as 99 rodadas, incluindo aquela**.

Frequência muda a probabilidade de colisão. Footprint muda a severidade. O dono reclamou da
severidade.

### O que fazer, em ordem de razão custo/benefício

1. **Teto de 8 workers para o pool do gate.** Medido: load 16,67 → 8,63, parede 91 s → 88 s. É a
   mudança de maior efeito e menor risco do relatório inteiro — não toca em cobertura, em lock, nem
   em reuso. **Um teste continua rodando exatamente os mesmos 8135 testes.**
2. **Remover `test/unit/grokauthfixBehavior.gen.test.ts` da suíte.** Dentro do `verify:full` sua
   cobertura é zero — o `typecheck` é a primeira etapa estática do mesmo comando, 35 s antes. Libera
   46,5 s de CPU × 99 rodadas = 77 min de CPU/dia da janela de pico, e com ela o joelho desce de 8
   para ~6 workers ao mesmo tempo de parede. **Custo real e declarado:** quem roda `npm test` puro
   deixa de ter `typecheck` embutido. O gate é o `verify:full`; `npm test` não é o gate.
3. **`engineSupervisor.test.ts` (55 s, 13 testes) é o teto de tudo.** Enquanto ele existir na forma
   atual, nenhuma estratégia de seleção leva a fase de testes abaixo de 55 s. Não recomendo mexer
   agora — é a única peça que exige entender o que ela prova antes de tocar — mas qualquer trabalho
   futuro sobre "gate mais rápido" começa aqui e não em outro lugar.

### Custo de implementar

Item 1: uma constante (`HARD_CAP_WORKERS`, `shared/host-resource-cost-inputs.cjs`) e o teste que a
fixa. Meia hora, incluindo o fail-before. Reversível por uma linha.
Item 2: apagar um arquivo de 15 linhas e o que o gerou. O `.gen.` no nome diz que ele é gerado —
precisa sair da fonte geradora, senão volta.
Item 3: não recomendado nesta rodada.

Nenhum dos itens toca o lock (`t-6a9bc4`), o reuso por árvore, o gate de push ou o
`assertStableBuildSource`. Nenhuma cobertura é perdida dentro do `verify:full`.

### Risco de NÃO implementar

O gate continua tomando 16 workers em 24 CPUs, ~40 % das horas de pico, com o dono na mesma máquina.
O risco não é lentidão — é o que a lentidão provoca. A seção 6.1 registra esse risco se realizando
**durante a entrega deste relatório**: o gate ficou vermelho em dois testes sensíveis a tempo que
passam isolados, numa árvore cuja única mudança é um arquivo `.md`. `t-efb7cc` já registra o
`verify:full` produzindo **vermelho falso** sob carga da frota, e o journal de 2026-08-06 registra o que acontece
em seguida: o coordenador substitui o gate por uma seleção manual, e **essa seleção falhou em 2 de 4
merges**, com as duas causas invisíveis tanto para as camadas estáticas quanto para os testes que ele
escolheu à mão. A dor de usabilidade não faz o gate ser pulado por decisão; faz ele ser **contornado
por reflexo**. Cortar o pico pela metade por 3 segundos de parede é o preço mais barato já oferecido
para não chegar lá de novo.

### O que eu explicitamente NÃO recomendo, e por quê

- **Tier `affected` na branch** — mede 12 % dos testes mas 41 % do custo; em 5 de 10 mudanças reais
  economiza 7 % da fase de testes; retorna **0 testes** para a causa do vazamento nº 1 já medido; e
  não reduz o pico de carga em nada. Além disso o mecanismo que a proposta assume **foi removido do
  produto pelo dono ontem** (`t-f559b6`).
- **Reuso/cache por árvore parcial** — vale 2 (estrito) a 11 (generoso) rodadas de 99, ~3 a 15
  min/dia, contra manter à mão para sempre a lista de tudo que a suíte lê, num repositório que já
  viu essa lista apodrecer duas vezes. Uma entrada errada não deixa o gate lento: deixa uma mudança
  real landar sem gate.
- **Afrouxar o lock ou permitir gate concorrente** — fora de escopo por decisão, e a medição não dá
  nenhum motivo para reabrir: 0 % de sobreposição, 10 % de ocupação.

---

## Apêndice — reprodução

```bash
# 1. as 66 árvores atestadas de hoje, com horário
for r in $(git for-each-ref refs/tachyon/verify --format='%(refname)'); do git cat-file blob "$r"; done

# 2. as 33 rodadas NÃO-verdes e a decomposição por etapa (nascimento dos arquivos de log)
for d in /tmp/tachyon-verify-full-*; do stat -c '%W %n' "$d"; stat -c '%W %Y %s %n' "$d"/*; done

# 3. o que landou
git log --first-parent main --since='2026-08-09 00:00 -0300' --format='%H %T %P'

# 4. seleção do affected sobre um merge real, sem executar os testes
npx vitest related --run $(git diff --name-only <merge>^ <merge>) -t '__nope__' \
  --reporter=json --outputFile=/tmp/sel.json --silent

# 5. o experimento de workers (as DUAS únicas execuções de verify:full desta MEDIÇÃO)
TACHYON_VERIFY_FORCE=1 npm run verify:full:quiet                                   # 23:11:33 -03
TACHYON_VERIFY_FORCE=1 TACHYON_VITEST_MAX_WORKERS=8 npm run verify:full:quiet      # 23:15:13 -03

# 6. o defeito lateral (t-325fe6): falha com a manopla, passa sem ela
TACHYON_VITEST_MAX_WORKERS=8 npx vitest run test/unit/runtimeOpsSnapshotService.test.ts
npx vitest run test/unit/runtimeOpsSnapshotService.test.ts
```

Nenhum processo foi encerrado por nome ou padrão de linha de comando durante esta medição. O
`tachyon.yml` não foi tocado.
