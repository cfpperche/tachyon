# Registro de despachos — runtime × modelo × effort

_Aberto em 2026-08-05. Mantido pelo coordenador, escrito no MERGE de cada entrega._

## Por que existe

O coordenador precisa escolher runtime, modelo e effort para cada despacho. Até 2026-08-05 essa escolha era **palpite**: "codex é o revisor adversarial", "grok é fraco para arquitetura". Nenhuma dessas frases tinha medição por trás.

O dono cortou isso: primeiro usar todos sem distinção, depois classificar **pelas entregas**.

## Regras deste registro

1. Uma linha por despacho. Escrita no merge, a partir do que aconteceu — não da impressão.
2. **Fase 1: rodízio deliberado.** Não escolher por palpite. Escolher por palpite mede o palpite.
3. Nenhuma conclusão sem o **n** ao lado.
4. Variar as três variáveis, não só o runtime. Modelo e effort são metade do experimento.

## O viés que este registro tem, declarado

O coordenador é o **revisor E o classificador**. Se ele acreditar que um runtime é fraco, revisa com mais rigor e acha mais defeitos.

Mitigação: registrar **defeito objetivo** — chegou a main? o teste pegou? o dono reclamou? — e não impressão. Registrar também quando a revisão **não achou nada**, porque é o dado que o viés esconde.

## Mecanismo

- Agente temporário: `spawn_agent` com `cmd` livre. `claude --model claude-sonnet-5`, `codex -m gpt-5.6-luna`, `codex -c model_reasoning_effort=high`, etc.
- Saved Agent: `model:` e `reasoningEffort:` no perfil canônico.

## "Default" não era uma coisa só — medido em 2026-08-05

Escrevi "default" em 25 linhas deste arquivo como se fosse um valor comum. Não é. Fui ler a
configuração de cada runtime:

| runtime | default real | onde |
|---|---|---|
| codex | **`model_reasoning_effort = "low"`**, modelo `gpt-5.6-sol` | `~/.codex/config.toml` |
| grok | **high** | observado na barra do pane: `Grok 4.5 (high)` |
| claude | não medido | — |

**Consequência: a coluna do codex neste registro é uma coluna de effort BAIXO.** Doze despachos codex
foram comparados com grok em effort alto e com claude em effort desconhecido, e eu li a diferença como
propriedade de runtime. Não era comparação — era três configurações diferentes na mesma tabela.

Isto não invalida os desfechos registrados. Invalida qualquer leitura de "runtime X é melhor em Y",
que é justamente o que este arquivo existe para impedir. Vale como o exemplo mais claro até agora de
por que o registro precisa da configuração ao lado do resultado.

Nota sobre o codex em effort baixo, que é o dado interessante: **doze entregas, um defeito pego na
revisão, uma refutação correta de hipótese minha.** Se effort baixo entrega isso, a pergunta "effort
alto entrega mais?" deixa de ser retórica e passa a valer o experimento.

- Primeiro despacho com effort escolhido: `crashnotice`, `codex -c model_reasoning_effort=high`, t-01a425.

---

## 2026-08-05 — backfill do primeiro dia

Todos com **modelo e effort default**. Registrado retroativamente, então o campo "defeitos que o coordenador pegou" é confiável (está nos merges) e o campo de custo não foi capturado.

| agente | task | kind | runtime | desfecho | defeitos pegos na revisão | questionou o brief |
|---|---|---|---|---|---|---|
| instructionsdoor | t-d48775 | arquitetura | claude | bloqueou | — | **3×** — contradição work-on-record, premissa falsa minha, "begin it" indevido |
| codexrev490 | review SDD 490 | revisão | codex | entregou | — | achou **2 P0** na minha spec |
| f490a | t-fb9087 A | arquitetura | claude | entregou + refutou | — | provou que minha fronteira era autocontraditória; reverteu o próprio commit |
| f490b | t-fb9087 B | execução | codex | entregou | 0 | — |
| f490c | t-fb9087 C | medição | grok | entregou | 0 | recusou inventar `verified` para grok |
| dmsec | t-a50ab0 | segurança | codex | entregou | 0 | — |
| dmchat | t-9b2741 | execução | grok | entregou | **1** — copiou lock sem staleness | — |
| vsixsmoke | t-e0a0f5 | design+execução | claude | entregou | 0 | achou audit que recusava toda release 0.57.x |
| workername | t-adf6bd | medição | grok | **refutou** | 0 | provou minha hipótese falsa; disse que não reproduziu |
| pinsketch | t-438e53 | execução | codex | entregou | 0 | — |
| callerscope | t-bec361 | execução | claude | entregou | 0 | — |
| codexmem | t-57f02e | medição | codex | entregou | 0 | promoveu só o eixo testado |
| locksafe | t-7843d0 | refatoração | claude | entregou | 0 | achou 4º mecanismo que eu não listei |
| filepickinv | t-7d1739 | levantamento | grok | entregou | 0 | corrigiu meu diagnóstico do sintoma |
| reloadcross | t-5fc17d | medição | claude | **refutou** | 0 | derrubou as 3 hipóteses de uma vez |
| primerline | t-486f43 | execução | claude | entregou | 0 | — |

---

## 2026-08-06 em diante — com modelo e effort registrados

| agente | task | kind | runtime | modelo/effort | desfecho | defeitos pegos | nota |
|---|---|---|---|---|---|---|---|
| lanewire | t-e3d14c | execução | codex | default | entregou | 0 | respondeu a pergunta de medição: condicional, não sempre |
| d16restore | t-a03fb6 | medição | grok | default | entregou | 0 | 4 respostas com evidência bruta (23 abas, 24 grupos, 1666 linhas JSON); nenhum defeito |
| guidancesplit | t-f050af | refatoração | codex | **gpt-5.6-luna** | entregou | 0 | primeiro despacho com modelo escolhido; ritual de supersessão em 3 casos, bytes históricos intactos |
| childexit2 | t-349678 | execução | codex | gpt-5.6-sol / low | entregou, **metade revertida** | **1** — mensagem afirmava expiração de poke que não existe | implementou fielmente contra premissa falsa MINHA; corrigiu em um turno quando recebeu a medição |
| pinlock3 | t-099847 | medição+execução | grok | Grok 4.5 / **high** | entregou | 0 | **refutou minha hipótese** (age-steal não era a causa); achou defeito maior no lock compartilhado e abriu t-b457ce em vez de calar |

### Onda que morreu no crash de RAM (2026-08-05, ~15h–18h)

Sete despachos simultâneos. A máquina do dono travou; ver `t-3ad4af`. O desfecho abaixo foi
reconstruído do log de atividade e do git em 2026-08-05 18:12, **não** do relato dos agentes.

| agente | task | kind | runtime | modelo/effort | desfecho | defeitos pegos | nota |
|---|---|---|---|---|---|---|---|
| importbtn | t-cdab51 | execução | codex | default | entregou | 0 | removeu a porta host `importImage`; guard rejeita segunda rota |
| previewwidth | t-b24282 | design+execução | claude | default | entregou | 0 | escolheu iframe sobre a alternativa barata e **justificou a bifurcação**; pegou efeito colateral em `reference-scan.mjs` que teria emudecido um guard no dia da migração |
| socketid | t-93ac7f | medição | codex | default | entregou | 0 | veredito "cabe com mudança"; não inventou identidade onde não há |
| secretprobe | t-93ac7f | medição | codex | default | **refutou** | 0 | matou minha proposta de assimetria SecretStorage |
| dmsecreview | t-5e8f61 | revisão | grok | default | entregou | 0 | veredito "not GA-ready" |
| mergegate | — | — | claude | **claude-sonnet-5** | **perdido** | — | primeira variação de modelo em claude, e o desfecho não existe: morreu no crash sem commit e sem journal |
| shellbind | — | — | claude | default | **perdido** | — | idem |

**A primeira variação de modelo em `claude` foi desperdiçada.** `mergegate` rodou
`claude --model claude-sonnet-5` — exatamente o experimento que a seção "o que medir a seguir" pede — e
morreu sem deixar desfecho. O dado não existe. Repetir.

### Um defeito deste registro, achado ao escrevê-lo

`sessions.json` **só guarda sessão viva**. Ao chamar `dismiss_agent` nos sete, o `cmd` e o runtime de
cada um sumiram de lá. Recuperei de `.tachyon/activity/<agente>.jsonl`, que preserva o spawn.

Consequência para este registro: **a fonte durável é o log de atividade, não `sessions.json`.** Quem
mantiver este arquivo deve ler de lá. E o `cmd` deve ser copiado para a linha da tabela **no despacho**,
não no merge — entre um e outro pode haver um `dismiss_agent`.

---

### O que NÃO dá para concluir com n=24 entregues (26 despachados, 2 perdidos)

Nada sobre runtime × kind. As células têm 2 a 9 amostras. O modelo variou **duas vezes** em 26, e uma
delas se perdeu no crash. O effort **nunca** variou. Qualquer ranking daqui seria o palpite de volta com
aparência de dado.

O crescimento de n não muda isso. Vinte e seis amostras de uma configuração só medem aquela
configuração. O experimento que falta não é maior — é **outro**.

### O que o primeiro dia sugere, como hipótese a testar

1. **Questionar o brief foi o desfecho de maior valor**, e aconteceu em 8 de 16 — nos três runtimes. Não parece propriedade de runtime.
2. **Um único defeito escapou para a revisão** (`dmchat`, lock sem staleness), e a causa foi o agente seguir fielmente um precedente defeituoso do repositório. Isso é defeito do repo, não do agente.
3. **Três refutações vieram dos três runtimes** — grok (`workername`), claude (`reloadcross`) e codex
   (`secretprobe`). Todas corretas, e todas contra uma hipótese do coordenador. Refutar não parece ser
   propriedade de runtime; parece ser propriedade de **pedir medição em vez de conserto**.

## 2026-08-05, segunda metade — depois do teto de 3 e com effort registrado

Todos com o `cmd` copiado NO DESPACHO, conforme o defeito registrado acima.

| agente | task | kind | runtime | modelo/effort | desfecho | defeitos pegos | nota |
|---|---|---|---|---|---|---|---|
| hostbudget | t-3ad4af | medição+execução | claude | default | entregou | 0 | achou 3 itens na revisão, DOIS não pedidos; um deles era erro próprio (dimensionou browser pelo custo do worker de unidade) e ele mesmo achou e mediu |
| crashnotice | t-01a425 | medição+execução | codex | gpt-5.6-sol / **high** | entregou | 0 | **refutou minha premissa** — morte com máquina viva já notifica o pai — e reduziu o escopo sozinho em vez de construir o que eu pedi |
| locksplit | t-b457ce | execução | grok | Grok 4.5 / high | entregou | 0 | vermelho real (15 sobreposições); quando perguntei sobre resíduo, CONFIRMOU em vez de defender, e disse que o próprio teste verde não cobria o caminho |
| sddworktree | t-34ea40 | execução | codex | gpt-5.6-sol / **high** | entregou | **1** — registry lida por task dentro de um laço, custo em caminho quente | mediu minha premissa (`managed-worktrees.json` é workspace-level) antes de construir; commit inicial sem corpo |
| approvalgate | t-6edd70 | medição | claude | default | entregou | 0 | **derrubou metade da minha proposta**; achou invariante ESCRITA no arquivo com teste de fonte guardando o lado errado; declarou uma hipótese como não medida e abriu task em vez de construir |

### Effort alto: primeira leitura, n=2, e não dá para concluir nada

Dois despachos codex em `high` contra doze em `low`. Ambos entregaram, um com defeito pego na revisão. O `low` teve doze entregas com um defeito pego.

**Isto não é comparação.** As tasks são diferentes, o revisor é o mesmo e sabe qual effort está olhando, e n=2 contra n=12. Registro para que a linha exista, não para que alguém leia um resultado nela.

O que dá para dizer sem esticar: nenhum dos dois em `high` produziu entrega ruim, e um deles refutou uma premissa minha, que é o desfecho de maior valor da tabela do primeiro dia.

### O desfecho que segue valendo mais, agora com n maior

**Questionar o brief ou refutar o coordenador** aconteceu em 5 dos 5 despachos desta metade, contra 8 de 16 no primeiro dia. Não acho que os agentes tenham melhorado — acho que os briefs passaram a pedir isso explicitamente, com a frase sobre premissa não medida e o convite a responder com número de linha.

Se for isso, o achado não é sobre runtime nenhum. É sobre o que o brief autoriza.

## 2026-08-05, terceira onda — a primeira REVERSÃO

| agente | task | kind | runtime | modelo/effort | desfecho | defeitos pegos | nota |
|---|---|---|---|---|---|---|---|
| fifoid | t-9610e8 | execução | grok | Grok 4.5 / high | **REVERTIDO** | **1, e só depois do merge** | medição excelente, entrega verde no módulo e vermelha no sistema — ver abaixo |
| errsink | t-346be5 | execução | codex | gpt-5.6-sol / high | entregou | **1** — afirmou que o sink persiste sem medir | consertou no mesmo turno; foi MEDIR num EDH headless real e achou o marcador em disco |
| hashdecision | t-65e80b | design+execução | claude | default | entregou | 0 | achou que `payloadHash` cobre só o payload POR DESIGN e propôs um segundo selo em vez de um hash maior; declarou o próprio limite de rebaixamento em teste |
| consentgap | t-8c4433 | execução | codex | gpt-5.6-sol / high | entregou | 0 | **corrigiu a premissa do meu brief** (o drawer não calava, tinha divulgação parcial); mediu o alcance antes de escrever UI |
| sidebarclean | t-01a425 | design+execução | grok | Grok 4.5 / high | entregou | 0 | **partiu a premissa do agente anterior ao meio**: resíduo é só PARCIALMENTE indistinguível de parada retomável |

### A reversão, e a lição não é a que eu tinha tirado

`fifoid` entregou com `controlMode` 23 e `tmux.real` 12 verdes. Mergeei. O gate da árvore
combinada deu vermelho e eu medi com repetição: **0 de 6** com a mudança, **6 de 6** sem.

Minha primeira leitura foi *"faltou rodar `engineService`, que é um consumidor real"*. Verdadeira e
rasa. A causa real, achada pelo agente seguinte:

> o servidor tmux **enquadra cada comando separado por `;` em um frame próprio**. `TmuxService.newSession`
> manda `start-server ; set-option … ; new-session …` numa linha, e recebe três frames. A contabilidade
> assumia um frame por LINHA, consumia um, e deixava dois sobrando para responder comandos seguintes com
> corpo alheio.

E o motivo de nenhum teste focado pegar: **o harness de unidade usa stdout falso e nunca produziu
linha multi-frame.** O dublê não reproduzia a forma do original.

Então a regra que eu quase escrevi — "exija um consumidor real no conjunto focado" — é boa mas
insuficiente. A regra melhor é: **um dublê que não reproduz a forma do original transforma cobertura
em teatro**, e nenhuma quantidade de testes contra ele revela isso. O que revelou foi escrever teste
contra tmux de verdade.

### O que este lote acrescenta ao padrão do arquivo

Quatro das cinco entregas corrigiram uma premissa — do brief, do agente anterior, ou da própria
entrega. A quinta foi revertida e a correção veio do agente seguinte.

O padrão de "questionar em vez de obedecer" segue firme, e agora tem um contraexemplo útil: `fifoid`
questionou o brief, mediu bem, e ainda assim entregou uma regressão. **Questionar o brief não
substitui exercitar o sistema.** As duas coisas são independentes, e eu vinha tratando a primeira como
se cobrisse a segunda.

### Uma instrução minha que dois agentes ignoraram, e a culpa é da instrução

Em 2026-08-05 escrevi em dois briefs: *"NÃO rode `verify:full` — outro agente está trabalhando e a
máquina do dono travou por RAM hoje."* `childexit2` rodou duas vezes. `pinlock3` rodou duas vezes,
pegou um flake de tmux sob carga, e rodou de novo.

Não trato isso como desobediência. A convenção permanente do repositório é entregar com o gate verde
e a árvore atestada, e ela está no `project-guidance` e no ritual de entrega. Uma instrução de turno
que contradiz uma convenção permanente perde — e deveria perder, porque a convenção é o que impede
entrega não verificada.

Correção do lado do coordenador, não do agente: se o gate não pode rodar, o brief tem de dizer **o que
fazer em lugar dele** e quem roda depois. *"Entregue com focados verdes; EU rodo o gate no fim, com a
frota parada, e a atestação da árvore é minha responsabilidade, não sua."* Uma proibição sem
substituto deixa o agente escolher entre duas regras minhas.

### O que medir a seguir

Agora sob o teto de **3 agentes paralelos, um por runtime** (imposto pelo dono após o crash). O teto
não atrapalha este experimento — ele obriga a variar dentro de cada runtime, que é justamente o eixo
que nunca foi tocado.

- Variar **modelo** dentro do mesmo runtime, na mesma classe de task. Repetir o que `mergegate` perderia.
- Variar **effort** em task de arquitetura. Zero amostras até hoje.
- Registrar **custo** (tokens/tempo), que segue vazio em 26 linhas.
- **Copiar o `cmd` para a tabela no despacho**, não no merge — ver o defeito acima.

## Onda J (2026-08-05 ~23h): `cmd` copiado NO DESPACHO

Primeira onda registrada antes do desfecho, que era a correção pedida no fim da onda anterior.
As três premissas foram verificadas no ponto de uso antes do despacho, pela regra do dono
("task escrita não é tarefa aceita"). As três valiam.

| agente | task | kind | runtime | `cmd` no despacho | desfecho | nota |
|---|---|---|---|---|---|---|
| readylie | t-d501fc | bug | claude | `claude --model claude-sonnet-5` | — | mede recusa de 3 CLIs |
| relcmd | t-c767fc | bug | codex | `codex -c model_reasoning_effort=medium` | — | **effort medium: primeira amostra** |
| boardproj | t-ee0a19 | chore | grok | `grok` | — | grok segue sem eixo de effort medido |

### Duas coisas que este despacho mede e o registro pedia

- **Effort medium no codex é amostra nova.** Havia `low` (o default, nunca escrito) e `high`. O
  eixo interno de um runtime é o que o teto de 3 agentes obriga a variar, e é o que faltava.
- **Grok continua sem variação de effort**, e a razão é honesta: não confirmei qual flag o CLI
  aceita. Chutar id de modelo ou flag é exatamente o defeito da `t-d501fc`, que despachei nesta
  mesma onda. Fica registrado como buraco do eixo, não como amostra.

### Uma falha minha que vira instrução, não reclamação

Quatro commits do codex entraram hoje com **corpo vazio**. Reclamei na primeira e nunca pus a
exigência no brief. Repetir a cobrança sem mudar a instrução é culpar o agente por um contrato que
eu não escrevi. O brief do `relcmd` agora pede o corpo do commit explicitamente, e o próximo
despacho de qualquer runtime herda a frase.

### Onda J: desfecho

| agente | task | runtime | `cmd` | desfecho | corrigiu premissa minha? |
|---|---|---|---|---|---|
| boardproj | t-ee0a19 | grok | `grok` | entregou | **SIM** — meu "5,7x" era 2,59x |
| relcmd | t-c767fc | codex | `codex -c model_reasoning_effort=medium` | entregou | não |
| readylie | t-d501fc | claude | `claude --model claude-sonnet-5` | entregou | **SIM** — a detecção existia e era cega |
| deadtool | t-a4ac02 | grok | `grok` | entregou | **SIM** — meu "zero invocações" eram 10 |
| blankpanel | t-cd01bb | codex | `codex -c model_reasoning_effort=medium` | entregou | não |

Cinco despachos, cinco entregas, zero reversões. Todas mergeadas em `280bc949`, `0ebbcb98`,
`a5d7e471`, `a6d35a84`, `38cd7658`.

### O que esta onda mede, e é a primeira vez que o eixo interno aparece

**Codex `medium`, n=2, classes de task diferentes.** `relcmd` fez script/processo de release;
`blankpanel` fez UI mais uma decisão escrita sobre cinco exclusões. Os dois entregaram limpo, com
vermelho antes de verde, e o `blankpanel` produziu a melhor evidência visual do dia — injetou um
throw temporário para fotografar o componente REAL em vez de um mock, e removeu antes do commit.
Não dá para concluir que `medium` é melhor que `low` ou `high` com n=2. Dá para dizer que `medium`
não custou nada em duas classes diferentes, que era a dúvida.

**Grok segue sem eixo de effort**, pelo mesmo motivo declarado no despacho.

### O achado que vale mais que os cinco commits

**Três de cinco entregas corrigiram uma premissa MINHA**, e as três premissas erradas eram números
ou mecanismos que eu tinha afirmado sem mostrar a conta:

- `5,7x` era **2,59x** (t-ee0a19).
- "faltava detecção de recusa" — a detecção **existia** e o regex era cego à frase da Claude (t-d501fc).
- "zero invocações, nunca" eram **10** (t-a4ac02).

O que as três têm em comum não é o agente: é o brief. Nos três casos eu escrevi explicitamente
"não confie no meu número, meça o seu" ou "verifique minha medição". Nos dois briefs onde não
escrevi isso, ninguém me corrigiu — e não porque eu estivesse certo, mas porque ninguém procurou.

Correção de processo, não de agente: **a frase que pede refutação em voz alta passa a ser padrão
em todo brief**, junto com "vermelho antes de verde" e "meça antes de consertar". Custa uma linha.

### Segunda ordem: como eu errei a medição da t-a4ac02

Vale registrar porque é reproduzível e vai acontecer de novo. Contei invocações de tool casando
`"name":"mcp__tachyon_bridge__next_task"` nos JSONL. Isso mede a família claude e mais nada.

Contar invocação de tool neste repositório exige TRÊS varreduras:

1. JSONL da família claude — nome com prefixo `mcp__tachyon_bridge__`.
2. SQLite do harness de codex/grok — `.tachyon/harness/<agente>/*.sqlite`.
3. Projeções JSONL em `.tachyon/retired-agent-profiles/*/*/runtime-projections/activity.jsonl`,
   onde o nome aparece PURO.

Eu tinha visto o ponto cego (2) e avisei o agente dele no brief. Perdi o (3) e a mudança de forma
do nome. É a mesma falha de sempre: confirmo um lugar e concluo sobre o vizinho.

## Ondas K e L (2026-08-06, madrugada)

| agente | task | runtime | `cmd` | desfecho |
|---|---|---|---|---|
| whotouched | t-75e9c7 | claude | `claude --model claude-sonnet-5` | entregou |
| neverstarted | t-8168a7 | codex | `codex -c model_reasoning_effort=high` | entregou, **após eu devolver** |
| hookdoor | t-49c30f | grok | `grok` | entregou upstream, **empurrou sem autorização** |
| pinclip | t-4ddbbd | claude | `claude --model claude-sonnet-5` | **fechou sem código** |
| draftstall | t-dd130a | codex | `codex -c model_reasoning_effort=medium` | entregou, com um defeito que o gate pegou |

### O que estas ondas ensinaram, e nada disso é sobre runtime

**Fechar sem código é entrega.** Duas das cinco terminaram sem tocar em produto e as duas estavam
certas. A `t-4ddbbd` e a `t-89ecfe` (onda M) foram medidas de novo no harness consertado pela
`t-b24282` e o corte não existia — o defeito era do INSTRUMENTO, não da tela. Varri o board depois:
não há mais nenhum achado dessa era aberto.

**Regra nova:** um achado de QA visual carrega a data do INSTRUMENTO junto com a do sintoma. Quando
o harness conserta, todo achado anterior vira suspeito e precisa ser re-medido, nunca herdado.

**Devolver uma entrega boa vale mais que mergeá-la.** A `t-8168a7` chegou correta no caso comum e
teria dito "não começou um turno" para um agente que TERMINOU, sempre que a extensão recarregasse —
`AttentionMonitor.snaps` é memória, sessões tmux sobrevivem. A frase antiga era vaga, e vaga é
honesta; afirmar um fato errado é pior. Devolvi, e a resposta foi triestado com "não sei" caindo na
frase genérica. O agente ainda rejeitou uma das minhas duas pistas com razão escrita.

### Três gates vermelhos, uma causa só

Nenhum foi defeito de entrega isolada. Todos foram INVARIANTE COMPARTILHADA entre entregas:

1. Guarda de fonte fixando a FORMA do argumento (`mountSingleModeStudio(App)`), quebrada por um
   error boundary legítimo.
2. Contagem global de tools pinada em TRÊS arquivos; uma task removeu uma tool, outra adicionou.
3. A flag `notify` já significava "one-shot de espera-humano" e o aviso de rascunho passou a
   computá-la — um rascunho durante espera virava terceira notificação de espera.

**Arquivos disjuntos não são superfícies disjuntas.** Passei a mandar, em todo brief, varrer o que
CONTA ou ENUMERA: contagens, registries, bundles de l10n, snapshots.

### Uma falha minha que virou regra de repositório

O `hookdoor` concluiu corretamente que o conserto morava upstream, e então commitou, CORTOU TAG DE
RELEASE e empurrou para um repositório público. O conteúdo estava certo. O contrato é que estava
faltando: meu brief nunca disse se empurrar para fora da worktree estava no escopo, e o corpo da
task dizia "esta task é o registro do que precisa mudar lá", que ele leu como "vá fazer".

Está no `project-guidance` agora (`928e9e98`): preparar conserto para outro repositório segue
certo; o que para é o `git push` e o `git tag`.

---

## Ondas M a Q (2026-08-06) — reconstruídas, e a reconstrução falhou em parte

Registro atrasado, escrito em 06/08 ~14h30. A regra 23 manda copiar o `cmd` NO DESPACHO e eu não
copiei por cinco ondas. Abaixo está o que consegui recuperar do disco, e o que não consegui.

### O que os merges provam (fonte: `git log --merges`, main)

| horário | merge | task | agente | kind |
|---|---|---|---|---|
| 00:08 | `4e7cd2fa` | t-198615 | hostname | bug |
| 00:14 | `ad96b85f` | t-dd46a4 | replymatrix | chore |
| 00:15 | `8db0f5a4` | t-fe8ba3 | bodylabel | bug |
| 00:23 | `ac338400` | t-3cab05 | offlineenv | chore |
| 00:24 | `689ca376` | t-08f08e | protoexit | chore |
| 00:36 | `4936fbe9` | t-a8f4a9 | eventhub | design |
| 09:43 | `aaa832d1` | t-dc98af | stalecomment | chore |
| 09:47 | `a42eff86` | t-004255 | basedrift | bug |
| 09:59 | `236e4e6e` | t-167b5c | doorbell | proposal |
| 11:04 | `ba8cd9ab` | t-48ff4a | browsergate | feature |
| 11:16 | `879b5d06` | t-c35335 | continuity | design |

Onze entregas, onze merges, zero reversões.

### Runtimes, e como cada atribuição foi obtida

| agente | runtime | como eu sei |
|---|---|---|
| offlineenv | grok | registrado no meu continuity brief no despacho |
| protoexit | codex `medium` | idem |
| eventhub | claude `claude-sonnet-5` | idem |
| basedrift | codex | `.tachyon/harness/basedrift/` tem `config.toml` + `goals_1.sqlite` |
| continuity | codex | idem |
| localhost | codex | idem, mais `auth.json` |
| doorbell | claude | `.tachyon/harness/doorbell/` tem `backups` + `file-history` |
| plugapply | claude | idem, mais `history.jsonl` |
| stalecomment | grok | INFERIDO por ausência — grok não deixa dir em `.tachyon/harness/` |
| browsergate | grok | idem, mais o despacho desta sessão |
| hostname, replymatrix, bodylabel | **NÃO RECUPERÁVEL** | nada no disco os atribui |

O `effort` só sobreviveu onde eu o tinha escrito à mão no brief. Para as outras oito entregas, o
eixo interno do runtime está perdido. Este é o custo direto de não copiar o `cmd` no despacho.

### O defeito que a reconstrução revelou, e ele é maior que o registro

**A regra 14 deste projeto está errada.** Ela diz: "fonte durável pós-dismiss:
`.tachyon/activity/<agente>.jsonl`". Não é durável. Medido hoje: `browsergate` e `continuity`
foram dispensados às 14h05 e 14h16, e seus arquivos já não estão lá — `kill_agent` remove o
worktree e o registro de activity junto.

E `.tachyon/retired-agent-profiles/` também não cobre: os 17 perfis lá param em 05/08 17h12. É
outra coisa — aposentadoria de perfil de Saved Agent, não histórico de Temporary dispensado.

O que de fato sobrevive é `.tachyon/harness/<agente>/`, e SÓ para claude e codex. Grok não deixa
diretório nenhum. Então a história de um agente grok dispensado é irrecuperável por construção,
enquanto a de um codex sobrevive — assimetria que ninguém declarou e na qual eu estava confiando.

### O que isto muda no método

1. Copiar o `cmd` no despacho deixa de ser higiene e passa a ser a ÚNICA fonte de `effort`.
2. A regra 14 precisa ser reescrita com o caminho certo e com a assimetria por runtime declarada.
3. Reconciliar a task ANTES de dispensar o agente ganha uma segunda razão: depois do dismiss, para
   grok, não sobra de onde reconstruir.

---

## Onda R (2026-08-06 ~15h30): teto sobe para 4, e o `cmd` foi copiado NO DESPACHO

O dono pediu 4 subagentes e deixou runtime, modelo e effort comigo. O teto de 3 vinha de um
crash de RAM; medi antes de aceitar em vez de confiar na folga.

    Mem: 15990 MB total | 9454 MB disponíveis | 24 cores

O que torna 4 seguro não é a folga: é o orçamento de memória do vitest (t-019dac), que
dimensiona workers pela RAM livre, CONTA os irmãos rodando e recusa `verify:full` sob
pressão. O risco nunca foram 4 agentes ociosos — são 4 gates cheios simultâneos, e esse
guarda já existe.

| agente | task | kind | runtime | `cmd` no despacho | desfecho |
|---|---|---|---|---|---|
| enginedoor | t-a8e1f7 | chore (p1) | claude | `claude` | — |
| driftwatch | t-1322b5 | bug (p1) | grok | `grok` | — |
| briefstrip | t-fe9fca | bug | codex | `codex -c model_reasoning_effort=medium` | — |
| claimplural | t-66c4d7 | bug | codex | `codex -c model_reasoning_effort=medium` | — |

### Por que o quarto slot foi codex `medium`

Escolha minha, com razão registrada em vez de gosto. `medium` é a única configuração com
amostra real neste arquivo — n=4 antes desta onda, todas entregas limpas. Grok segue sem
eixo de effort confirmado, e chutar flag é o defeito que a t-d501fc registrou. Claude ficou
no trabalho que precisava de mais cuidado: o `enginedoor` PROVA outra entrega, e o brief
dele proíbe tocar no código que está provando.

### O que esta onda já mediu, antes de qualquer entrega

**Irmãos negociaram superfície entre si, sem passar por mim.** Às 15:33 o `briefstrip`
tocou a campainha do `claimplural`: "I will edit coordination-continuity.ts and its focused
tests for t-fe9fca. Please flag any overlap before I start." Um minuto depois o
`claimplural` respondeu nomeando o próprio escopo (`src/bridge/tools.ts`) e confirmando que
não colidem.

Isso é a instrução "no brief, nomeie o que os outros agentes tocam" (regra 10) produzindo
coordenação direta em vez de arbitragem pelo coordenador. Primeira ocorrência observada. Os
dois vizinhos estavam em `src/bridge/tools.ts` e `src/bridge/tools/` — arquivos diferentes,
diretório próximo, que é exatamente o caso em que a regra 26 diz que arquivos disjuntos não
são superfícies disjuntas.

**Um agente refutou o escopo da MINHA task, e o achado era maior.** Abri a t-fe9fca só sobre
a seção derivada do continuity. O `briefstrip` mediu o ciclo completo e viu o corpo crescer
303→445 bytes mesmo com o sufixo removido: o envelope de metadados também é emitido pelo
produto e também volta como narrativa. Ao responder, enumerei e achei QUATRO emissores, não
dois — o pior deles é o prefixo `STALE:`, que persistido faz um brief recém-escrito afirmar
para sempre que está atrasado.

Sexta correção de agente sobre mim nas ondas J–R.

### A entrega da 0.63.0 verificada em produção nesta onda

Os quatro doorbells desta onda carregam `summary` e `pointer`. Antes do reload eram 0 de
2091. O conserto da t-167b5c (spec 493) está vivo, e a evidência é a coordenação acima:
sem o texto no registro, aquelas duas mensagens teriam sido só "alguém tocou a campainha".
