# A cadência de merge do coordenador — medição de 2026-08-13 (t-fe60a3)

A task foi aberta por mim contra mim em 2026-08-10. A tese era: como a prova é por árvore, cada merge
meu na `main` invalida a atestação de todo agente em voo, e eu passei o dia cobrando reintegração sem
ver que a fonte era a minha ordem de merge.

Três dias depois a tese se sustenta, mas **o custo não está onde eu escrevi que estava**, e uma das
evidências que eu citei era leitura errada minha.

---

## 1. A pergunta que a task mandou responder primeiro

> *"Quantos dos merges realmente conflitam. Contar, sobre os merges de hoje e de ontem, quantos pares
> (entrega, colisão) tocam arquivos disjuntos."*

Dez merges na `main` hoje (first-parent). Comparando os arquivos tocados por cada um contra todos os
outros:

```
merges .................. 10
pares possíveis ......... 45
pares DISJUNTOS ......... 40   (88 %)
pares com OVERLAP .......  5   (12 %)
```

Os cinco que se tocam:

| par | arquivos em comum |
|---|---|
| `96b8b5bc` × `d1247819` | `ide-browser-bridge/manager.ts` |
| `96b8b5bc` × `db4c3b6c` | `ide-browser-bridge/manager.ts` |
| `d1247819` × `db4c3b6c` | `DesignModePanel.ts`, `design-mode/App.tsx`, `design-mode.css`, `manager.ts` |
| `a54cf920` × `976c9b79` | `bridge.test.ts`, `bridgeToolCountLunaR1Behavior.gen.test.ts`, `selfEvolutionRemoved.test.ts` |
| `d9c56f54` × `49a23357` | o mesmo `.md` de pesquisa |

**88 % da reintegração de hoje foi semanticamente vazia.** Rodou um gate completo sobre mudanças que
não conseguem interagir.

## 2. E os 12 % que colidiram não vieram da ordem de merge

O par mais caro — `d1247819` × `db4c3b6c`, quatro arquivos incluindo dois da mesma tela — foi **erro
meu de dispatch, não de cadência**. Eu soltei `viewportsel` e `pickshot` ao mesmo tempo em cima do
mesmo painel do Design Mode. Nenhuma ordem de merge desfaz isso: os dois iam escrever no mesmo
`App.tsx` de qualquer jeito, e o conflito consumiu um terceiro agente (`pickmerge`) para resolver.

O par `d9c56f54` × `49a23357` são dois commits meus no mesmo documento — custo zero.

Sobra `manager.ts`, que é o ponto de encontro real do Design Mode, e o par de testes de contagem, que
foi sequência deliberada (um adicionou tool, o outro apagou os testes que travavam o total).

**A conclusão inverte metade da task:** a ordem de merge é barata de arrumar; a escolha de quem
despachar junto é o que custa.

## 3. Aderência de trunk: 60 % → 80 %

A t-fb7025 mediu em 2026-08-09 que 24 de 60 estados da `main` não tinham registro de gate — 8 deles
merges cujo conteúdo nenhum gate jamais viu. Foi por isso que ela recusou tirar a rede da branch:
*"trocar um custo conhecido por um risco não contabilizado."*

Hoje:

```
estados first-parent da main .... 15
com registro de verify .......... 12   (80 %)
sem ..............................  3
```

Os três sem registro são merges cuja árvore combinada difere da árvore atestada da branch, porque a
`main` andou entre a atestação e o merge:

```
a54cf920  merge(t-a8b630)  retask de Temporary vivo
d1247819  merge(t-0807b2)  seletor de responsividade
976c9b79  merge(t-33b5cd)  testes de contagem
```

Nos três eu escolhi landar mesmo assim. Nos três a justificativa foi overlap de arquivo zero contra o
que já estava na `main`. **Isso é um julgamento meu, não uma prova**, e é o resíduo honesto desta
medição.

### 3.1 O caso limpo existe, e é barato

Enquanto eu escrevia isto, a `authcount` entregou a `t-4e328b`. Ela gateou contra a ponta da `main` e
eu segurei a `main` parada até ela terminar. Resultado:

```
árvore atestada da branch ..... 42581b3f
árvore do merge commit ........ 42581b3f   (idêntica)
```

**O estado de trunk nasceu provado, de graça.** Nenhum re-gate, nenhuma reintegração, e o registro de
verify cobre exatamente o que entrou — não uma aproximação dele.

É a diferença entre os três merges sem registro da seção acima e este: nos três eu mergeei enquanto
a `main` já tinha andado; aqui eu esperei. O custo de esperar foram alguns minutos meus; o custo de
não esperar foi um estado de trunk que ninguém pode provar.

## 4. A evidência que eu li errado

O corpo da task diz:

> *"a §6.1 da t-fb7025 registra um gate vermelho num merge cujo diff era só `.md`, então a exigência
> tem base."*

Fui ler. A §6.1 é **flakiness de carga**, não interação semântica: dois testes falharam na árvore
combinada e os dois passaram isolados imediatamente depois, sem alteração nenhuma. É a terceira
natureza de vermelho — carga —, não a primeira.

Então a §6.1 não sustenta a exigência. Ela argumenta o contrário: o gate ficou vermelho numa mudança
que não podia interagir com nada, o que diz mais sobre a máquina do que sobre o commit.

Corrigido aqui em vez de ficar no corpo da task, porque eu dispachei trabalho citando essa leitura.

## 5. O que NÃO fazer, e isso já estava medido

A t-fb7025 §7 recusou, com número, as três saídas que parecem óbvias:

| saída | por que não |
|---|---|
| tier `affected` na branch | 12 % dos testes mas 41 % do custo; 0 testes para o vazamento nº 1 já medido; e o mecanismo foi removido do produto (`t-f559b6`) |
| cache por árvore parcial | 2 a 11 rodadas de 99; exige manter à mão para sempre a lista do que a suíte lê, lista que já apodreceu duas vezes |
| afrouxar o lock | 0 % de sobreposição e 10 % de ocupação — não há disputa para resolver |

Nada aqui reabre isso. O que sobra é ordenação minha, escrita, que é exatamente o que a task previu:
*"a saída mais provável é disciplina de ordenação minha, escrita, não um orquestrador de merge."*

## 6. A regra que sai daqui

Vai para `docs/project-guidance.md` § Verification economy. Três linhas, nenhuma máquina nova:

1. **Overlap de arquivo se checa ANTES de despachar.** Duas tasks na mesma tela colidem por
   construção, e nenhuma ordem de merge conserta.
2. **No merge, comparar os arquivos da branch que entra contra cada branch em voo.** Zero overlap →
   as atestações individuais cobrem e ninguém regateia. Overlap → a árvore combinada é a única prova,
   e só o agente que se toca regateia.
3. **Branch que CONSERTA o gate fura a fila.** Segurar ela atrás do protocolo de notify-before-gate
   mantém todo mundo vermelho.

Limite declarado do item 2: arquivos disjuntos é sinal forte, não prova. A quebra que ele não pega é
cross-file — A adiciona chamador num arquivo, B muda a assinatura noutro. O `typecheck` do gate pega
essa classe, e é a primeira etapa; não é motivo para máquina nova.

---

## Apêndice — reprodução

```sh
# 1. os merges de hoje e os arquivos de cada um
git log --first-parent --merges --since="2026-08-13 00:00" --format='%H' main

# 2. pares disjuntos vs com overlap (itertools.combinations sobre os name-only)

# 3. aderência de trunk: todo estado first-parent tem refs/tachyon/verify/<tree>?
git log --first-parent --since="2026-08-13 00:00" --format='%h %T %s' main | while read SH TR S; do
  git rev-parse --verify -q "refs/tachyon/verify/$TR" >/dev/null || echo "SEM GATE: $SH $S"
done

# 4. registros de verify por dia
git for-each-ref 'refs/tachyon/verify/*' --format='%(refname)' | while read r; do
  git cat-file -p "$r" | grep -o '"at": "[0-9-]*' | cut -d'"' -f4
done | sort | uniq -c
```
