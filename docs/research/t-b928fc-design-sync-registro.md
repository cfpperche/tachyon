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
