# 505 — as dez perguntas, respondidas

_Respondidas 2026-08-13. Quatro por medição (claude), seis pelo dono._

O `questions.md` é a pergunta e o caso. Este arquivo é a resposta e quem deu.

---

## Respondidas por medição, sem decisão de gosto envolvida

### Q1 — a restrição do agent pane é de FONTE, não de token

O pane **já carrega** `quick-picker.css`. Isso prova, no próprio produto, que uma folha carrega token
sem carregar `@font-face` — que era exatamente a dúvida.

E os tokens privados dele **discordam** dos que já estão vivos na mesma página: `--ds-border` mistura
a 22%, o `--agent-pane-border` a 18%; `--ds-fg` ancora em `--vscode-foreground`, o dele em
`--vscode-editor-foreground`. Duas linguagens deliberadas não divergem por 4 pontos percentuais sem
ninguém escrever por quê. Isso é deriva, não decisão.

**Consequência:** separar TOKENS de FACES. O pane liga a folha de token e pula a de fonte. As 16
declarações privadas dele em sua maioria somem.

### Q3 — a fonte única é a folha CSS; o TypeScript é gerado dela

Gerar `themeTokens.ts` a partir da folha, não o contrário. A folha é o artefato que uma pessoa de
design abre; o TypeScript não é.

### Q4 — os oito roles que só existem no `themeTokens.ts` NÃO são roles do produto

Medido em `src/webview/`:

    --ds-sash-hover      0 usos em CSS
    --ds-surface         0
    --ds-surface-raised  1
    --ds-separator       3

Não são papéis que o produto tem e o sistema não nomeia. São nomes do overlay que vazaram para uma
lista compartilhada.

### Q7 — o ponto de status é 7px

Quatro implementações, duas medidas, **nenhuma com motivo registrado** em nenhuma delas. 7px aparece
3×, 8px 2×. Não há decisão a preservar, então vale a maioria. Um ponto, 7px.

---

## Respondidas pelo dono

### Q2 — o terminal passa a ler o tema

O terminal do agente tinha 21 cores fixas e ficava um retângulo escuro dentro de um editor claro. Era
o único lugar medido onde a restrição do produto não valia, e ninguém tinha decidido isso — o
comentário no lint descrevia uma falta, não uma escolha.

**Decisão: (b).** O pane amostra `--vscode-terminal-ansi*` e o fundo/frente do editor.

### Q5 — o fundo claro atrás de imagem é exceção, e ganha nome

QR code e PNG transparente precisam de superfície clara para serem legíveis, em qualquer tema. É
exigência do conteúdo, não preferência.

**Decisão: (a).** Nasce `--ds-plate` / `--ds-plate-fg`, documentado como a única cor que não vem do
tema, e quatro exceções de lint morrem.

### Q6 — DESENHAR a escala, não descobrir

Esta é a resposta que muda o tamanho de tudo.

A regra declarada (4/8/12/16/24/32) é ignorada por 61% dos valores; o valor mais usado do produto é
6px, 155 vezes, e não é passo dela. Eu recomendei DESCOBRIR — adotar o que já se usa, barato e
honesto.

**O dono olhou o produto e disse o contrário, e a razão é o que decide:** *"o sistema esta todo
incompativel, telas mudam a aparencia e a distancia e tamanho das coisas me incomoda sim"*.

Descobrir só é a resposta certa quando o resultado atual não incomoda. Ele incomoda. Então a escala
não pode ser a fotografia do acúmulo — tem de ser decidida.

**Decisão: (b), e SÓ PARA O ESPAÇO.** Logo depois de decidir, o dono restringiu: *"tipografia vamos
manter como temos hoje, me agrada a tipografia escolhida"*.

Perguntei o que "manter a tipografia" abrangia, porque cabiam duas leituras. Resposta: *"manter
familias, definir desenhar rampa"*.

Então o recorte final:

    FAMÍLIAS ....... FIXAS. Tachyon Mono, sans e reading agradam e não entram em discussão.
    ESPAÇO ......... DESENHADO.
    RAMPA DE TIPO .. DESENHADA, igual ao espaço.

O que isso resolve por consequência: os **76 usos de `10px` em 14 arquivos** não ficam legitimados por
serem frequentes. A rampa desenhada decide se existe um passo ali ou se aqueles 76 estavam errados —
e os dois desfechos são aceitáveis porque agora alguém decide, em vez de o número vencer por
repetição.

~800 pontos de espaço migram, mais os de tipo. A fatia 8 cresce, e isso está aceito de olhos abertos.

### Q8 — DUAS densidades, nomeadas

Telas de operar (sidebar, board, plugins) e telas de ler (activity, handoff, rich-doc, task detail)
já se comportam diferente, escritas à mão. O padding de card varia 2,5× sem nenhum token nomear isso.

**Decisão: (a).** Um eixo `dense` / `comfortable` nos primitivos compartilhados. Apertar as telas de
leitura até a régua da sidebar seria mudar justamente o que mais se lê.

### Q9 — o overlay é HÓSPEDE, com espaço de nome próprio

O argumento de que a escala do produto não governa página alheia vale para o empilhamento externo. Não
vale para os números internos do overlay, que são chrome dele mesmo.

**Decisão: (a).** Os tokens privados dele ganham prefixo próprio para pararem de se parecer com
tokens do design system, e as exceções mantêm as razões.

### Q10 — `--ds-*` é o sistema; shadcn e Tailwind são encanamento

Um conceito — o fundo do card — tem quatro nomes hoje. Quem escreve o produto precisa de um
vocabulário só.

**Decisão: (a).** A ponte para shadcn passa a ser gerada a partir de `--ds-*` em vez de escrita ao
lado. E fica registrado o fato que pesa na conversa seguinte: o piloto de Tailwind está em **5 das 36
superfícies depois de três specs** — vale decidir se encerra, mas isso é outra pergunta.

---

## O que estas respostas mudam na rota do `spec.md` §7

    Fatia 1   desbloqueada por Q1 — separar TOKENS de FACES
    Fatia 2   desbloqueada por Q3 — gerar o TypeScript a partir da folha
    Fatia 3   nunca dependeu de resposta
    Fatia 4   muda de natureza por Q6: não é mais "nomear o que existe", é "desenhar e depois nomear"
    Fatia 6   ganha o eixo de densidade de Q8
    Fatia 8   CRESCE — a migração deixa de ser mecânica
    Fatia 9   fica menor por Q9: prefixo próprio em vez de reconciliação

A Q6 é a única que aumenta o custo, e foi decidida sabendo disso.

---

## Q6 e Q8, resolvidas — 2026-08-15

A Q6 tinha sido decidida como **desenhar, não descobrir**, e ficou parada esperando o ato de design.
Ela destravou por um caminho que ninguém tinha proposto: o dono cortou a pergunta ao dizer *"essas
decisoes de ux se baseie e benchmarks de chrome, shell, design"*. Medir prior art em vez de inventar.

A medição está em [`benchmark.md`](./benchmark.md), 590 linhas, três referências lidas **em disco** e
não em documentação: VS Code 1.133.0 (a build exata que o dono roda, servidor WSL e cliente Windows
no mesmo commit), Chrome DevTools 151, e o Radix/shadcn/Tailwind já vendorizado aqui.

### O achado que mudou a natureza da decisão

**O VS Code 1.133 tem um registro de tokens de TAMANHO, no mesmo formato do registro de cores, e o
injeta no webview.**

    spacing.size20    2px      cornerRadius.xSmall  2px      bodyFontSize        13px
    spacing.size40    4px      cornerRadius.small   4px      bodyFontSize.small  12px
    spacing.size60    6px      cornerRadius.medium  6px      strokeThickness      1px
    spacing.size80    8px      cornerRadius.large   8px
    spacing.size100  10px      cornerRadius.xLarge 12px
    spacing.size120  12px
    spacing.size160  16px      fontSize.label3 10 · label2 11 · label1 12 · body1 13
    spacing.size200  20px      fontSize.heading3 13 · heading2 18 · heading1 26

Isso reformula a pergunta. Não era "que escala inventar" — era **quanto herdar do host**.

E revelou uma convergência que já existia sem ninguém saber: `spacing.size60` é `6px`, o valor mais
usado do produto (146 ocorrências), que o coordenador tinha classificado como "ajuste de olho" ao
apresentar os números ao dono. Não era. `--ds-radius: 6px` também é exatamente `cornerRadius.medium`.
**Convergiu; não foi adotado** — a distinção importa porque a Q6 recusou adotar.

### Espaço — decisão: opção A, dez passos, herdados

    2, 4, 6, 8, 10, 12, 16, 20, 24, 32        194 de 792 ocorrencias mudam (24%)

Dez passos parece muito e não é, porque não são invenção nossa: são o registro do host. É a única
opção que permite escrever `var(--vscode-spacing-size60, 6px)` e fazer o **espaçamento vir do tema,
como a cor já vem**. Se a Microsoft reescalar a densidade do editor, o Tachyon acompanha sem commit.

O eixo real da escolha era `10px`. A opção B (oito passos, todos com concordância unânime das três
referências) o mata em 73 lugares — 81 ocorrências de diferença para A. Matar um passo que o HOST
declara, para ganhar simetria com o Material do DevTools, é pagar para ficar menos parecido com o
programa onde rodamos.

**A opção C foi recusada pela medição, não por gosto.** Ela mata `6px` (146 usos) e `2px` (70 usos), e
os dois são passo unânime das TRÊS referências. C não é "mais rigorosa que B" — é B com dois passos
removidos por simetria, contra o que as referências dizem.

Uma correção de fato que a medição trouxe: **a menor distância utilizável é 2px, não 4px.** As três
referências a declaram, e as duas que separam traço de espaço declaram `1px` como espessura de traço e
nunca como distância. O custo de eliminar `1px` como espaço é 19 ocorrências, não as 164 que o cartão
antecipava.

### Rampa — decisão: rampa 3, duas densidades nomeadas

    operador   10, 11, 12, 13     do VS Code — a régua do chrome do host
    leitura        13, 16, 20     do DevTools — a régua do conteúdo
                                  47 de 464 declaracoes mudam (10%)

Sete papéis sobre seis valores, com `13px` sendo papel nos dois lados. **É a mais barata das três E a
única que aplica a Q8** — o dono já tinha decidido duas densidades ao perceber que apertar as
superfícies de leitura machucaria o que mais se lê; as rampas 1 e 2 ignoram isso.

A dobradiça em `13px` não é arbitrária: é o `--vscode-font-size` do host. As duas densidades se
encontram no tamanho que o editor já usa.

**A rampa 2 foi recusada por consequência prática**: ela faz 91 declarações CRESCEREM (10px→11px em 75
lugares, 9px→11px em 16). Numa sidebar já apertada isso move a densidade para o lado errado do
incômodo que originou a SDD.

E a rampa 3 resolve metade de *"a distância das coisas me incomoda"* que ninguém tinha nomeado: as
**13 entrelinhas distintas em 74 declarações** passam a ter dono, porque cada degrau de leitura carrega
a sua — o DevTools declara o par tamanho/entrelinha, o VS Code declara só o tamanho.

Em todas as três rampas, os quatro meios-pixels (`9.5`, `10.5`, `12.5`, `13.5`) desaparecem: nenhuma
referência medida tem meio pixel em lugar nenhum. E os onze tamanhos de texto de hoje viram cinco.

### A cessão de controle, declarada

Herdar do host significa aceitar que a Microsoft mexa na nossa densidade sem nos avisar. O dono
decidiu sabendo: *"herdar do host faz sentido po, ja usamos as cores"*.

O precedente sustenta: a cor já funciona assim desde sempre e nunca gerou reclamação. A diferença é
que a cor era a ÚNICA restrição declarada do design system — agora espaço, raio e rampa entram no
mesmo contrato.

**Consequência de manutenção, e é obrigatória:** `engines.vscode` é `^1.96.0` e os tokens são de
1.133. Todo consumo de token do host sai com fallback — `var(--vscode-spacing-size60, 6px)` — e o
fallback é o valor medido, não um chute.

### O que isto muda na rota

    Fatia 4   DESBLOQUEADA — a escala existe e cada passo tem referencia medida
    Fatia 6   ganha os degraus nomeados de operador e leitura, nao so o padding
    Fatia 8   segue grande, mas o custo agora e um NUMERO: 194 ocorrencias de espaco
              e 47 de tipo, nao uma estimativa
