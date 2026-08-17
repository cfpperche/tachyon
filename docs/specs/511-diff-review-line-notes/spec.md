# 511 — diff-review-line-notes

_Created 2026-08-17._

**Status:** shipped-partial
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**Closure:** o MECANISMO shipou na 0.93.10 — âncora sem URI, reconciliação na leitura, `outdated`,
store, protocolo e lote (977 linhas de engine, `48c42a9d` + `14ad1514`). A SUPERFÍCIE foi aposentada
no mesmo dia pela SDD 513, depois do primeiro uso real: o painel Comments do VS Code se revelava
sozinho. `apps/vscode-extension/src/review/comments.ts` sai; o engine fica. Ver `notes.md`.

## Intent

Hoje o review de um diff de agente acontece em prosa. O humano abre o diff, aponta um problema no
chat, e o coordenador transforma aquilo em contrato. Funciona, e não deixa rastro: o apontamento não
existe em lugar nenhum depois que a conversa passa. Palavras do dono: *"alternativa em prosa funciona
mas nao é algo estruturado, fica a cargo tanto de você lembrar quanto eu"*.

Quase toda a máquina para consertar isso já existe no produto. A tela de review existe
(`tachyon.reviewWorktreeItem`, hoje escondida da paleta com `when: false`): ela lista os arquivos
mudados contra um `baseRef` e abre o diff nativo com um content provider próprio. A leitura git é do
engine (`worktree.review`). A entrega ao agente existe. O registro imutável existe
(`attach_evidence`). **Falta uma peça só: a nota presa a uma linha, que continue apontando para o
lugar certo depois que o agente mexe no arquivo.**

Feito é: o humano comenta na régua do diff nativo, junta quantas notas quiser, manda o lote ao agente
num comando, e ao reabrir o diff as notas voltam — reconciliadas quando o deslocamento é mecânico, e
marcadas `outdated` quando a linha morreu ou o casamento é ambíguo. O mecanismo nunca finge precisão.

A medição que fundamenta o desenho está em `docs/research/t-00bf87-orca-diff-comment-anchors.md`
(task `t-00bf87`): a Orca não reancora entre snapshots, e a promessa da doc pública dela não se
sustenta no fonte. O VS Code, por outro lado, move o range de graça enquanto o documento está aberto.
Disso vem a decisão central: **o snapshot é a verdade e o range da plataforma é dica.**

## Acceptance criteria

- [ ] **Scenario: uma nota nasce na linha**
  - **Given** o diff de uma worktree de agente aberto pelo comando de review que já existe
  - **When** o humano usa a régua na linha e escreve uma nota
  - **Then** a nota aparece na linha, é listada no painel Comments do VS Code, e passa a existir no
    registro durável com `baseRef`, path, lado, range e o snapshot do conteúdo observado

- [ ] **Scenario: o lote chega ao agente como contrato**
  - **Given** duas ou mais notas em um ou mais arquivos da mesma worktree
  - **When** o humano manda as notas ao agente escolhido
  - **Then** o agente recebe **um** prompt com todas as notas, cada uma citando `path:linha` e
    prioridade, e o mesmo lote fica registrado por `attach_evidence` como o que foi entregue

- [ ] **Scenario: deslocamento mecânico migra**
  - **Given** uma nota na linha 28 e um registro cujo snapshot bate
  - **When** o agente insere linhas acima dela e commita, e o humano reabre o diff
  - **Then** a nota reaparece na linha nova, o registro guarda o range novo, e o journal do
    reconcílio nomeia o deslocamento

- [ ] **Scenario: linha apagada não flutua**
  - **Given** uma nota numa linha que o agente apagou
  - **When** o humano reabre o diff
  - **Then** a nota aparece como `outdated`, preservando o texto e a última posição conhecida, e
    **nunca** é reposicionada em silêncio numa linha qualquer

- [ ] **Scenario: casamento ambíguo é recusado como ambíguo**
  - **Given** uma nota numa linha cujo conteúdo passa a existir em mais de um lugar do arquivo
  - **When** a reconciliação roda
  - **Then** o resultado é `outdated`, não um palpite — ambiguidade nunca é resolvida por heurística
    silenciosa

- [ ] **Scenario: as DUAS portas do lado modificado se comportam igual**
  - **Given** uma worktree cujo lado atual do diff é o arquivo real (`vscode.Uri.file`) **e** outra
    cujo lado atual é o URI virtual do content provider (`tachyon-worktree:` com `ref`)
  - **When** o mesmo ciclo de nota, envio e reabertura roda nas duas
  - **Then** o comportamento observável é o mesmo, incluindo migração e `outdated`

- [ ] **Scenario: o range da plataforma é dica, não verdade**
  - **Given** um registro cujo range empurrado pela extensão discorda do que a reconciliação por
    snapshot deriva
  - **When** o diff é reaberto
  - **Then** a posição exibida e persistida é a derivada do snapshot, e a divergência é registrada

- [ ] **Scenario: reload não perde nota**
  - **Given** notas não enviadas numa worktree
  - **When** a janela recarrega, ou o engine reinicia, ou o agente é retomado
  - **Then** as notas voltam do registro durável antes de qualquer thread ser recriada

- [ ] O comando de review deixa de estar escondido: ele ganha entrada na paleta de comandos
- [ ] `packages/engine/src` e `packages/webview-ui/src` seguem com **zero** import de `vscode`, em
      posição de valor e de tipo — a fronteira do spec 233 não é tocada
- [ ] Nenhum webview novo é criado
- [ ] Nenhuma nota é apagada por reconciliação: `outdated` é estado, não remoção

## Non-goals

- **Não construímos editor de diff.** O código é lido no diff nativo. Decisão do dono, com o
  argumento medido: possuir o editor compra ergonomia, não corretude — a reconciliação por snapshot é
  necessária de qualquer jeito, porque nenhum range vivo sobrevive a commit, amend ou rebase.
- **Não substituímos o quick pick nem o painel Comments.** São nativos agora. Trocar é fácil e
  aditivo; fica para o dia em que incomodar.
- **Não vendorizamos nada da Orca.** Regra do dono: *"proibido vendorizar qualquer coisa do orca,
  desenvolvemos nossa propria tecnologia, mas podemos aprender como fazer com o projeto"*.
- **Não comentamos no lado base.** Só o lado modificado. O lado base é leitura.
- **Não inferimos o agente alvo.** Quem recebe o lote é escolha explícita do humano entre os agentes
  daquela worktree.
- **Não bloqueamos nada.** A nota é advisory: não recusa merge, não trava gate, não impede entrega.
- **Não é code review automático.** Quem julga é o humano; isto é o canal do julgamento dele.
- **Não abre CLI.** O registro morar no engine deixa essa porta possível de graça, e ela segue sem
  demanda (`t-c70fb9`, dropado).

## Open questions

- **Onde exatamente o registro durável mora dentro de `.tachyon/`, e qual é a chave.** A chave tem de
  distinguir worktree e `baseRef`; se ela distinguir `headRef` também, uma nota feita contra um HEAD
  antigo desaparece em vez de reconciliar. Inclinação: worktree + `baseRef` + path na identidade, com
  o `headRef` guardado como dado do snapshot. **Resolver no plano.**
- **Qual é o contexto normalizado mínimo do snapshot.** Só a linha falha em linha repetida; três
  linhas antes e depois custa mais e desambigua. **Medir no plano, não decidir por gosto.**
- **Se a reconciliação roda por porta ou por evento.** As portas conhecidas que trocam snapshot são
  reabrir o review, refresh da worktree, restart/resume, e commit/amend/rebase do agente.
  **Resolver no plano — o risco é a porta esquecida, que é a classe de defeito desta casa.**
- **Se o agente ganha uma tool da Bridge para reler as notas.** O lote já chega no contrato dele; uma
  tool só se justifica se ele precisar reler depois de compactar contexto. Owner: claude, decidir com
  medição depois do primeiro uso real.
