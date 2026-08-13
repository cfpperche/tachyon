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

Então:

    ESPAÇO ....... desenhado. ~800 pontos migram. A fatia 8 cresce, e isso está aceito de olhos abertos.
    TIPOGRAFIA ... fica como está. As famílias escolhidas agradam e não entram em discussão.

ABERTO, e é estreito: a rampa declarada é 16/13/12/11, e `10px` aparece **76 vezes em 14 arquivos**,
abaixo do menor passo. "Manter a tipografia" pode significar duas coisas aqui — manter as famílias e
aceitar o 10px como passo real, ou manter a rampa exatamente como está e tratar os 76 usos como
desvio a corrigir. Perguntado ao dono; não presumido.

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
