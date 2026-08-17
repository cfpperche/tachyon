# 511 — diff-review-line-notes — notes

_Created 2026-08-17._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- **Nenhum k ∈ {0, 1, 3} zera a ambiguidade.** Medido em t-232111 (2026-08-17, HEAD
  `893ede07`). k=5 extra também não. A reconciliação não pode tratar o bloco de
  contexto como chave única: casamento >1 é estrutural (JSON repetitivo e
  boilerplate TypeScript), não residual que um k maior apaga. O caminho
  `outdated` por ambiguidade fica no desenho. Se o motor ainda precisa de um k
  de *captura* para reduzir falso-`outdated`, k=3 é o menor que zera `.md` e
  quase zera `.css`/`.tsx` — isso é custo, não unicidade. Ver a medição abaixo.

### Fatia 0a — `CommentController` em documento virtual read-only (t-1c7627)

**Resposta: SIM.** Medido no VS Code **1.133.0** por
`test/integration/commentControllerCustomScheme.test.js`, dentro do Extension Host real iniciado por
`npm run test:integration`. O teste registra um `TextDocumentContentProvider` em scheme próprio,
abre `vscode.diff` com base e modificado virtuais e cria a thread apenas no URI modificado.

Os quatro pontos observáveis passaram:

1. **Associação ao documento virtual:** o URI devolvido por `thread.uri` é exatamente o URI do
   `TextDocument` virtual modificado que consta em `window.visibleTextEditors`.
2. **Lado modificado, não base:** os dois documentos do diff estão visíveis; `thread.uri` coincide
   com o modificado e difere explicitamente do URI base.
3. **Afordância na régua:** depois de abrir o diff, o próprio VS Code chama
   `CommentingRangeProvider.provideCommentingRanges` para o documento virtual modificado e recebe o
   range habilitado. Essa chamada é o contrato observável pelo qual o editor pede os ranges que
   desenham a afordância de comentário; criar uma thread sem ela não satisfaria a prova.
4. **Range legível de volta:** `thread.range` permanece definido e volta exatamente como
   `0:0–0:5` (`Range.isEqual`).

**Controle negativo obrigatório:** o mesmo helper, com as mesmas quatro asserções, foi executado em
um diff cujos dois lados são `vscode.Uri.file(...)`; também passou. Resultado observado: uma
requisição de commenting range no lado modificado e range `0:0–0:5` tanto no scheme próprio quanto
em `file:`. Portanto a prova não está confundindo uma falha geral do teste com diferença de scheme.

O provider de produção `tachyon-worktree:` não foi duplicado no teste: o risco sob investigação é a
aceitação do URI pelo subsistema de Comments, e o caso isolado usa a mesma classe de documento
read-only (`TextDocumentContentProvider`) sem acoplar esta prova à leitura Git do provider Tachyon.
Como a resposta é positiva, o fallback do plano não é acionado; identidade e reconciliação seguem
inalteradas.

**Nota do claude sobre o delta não testado, para a fatia 3.** Concordo com o recorte, e o que fica de
fora tem nome: o URI de produção carrega **query string** — `tachyon-worktree:/<path>?cwd=...&ref=...`
— e o scheme sintético do teste não. Isso não muda a resposta (o subsistema de Comments decide por
scheme, não por query), mas é exatamente onde bug de identidade de URI mora: `toString(true)` inclui
a query, então dois URIs do mesmo arquivo em `ref` diferentes **não são iguais**. A fatia 3 tem de
comparar URI de propósito e escrito, nunca por acidente de igualdade de string. Lembrando que a
identidade da nota não menciona URI justamente para que essa comparação não decida nada durável.

**Custo operacional descoberto na entrega, e é meu erro de contrato.** `npm run test:integration`
sobe uma janela real do Extension Development Host: apareceu na tela do dono no meio do trabalho dele.
`xvfb-run` está instalado nesta máquina. Todo contrato futuro que rodar teste de integração passa por
ele; a alternativa é não despachar integração para agente em segundo plano.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

### Fatia 2 — conteúdo do arquivo não viaja no `review.mutate`

O molde de `sidebar.mutate` caberia um `content` no upsert, mas o control
request é 64 KiB. Um arquivo de review passa disso. A mutação portanto
aceita identidade + linha + k + hint; o engine lê o checkout. O range
empurrado continua dica. k é parâmetro obrigatório da query e do upsert
— a fatia 1 não inventa default, e esta também não.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Measurement t-232111 — snapshot context k

Medido 2026-08-17 no tree `893ede07dacdf1c58160537863683626ad065890`.
Reprodutível: `node scripts/research/t-232111-snapshot-k.mjs`.

### Método

Uma observação é uma linha comentável. O snapshot de k é o bloco consecutivo
de até k linhas antes + a linha + até k linhas depois (mais curto nas bordas
do arquivo). Ambiguidade = esse bloco, comparado **linha a linha**, começa em
mais de uma posição do mesmo arquivo. Não é contagem de substring: em
`routes.json`, a linha `    },` ocorre 118 vezes, mas o bloco de 7 linhas em
torno da linha 486 ocorre 43 vezes. Em `fleet.ts`, `    },` ocorre 34 vezes e
o bloco de 7 linhas da linha 85 ocorre 12. Substring mentiria para baixo e
para cima.

### Amostra declarada

28 landings first-parent em `main`, de `c99bdf1c` (t-00bf87) até `55de2fc4`
(t-025bce), escolhidos porque o lado modificado cobre `.ts`/`.tsx`/`.css`/
`.json`/`.md`, inclui arquivo grande e inclui repetição estrutural. Excluídos
releases (só changelog + lock) e `package-lock.json` (gerado, 10 249 linhas,
não é alvo de nota de review).

Commits (sha curto → arquivos do lado modificado nos 5 tipos → linhas `+` →
linhas totais do arquivo novo → maior arquivo):

| sha | assunto | arqs | + | linhas | maior |
|-----|---------|------|---|--------|-------|
| `c99bdf1c` | merge(t-00bf87) Orca anchors | 1 | 107 | 107 | research md 107 |
| `2adbe15d` | chore(t-487702) bridge tools | 11 | 43 | 3062 | `fleet.ts` 1097 |
| `3d164933` | chore(t-0af538) card layout out | 30 | 128 | 19790 | `extension.ts` 4300 |
| `29d50032` | merge(t-617077) inbox triaged | 1 | 126 | 126 | md 126 |
| `65243380` | merge(t-55fa50) runtime-config css | 3 | 12 | 881 | css 525 |
| `8873ad7e` | merge(t-5b06ba) plugins | 2 | 93 | 868 | `plugins/App.tsx` 743 |
| `f1efd419` | merge(t-d588c3) sidebar geometry | 2 | 31 | 756 | `sidebar.css` 640 |
| `c2967a44` | merge(t-e16954) agent-pane ramp | 1 | 28 | 253 | css 253 |
| `473c1aca` | merge(t-4aac93) plugin multi-surface | 23 | 657 | 9266 | `routes.json` 2281 |
| `8591113f` | merge(t-07acef) inbox D | 1 | 150 | 150 | md 150 |
| `e8e3202b` | merge(t-1cacae) inbox A | 1 | 114 | 114 | md 114 |
| `551f7fe4` | merge(t-affc0b) inbox C | 1 | 152 | 152 | md 152 |
| `b35adb44` | merge(t-3484a4) inbox B | 1 | 184 | 184 | md 184 |
| `123e86fe` | merge(t-d244e1) zombie engine | 3 | 286 | 2597 | `engineSupervisor.ts` 1338 |
| `309745fe` | merge(t-9f21ac) checklist 335MB | 7 | 314 | 984 | test 197 |
| `2778ccc4` | merge(checklist interno) | 76 | 5343 | 38964 | `Workspace.ts` 7378 |
| `d4668e19` | fix(t-544911) activity scroll | 3 | 235 | 962 | `activity/App.tsx` 668 |
| `ee7d3450` | merge(t-54cdb2) plugin dest | 6 | 1066 | 8057 | `HarnessManager.ts` 3731 |
| `2bbdbba4` | merge(t-5554b4) agent-pane theme | 6 | 213 | 829 | tsx 459 |
| `1e472d9e` | merge(t-9c7ce8) sidebar scale | 3 | 227 | 764 | `sidebar.css` 608 |
| `3b720d06` | merge(t-6e7d8a) sidebar absence | 16 | 1251 | 12391 | `extension.ts` 4297 |
| `11879842` | merge(t-824fc3) design tokens | 8 | 144 | 2342 | `design-system.css` 622 |
| `0718d20e` | merge(t-c2209d) parity dim 18 | 3 | 189 | 2108 | `parity.md` 1387 |
| `a855d463` | merge(t-30af3e) Node PATH | 3 | 80 | 4888 | `extension.ts` 4307 |
| `00ac7ff1` | meas(t-17674a) event-loop I/O | 5 | 246 | 4768 | `extension.ts` 4302 |
| `faf15070` | merge(t-0bf709) event-loop warning | 5 | 282 | 5465 | `extension.ts` 4318 |
| `774161b8` | merge(t-9eacf9) sidebar card | 5 | 128 | 2654 | `sidebar/App.tsx` 1757 |
| `55de2fc4` | merge(t-025bce) Runbooks out | 106 | 658 | 55947 | `Workspace.ts` 7231 |

Totais do lado modificado: **28 commits, 273 paths únicos, 333 pares commit×path,
12 487 linhas `+`, 179 429 linhas** no arquivo novo (é nisso que a régua do
diff nativo deixa comentar). 40 pares têm ≥1 000 linhas; 9 têm ≥4 000.
Paths únicos por tipo: `.ts` 199, `.json` 22, `.md` 21, `.tsx` 16, `.css` 15.

Dois cortes da mesma amostra, mais um controle negativo em HEAD:

1. **review-all** — todas as 179 429 linhas dos arquivos tocados (lado
   modificado). É o que o `CommentController` aceita.
2. **review-added** — só as 12 487 linhas `+`. O que o revisor costuma
   anotar.
3. **stress-head** — 12 arquivos grandes/repetitivos em HEAD, 37 778 linhas,
   uma cópia cada: `Workspace.ts` 7378, `AgentManager.ts` 5574,
   `extension.ts` 4300, `sidebar/App.tsx` 1776, `agent-studio-shell/App.tsx`
   1163, `sidebar.css` 638, `design-system.css` 622, `routes.json` 2243,
   `package.json` 904, `CHANGELOG.md` 3152, `parity.md` 1387,
   `test/unit/agentManager.test.ts` 8641.

### Tabela — ambiguidade por k

k=5 está fora do contrato; entrou só depois que 0/1/3 não zeraram, para não
deixar a pergunta "e se um pouco mais?" sem número.

**review-all (179 429 linhas, 333 arquivos):**

| k | únicas | ambíguas | % ambíguas | bytes média | p50 | p95 | máx |
|---|--------|----------|------------|-------------|-----|-----|-----|
| 0 | 114121 | 65308 | 36.398% | 50.3 | 38 | 115 | 4778 |
| 1 | 160706 | 18723 | 10.435% | 152.8 | 137 | 307 | 10343 |
| 3 | 171475 | 7954 | 4.433% | 357.4 | 333 | 637 | 19975 |
| 5 | 174556 | 4873 | 2.716% | 561.1 | 531 | 956 | 27901 |

| ext | linhas | k=0 amb | k=1 amb | k=3 amb | k=5 amb |
|-----|--------|---------|---------|---------|---------|
| .css | 8037 | 2601 (32.4%) | 337 (4.2%) | 12 (0.15%) | 0 |
| .json | 19406 | 12842 (66.2%) | 10083 (52.0%) | 7072 (36.4%) | 4598 (23.7%) |
| .md | 7593 | 1918 (25.3%) | 130 (1.7%) | 0 | 0 |
| .ts | 127213 | 43175 (33.9%) | 7438 (5.8%) | 860 (0.68%) | 275 (0.22%) |
| .tsx | 17180 | 4772 (27.8%) | 735 (4.3%) | 10 (0.06%) | 0 |

Sem `.json`, k=3 ainda deixa **882 / 160 023 (0.551%)**. Não zera.

**review-added (12 487 linhas `+`):**

| k | únicas | ambíguas | % ambíguas | bytes média | p50 | p95 | máx |
|---|--------|----------|------------|-------------|-----|-----|-----|
| 0 | 8301 | 4186 | 33.523% | 49.3 | 38 | 115 | 889 |
| 1 | 11642 | 845 | 6.767% | 144.4 | 125 | 303 | 1701 |
| 3 | 12224 | 263 | 2.106% | 331.3 | 296 | 631 | 3944 |
| 5 | 12336 | 151 | 1.209% | 515.6 | 467 | 958 | 6372 |

`.md`/`.css`/`.tsx` zeram em k=3 neste corte. `.ts` deixa 58 (0.64%). `.json`
deixa 205 (28.4%). Sem `.json`: 58 / 11 766 (0.493%). Não zera.

**stress-head (37 778 linhas, 12 arquivos):**

| k | únicas | ambíguas | % ambíguas | bytes média | p50 | p95 | máx |
|---|--------|----------|------------|-------------|-----|-----|-----|
| 0 | 22847 | 14931 | 39.523% | 55.3 | 45 | 113 | 4778 |
| 1 | 33519 | 4259 | 11.274% | 167.8 | 150 | 306 | 10343 |
| 3 | 36252 | 1526 | 4.039% | 392.7 | 360 | 642 | 19975 |
| 5 | 36942 | 836 | 2.213% | 617.5 | 573 | 964 | 27901 |

`.css` e `.md` zeram em k=3. `.tsx` deixa 2. `.ts` deixa 265 (1.02%). `.json`
deixa 1259 (40.0%).

### Pior caso (obrigatório)

Nenhum k testado zera. O pior casamento que restou no maior k do contrato
(k=3), nas três fatias, é o mesmo bloco:

- arquivo: `scripts/webview-preview/routes.json` (2243 linhas)
- linha 486, texto `    },`
- bloco de 7 linhas:

```
    "frame": {
      "w": 880,
      "h": 900
    },
    "tags": [
      "synthetic-edge"
    ],
```

- 43 posições de início (483, 503, 523, 543, 560, 577, 1178, …). Confirmado
  à mão no arquivo de HEAD. k=5 ainda deixa este arquivo com dezenas de
  colisões (o frame 880×900 + tag `synthetic-edge` se repete inteiro).

Isso não é só fixture. O pior `.ts` da amostra de review, ainda em k=3:

- `packages/bridge/src/tools/fleet.ts:85` no commit `2adbe15d` (1097 linhas)
- texto `    },`
- bloco de 7 linhas (`} catch (err) {` / `return fail(err);` / `}` / `},` /
  `);` / linha vazia / `mcp.registerTool(`)
- **12 posições**. A linha `    },` sozinha ocorre 34 vezes — daí a armadilha.

No corte `+`, o pior `.ts` é `packages/engine/src/activity/sessionOwners.ts:808`
em `2778ccc4`: o helper `sanitizeReason` copiado 5 vezes, bloco de 7 linhas
idêntico. No stress, o pior `.ts` é `test/unit/agentManager.test.ts:2398`:
sete linhas vazias seguidas, 13 posições — o caso da linha em branco que o
plano já nomeava.

Pior `.tsx` em k=3: `settings/main.tsx:505`, bloco do toggle
`ideBrowserEnabled`, 2 posições. Pior `.css`: `settings.css:62`, bloco
`color: var(--ds-muted)` + `overflow-wrap` + `}`, 2 posições. `.md` zera em
k=3 inclusive no `CHANGELOG.md` de 3152 linhas.

### Custo em bytes do snapshot por nota

Serialização: as linhas do bloco unidas por `\n`, UTF-8.

| k | review-all média (p50 / p95 / máx) | review-added média |
|---|------------------------------------|--------------------|
| 0 | 50.3 (38 / 115 / 4778) | 49.3 |
| 1 | 152.8 (137 / 307 / 10343) | 144.4 |
| 3 | 357.4 (333 / 637 / 19975) | 331.3 |
| 5 | 561.1 (531 / 956 / 27901) | 515.6 |

k=3 custa ~7× k=0 e ~2.3× k=1, e ainda deixa 4.4% ambíguo. O p95 (637 B) é
barato; o máx (20 KB) é uma linha enorme com vizinhança, não o caso comum.

### k recomendado

**Nenhum.** Nenhum k ∈ {0, 1, 3} zera a ambiguidade na amostra — e k=5 extra
também não. Adotar 3 seria arredondar. A fatia de reconciliação tem de
guardar outro discriminante ou aceitar `outdated` residual; o k de captura,
se existir, é só para baixar a taxa (k=3 zera `.md` e quase zera `.css`/`.tsx`,
média 357 B/nota), não para prometer casamento único.

## Superfície aposentada pela SDD 513 (2026-08-17)

O mecanismo desta spec fica. A **superfície** foi aposentada no mesmo dia em que shipou, depois do
primeiro uso real: escrever uma nota fazia o painel Comments do VS Code se revelar sozinho e tomar a
barra inferior. Decisão do dono: *"vamos aposentar isso e criar nosso proprio diffreview integrado com
nosso sistema e nao usar do vscode que fica pessimo em UX"*.

**Isto reverte a minha recomendação.** Eu recomendei o Desenho 1 — hospedar no editor nativo — com o
argumento de que possuir o editor compra ergonomia e não corretude. O argumento sobre corretude
continua certo. O que eu subestimei foi que a ergonomia **é** o produto aqui: a feature existe porque
apontar em prosa no chat tinha ergonomia ruim, e trocar ergonomia ruim por outra não era o objetivo.

**A reversão custou um arquivo, e isso não foi sorte.** Medido no dia:

    engine, agnóstico ..................  977 linhas — identidade, snapshot, reconciliação,
                                                       outdated, store, protocolo, projeção, comandos
    apps/.../review/comments.ts ........  665 linhas — o único acoplamento

A decisão de **não colocar URI na identidade da nota** foi tomada nesta spec justamente para a
superfície de render não decidir nada durável. Ela pagou exatamente como previsto.

A prova da fatia 0a — `CommentController` aceita thread em URI virtual read-only — fica sem uso, mas
continua válida e medida. Se algum dia alguém quiser voltar ao editor nativo, a pergunta já está
respondida.

Continuação em `docs/specs/513-tachyon-diff-review/`.
