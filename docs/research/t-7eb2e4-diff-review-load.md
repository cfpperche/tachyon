# t-7eb2e4 — carga real de um diff review

Medição feita em 2026-08-17 para a fatia 0 da SDD 513. O resultado decide carga e geometria; não
desenha a tela.

## Amostra e método

Reaproveitei integralmente os **28 landings de `main`** declarados por
`scripts/research/t-232111-snapshot-k.mjs`: eles já formavam uma amostra de reviews reais por
commit contra o primeiro pai, tinham contagem por arquivo e incluíam de propósito os dois extremos
citados no pedido. Não usei os worktrees vivos `tachyon/claude` e `tachyon/medidacodex`: ambos
partiam de `994ae520` sem diff no início da medição, portanto acrescentariam dois zeros artificiais.
Cada landing abaixo reconstrói o diff da worktree que pousou como `sha^1..sha`.

Contei `.ts`, `.tsx`, `.css`, `.json` e `.md`, como a amostra original, e excluí
`package-lock.json`. Diferentemente do probe anterior, que só precisava do lado modificado e por
isso descartava arquivos apagados, a tela precisa mostrar deleções. Por isso há duas colunas: todos
os arquivos que o review renderiza e os que ainda têm lado modificado. Essa diferença explica o
outlier conhecido de **106**: `55de2fc4` tem 106 arquivos no lado modificado, mas 131 quando as 25
deleções que o review também precisa mostrar entram na conta.

| commit | arquivos no review | lado modificado | linhas `+` + `-` |
|---|---:|---:|---:|
| `c99bdf1c` | 1 | 1 | 107 |
| `2adbe15d` | 11 | 11 | 86 |
| `3d164933` | 43 | 30 | 4.034 |
| `29d50032` | 1 | 1 | 126 |
| `65243380` | 3 | 3 | 18 |
| `8873ad7e` | 2 | 2 | 159 |
| `f1efd419` | 2 | 2 | 41 |
| `c2967a44` | 1 | 1 | 37 |
| `473c1aca` | 23 | 23 | 712 |
| `8591113f` | 1 | 1 | 150 |
| `e8e3202b` | 1 | 1 | 114 |
| `551f7fe4` | 1 | 1 | 152 |
| `b35adb44` | 1 | 1 | 184 |
| `123e86fe` | 3 | 3 | 312 |
| `309745fe` | 7 | 7 | 339 |
| `2778ccc4` | **76** | **76** | **5.354** |
| `d4668e19` | 3 | 3 | 257 |
| `ee7d3450` | 6 | 6 | 1.126 |
| `2bbdbba4` | 6 | 6 | 226 |
| `1e472d9e` | 3 | 3 | 389 |
| `3b720d06` | 16 | 16 | 1.321 |
| `11879842` | 8 | 8 | 154 |
| `0718d20e` | 3 | 3 | 199 |
| `a855d463` | 3 | 3 | 81 |
| `00ac7ff1` | 5 | 5 | 250 |
| `faf15070` | 5 | 5 | 289 |
| `774161b8` | 5 | 5 | 137 |
| `55de2fc4` | **131** | **106** | **4.278** |

O probe reproduzível é `scripts/research/t-7eb2e4-diff-load.mjs`; ele usa apenas `git`,
`highlight.js`, Chromium headless para medir `ch`, e relógio monotônico.

## 1. Quanto um review carrega

Nos 28 reviews e 371 pares commit×arquivo, o típico (mediana) é **3 arquivos e 184 linhas
alteradas no total**. O p90 é 43 arquivos e 4.034 linhas. O máximo por eixo não é o mesmo review:
**131 arquivos** em `55de2fc4`, e **5.354 linhas** em `2778ccc4`. Por arquivo, a mediana é **18
linhas alteradas**, p90 165 e máximo **652**.

**Recomendação 1:** mostrar uma lista de arquivos e materializar o diff de **um arquivo selecionado
por vez**, sem paginar o arquivo. O caso típico é pequeno, mas montar todos os arquivos de uma vez
faz o extremo carregar 131 árvores de DOM e mais de cinco mil linhas sem benefício para a leitura.

## 2. Quanto custa `highlight.js`

O maior arquivo real da amostra é
`packages/engine/src/workspace/Workspace.ts` em `2778ccc4`: **7.378 linhas, 381.252 caracteres**.
Depois de cinco aquecimentos, 30 execuções de
`hljs.highlight(source, { language: "typescript" })` no Node 24.11.1 desta máquina deram **78,9 ms
de mediana**, 82,5 ms p90 e 86,1 ms máximo. É 4,7 vezes um frame de 16,7 ms e bloqueia a thread da
webview por tempo perceptível. A guarda atual de 20.000 caracteres não é excesso: este arquivo tem
19 vezes esse limite.

**Recomendação 2:** manter o corte explícito de **20.000 caracteres por arquivo**: acima dele,
renderizar código escapado sem realce e mostrar “realce desativado neste arquivo (grande)”. Não
realçar silenciosamente nem tentar o arquivo inteiro na thread da webview.

## 3. Unificado ou lado a lado

Medi a largura de uma aba no padrão do repositório, **880 px**. No Chrome 151, `12px monospace`
mede 7,2246 px por `ch`. Reservei 96 px para régua, sinal e padding no unificado: sobram **108
colunas**. No lado a lado, duas réguas, dois paddings e o divisor consomem 168 px: sobram **49
colunas por lado**. Tabs contam como quatro colunas.

Contra as 20.619 linhas realmente adicionadas ou removidas na amostra, o unificado contém sem corte
**19.271 (93,46%)**; o lado a lado contém **11.709 (56,79%)** por painel. Nenhum formato elimina
scroll horizontal em toda a amostra — a maior linha tem 872 colunas —, mas o lado a lado corta
quase uma linha em duas antes mesmo de notas ou controles.

**Recomendação 3:** usar **unificado como único formato inicial**, com scroll horizontal para os
6,54% de linhas que excedem 108 colunas. Lado a lado não cabe na aba medida: só 56,79% das linhas
cabem em cada metade, portanto não deve entrar na primeira superfície.

## Custo da própria medição

Uma execução completa do probe custou **3,78 s de parede**, incluindo 28 diffs Git, 35 realces
(cinco warm-ups + 30 amostras) e a inicialização/fechamento do Chrome. O envelope de
`performance.now()` mediu **0,000026 ms (26 ns) de mediana** em 100.000 pares de leituras. Tudo roda
offline por comando; nenhum probe entrou no engine, no tick ou em outro caminho do produto, então o
custo no caminho quente é **zero**. O probe anterior reaproveitado levou 10,11 s nesta árvore, também
offline; seus dados foram reutilizados, não recolhidos por instrumentação residente.

