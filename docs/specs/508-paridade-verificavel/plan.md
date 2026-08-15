# SDD 508 — plano

## Decisões, e o que foi rejeitado

### D1 — a tabela mora em código, e o `.md` continua narrativa

**Rejeitado: fazer o teste ler o `docs/runtimes/parity.md`.** O dono cortou isso na origem: *"a matriz é documento, o teste não é sobre um arquivo `.md` e sim sobre o código"*. Um parser de markdown testaria a formatação da prosa, não a capacidade — e daria a sensação de cobertura pela via mais frágil possível.

**Rejeitado também: gerar o `.md` a partir da tabela, agora.** Pode ser certo depois. Fazer junto acopla duas mudanças e esconde qual das duas quebrou.

### D2 — três vereditos, e cada um tem uma prova de natureza diferente

    wired      derivado do produto pelo teste
    measured   dogfood; a célula carrega versão e data, e o teste só cobra o lastro
    cannot     motivo escrito obrigatório

**Rejeitado: um booleano.** Um booleano obriga a mentir em duas situações — quando a capacidade existe mas só o CLI real pode provar, e quando ela não se aplica àquele runtime. Foi assim que os hooks do grok ficaram invisíveis: o flag era booleano e a diferença não tinha onde ser dita.

### D3 — derivar, nunca repetir

Um teste que reafirma o valor que deveria vigiar passa para sempre. A regra: **o teste chama a função que o PRODUTO usa para decidir**, com entrada por runtime, e compara com a tabela.

Precedente vivo: `agentRuntimeAdmission.ts` deriva sua lista de `KNOWN_AI_CLIS` menos os suportados menos os que têm resume ou brief, exatamente para que uma mudança de catálogo não passe despercebida.

### D4 — provar a catraca falhando, não passando

O defeito mais provável desta SDD é o teste virar tautologia sem ninguém notar. Um teste tautológico é verde e permanece verde.

**Cada dimensão derivável entrega, junto, a prova de que o teste FICA VERMELHO quando o produto muda.** É o mesmo padrão que fechou a extração 1 da fronteira bridge e a inclusão do grok nos hooks: provar que o guarda late fazendo ele latir.

### D5 — começar por duas ou três dimensões, não pelas 22

Se o desenho não servir para as mais fáceis, não serve para as outras — e descobrimos com três células em jogo em vez de 66.

**Rejeitado: classificar as 22 primeiro e implementar depois.** Classificar no papel produz uma taxonomia que a primeira implementação real contradiz. A classificação sai da tentativa.

## Ordem das fatias

    1  o instrumento, provado em 2 ou 3 dimensões deriváveis      inclui a prova de vermelho
    2  classificar as 22: derivável, medida ou impossível         medição, sem implementar
    3  as deriváveis restantes                                    volume, guiado pela 2
    4  as medidas: lastro de versão e data, e o que falta medir
    5  os "seams" que nunca viraram linha                         cada um: dimensão ou motivo com data
    6  fechar: a tabela e o .md não se contradizem

A fatia 1 escolhe as dimensões pelo critério "o produto já decide isso numa função que dá para chamar". Candidatos naturais, a confirmar na fatia: **hooks de sessão** (o caso que originou tudo), **row 9 permission inject** (a definição já diz *"um profile medido com zero leitores é ✗"*, que é uma pergunta sobre o código), e **row 13 headless probe** (a definição já cita adapter registrado e schema, ambos verificáveis).

## Riscos, e o que fazer quando acontecerem

- **Uma dimensão parece derivável e não é.** Diga na fatia 2 com o motivo; classificar como `measured` é resultado, não desistência.
- **A tabela cresce além do que o teste deriva.** Se mais da metade das células virar `measured` sem lastro, a SDD está produzindo prosa em TypeScript — pare e me avise.
- **O `.md` e a tabela discordam na fatia 6.** Isso é achado, não obstáculo: significa que a prosa afirmava algo que o código nunca fez. Cada desacordo vira cartão antes de qualquer texto ser ajustado.
