# Registro: usar o Claude Design a partir do terminal (t-b928fc)

Registro contínuo, escrito DEPOIS de cada passo acontecer. O corpo da t-b928fc proíbe escrever este
arquivo a partir de pesquisa — pesquisa documenta o caminho feliz que a documentação promete.

Primeira sessão: 2026-08-14.

---

## Passo 1 — descobrir como a ponte funciona

**Pretendia:** achar como levar o design system do repositório para o Claude Design.

**A interface ofereceu:** um diálogo "Use Claude Code to upload your components", com a frase que
governa tudo:

> *"Open your design-system package in Claude Code and type `/design-sync` yourself at the prompt —
> asking Claude to run it won't work."*

**Decidi sem instrução:** testar se "asking Claude won't work" era sobre o CAMINHO do texto ou sobre
a FORMA do pedido. A hipótese era que injetar `/design-sync` no composer de um subagente fosse
indistinguível de alguém digitando.

**Aconteceu:** funciona. O subagente respondeu *"The slash command arrived from outside, as
designed."* A regra é sobre pedir em linguagem natural, não sobre a origem do texto.

**Vale para qualquer projeto:** a restrição do produto é "a invocação tem de ser um slash command",
não "tem de ser um humano".

---

## Passo 2 — descobrir onde a skill roda

**Eu errei primeiro.** Recomendei rodar de um subdiretório (`src/webview/shared`) argumentando que o
repositório tinha 3,5 GB. O dono contestou: a maior parte é ignorada pelo git.

**Medido:** 36 MB rastreados. Os 3,5 GB são `node_modules` (478M), `.git` (85M), `dist` (45M) e
`.tachyon` (1,8G). O argumento não existia.

**E o prompt real da skill diz outra coisa:** ela espera a RAIZ do repositório, procura Storybook,
cai em modo `package` quando não acha, e envia o **`dist/` compilado — "never a reimplementation"**.

**Vale para qualquer projeto:** meça o que o git rastreia antes de decidir que o repositório é grande
demais. E leia o prompt da skill em vez de deduzir o diretório.

---

## Passo 3 — autorização

**Previ que travaria aqui.** Um agente Temporary tem harness próprio; eu esperava `/design-login`.

**Aconteceu o contrário:** `list_projects` autenticou de dentro do subagente e devolveu 5 projetos
reais. O login do claude.ai atravessa para a sessão filha.

**Vale para qualquer projeto:** a autorização segue a conta da máquina, não o harness do agente.

---

## Passo 4 — o bloqueio real, e ele é estrutural

**A skill é escrita para React. O nosso kit é Preact puro.**

O harness de preview da skill embarca React de verdade em `_vendor/react.js` e monta cada componente
com ele. O `_ds_bundle.js` inlina preact, porque o esbuild segue os imports do próprio barrel. Então
React chama um componente Preact, o componente chama hooks do Preact, e o dispatcher lê
`currentComponent.__H` num componente que o React nunca registrou.

    TypeError: Cannot read properties of undefined (reading '__H')     5 componentes
    TypeError: Cannot add property updater, object is not extensible   4 componentes

**Medido no build final: 17 componentes, 11 caem no cartão de piso, 6 tentam render real e 6/6 saem
em branco. Zero renderizam.**

A própria skill declara o limite no Scope: *"a non-React DS has nothing for the claude.ai/design
agent to build with."*

### E o `validate` sai 0

Este é o achado que vale mais que o bloqueio.

O `validate` termina com sucesso porque cartões de piso *"passam o portão por desenho"*. E o texto
impresso no cartão de piso diz **"The component is fully importable"** — que é falso para este
repositório.

Uma validação verde mascara incompatibilidade total de runtime. Se a gente tivesse ido até o fim,
teria subido 17 componentes que não renderizam, com o relatório dizendo que estava tudo certo.

**Vale para qualquer projeto, e é a lição mais transferível desta sessão:** rode o build local antes
do upload, e não leia a saída zero como prova. Conte quantos componentes renderizaram de verdade.

O conserto exigiria apontar `_vendor/react.js` para `preact/compat`, dentro de dois arquivos que a
skill diz explicitamente para não bifurcar. É pergunta para o upstream, não gambiarra local.

---

## Passo 5 — o que funcionou

Os **tokens** viajam. O converter achou o entry de CSS, incluiu as quatro `@font-face` com os
`.woff2`, e os tokens faltantes caíram de 49 para 12.

**Os 12 restantes são todos `--vscode-*`** — injetados pelo editor em tempo de execução. Não é
lacuna: é a nossa própria regra de "a cor vem do tema" aparecendo do outro lado da ponte. Uma cor que
não pode viajar é uma cor que está certa.

---

## Estado ao fim desta sessão

    nada foi enviado          nenhum projeto criado          nenhum commit
    HEAD cf7f4131 intocado    src/ intocado

O escopo foi cortado para build local por decisão minha, e o motivo é um erro meu de montagem: eu
pus o agente num worktree descartável, e o `.design-sync/config.json` — que guarda o id do projeto —
morreria com ele. Um sync completo dali criaria um projeto cuja âncora local se perde no mesmo
minuto, e a rodada seguinte a partir da raiz criaria um segundo.

**Vale para qualquer projeto:** o sync tem de rodar onde o `.design-sync/config.json` sobrevive.

---

# Segunda sessão — "sobe só os tokens", e ela abortou

O dono decidiu subir apenas os tokens, já que os componentes não renderizam. Agente `dstokens`.

## Passo 6 — o mecanismo de "só tokens" que eu escolhi NÃO é o mecanismo

**Eu supus** que esvaziar `componentSrcMap` deixaria os componentes de fora. Escrevi isso no contrato
como se fosse fato.

**Medido, executando o IIFE em node:** `componentSrcMap: {}` suprime o CARTÃO, o `.d.ts` e o
`.prompt.md` — zero emitidos, sem diretório `components/`. E não controla o `_ds_bundle.js`, que vem
do barrel apontado por `entry` e carrega tudo que o barrel exporta.

    cabeçalho do bundle .... "components": []
    window.TachyonDS ....... 20 exports, incluindo 17/17 componentes, todos typeof function

O arquivo declara zero componentes e exporta dezessete. Subir aquilo seria publicar os 17 Preact
quebrados sem contrato e sem cartão — exatamente o que a decisão de subir só tokens queria evitar.

**Vale para qualquer projeto:** `componentSrcMap` controla o que é DOCUMENTADO, não o que é
EMPACOTADO. Quem decide o conteúdo do bundle é o `entry`. Verifique executando o bundle, não lendo o
cabeçalho dele.

## Passo 7 — o `guidelinesGlob` varre `docs/*.md` por padrão

Sem ninguém pedir, a rodada recolheu **4 documentos internos, ~60 KB, com 28 ids de task**:

    project-guidance.md ............ histórico de incidentes, postura de sandbox por runtime,
                                     falas do mantenedor
    system-design.md
    tachyon-capability-matrix.md
    STYLEGUIDE.md .................. o único que é plausivelmente guia de design

**Vale para qualquer projeto, e é a lição mais transferível desta sessão:** restrinja
`guidelinesGlob` ANTES da primeira rodada. O padrão assume que `docs/` é documentação de design; num
repositório com documentação interna, ele publica o que ninguém pediu, e nada avisa.

## A decisão: abortar

Havia uma saída: apontar `entry` para um módulo que não exporte componente, mantendo `cssEntry` e
`extraFonts`. Tokens de verdade, e funcionaria.

O dono recusou: *"aborta, nao vale driblar a ferramenta"*.

A razão é mais forte que a conveniência. A skill existe para levar o design system COMPILADO — ela
diz, na própria documentação, *"the bundle is their compiled `dist/`, never a reimplementation"*. Um
entry vazio faz ela subir um sistema que não existe, e tudo que voltasse de lá seria construído sobre
uma mentira que nós mesmos plantamos.

## Correção de um número meu

Eu havia reportado 56 tokens. São **61** — 54 `--ds-*` mais 7 `--tachyon-*`. A minha contagem
ancorava em início de linha e perdia declarações inline. O 61 bate com o README.

## Estado ao fim da segunda sessão

    nada enviado    nenhum projeto criado    finalize_plan NUNCA chamado
    sem commit      HEAD 4cb6aed1 intocado   src/ intocado

Quatro descobertas, zero bytes publicados.
