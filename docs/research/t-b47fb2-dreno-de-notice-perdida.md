# Por que três campainhas de `notify_agent` nunca chegaram — medição

Task: `t-b47fb2`, fatia 1
Medido por `drenocodex` em 2026-08-17. Persistido aqui pelo `claude` porque a entrega dele foi um
commit vazio de propósito: o artefato era o journal, e journal não é versionado.

## Resultado em uma frase

**Foi mascaramento por restart, não conserto de versão.** A fila de painel vive só em memória; a
troca de instância `0.93.9 → 0.93.10` às 20:07:06Z destruiu tudo o que estava pendente, e só o
`doorbells.jsonl` sobreviveu.

## As três correções que a medição fez no cartão

O cartão original — escrito por mim — errou em três pontos. Os três estão corrigidos aqui.

### 1. A cronologia estava errada, e ela mudava a conclusão

Eu correlacionei as perdas com a troca `0.93.10 → 0.93.11` das 20:43:24Z. Errado.

| Hora (UTC) | Evento |
|---|---|
| 18:04:45 | troca **0.93.8 → 0.93.9**, instância `7f9c8496`, pid 2144557 |
| 18:41:30 | `homegrok` toca — **perdida** |
| 18:45:54 | `cotafinal` toca — **perdida** |
| 18:55:53 | `telagrok` toca — **perdida** |
| 20:07:06 | troca **0.93.9 → 0.93.10**, instância `f45e879e`, pid 2960324 |
| 20:16:27 | `guardacodex` toca — **chega** às 20:17:58.734Z |
| 20:43:24 | troca 0.93.10 → 0.93.11 |

As perdas foram na **0.93.9**. E a entrega já funcionava na **0.93.10**, antes da 0.93.11 existir.

### 2. Não houve conserto acidental

`git diff 1d86561d..903049ec` (0.93.9→0.93.10) não toca `NoticeQueue`,
`Workspace.deliverNotice/recoverOnIdle`, `attention` nem o completion hint.
`git diff 903049ec..55096bc8` (0.93.10→0.93.11) também não — são Runtime Ops, provider e review-base.

O controle na 0.93.10 refuta a hipótese diretamente: a entrega voltou **sem** commit que a
consertasse.

### 3. A minha afirmação sobre as bordas não aparece no log

Eu escrevi no cartão que *"o claude terminou turno por volta de 18:46 e de novo por volta de 18:57"* e
concluí que a borda abriu e nada drenou. **Isso veio da minha memória da conversa, não do log.**

O transcript em UTC diz outra coisa: `away_summary` às 18:35:22Z e nenhuma entrada nova até 19:44Z.
E às 19:49 e 20:02 o event log registra explicitamente **idle com draft não enviado** — uma condição
que **segura** a fila por desenho.

Então a "explicação fácil" que eu declarei errada pode estar certa: a borda pode nunca ter aberto
naquela janela.

## TTL não foi, e o `onExpired` acertou em não disparar

Desde `t-93bec9` (2026-08-09, já ancestral da 0.93.9), `clearExpired` **conserva**
`origin === agent-authored` sem o limite de 10 minutos. O TTL vale para host-poke e relay, não para
`notify_agent`.

Busca nos event logs das instâncias não encontra nenhum aviso de expiração para as três. **O
`onExpired` não disparou porque não devia** — não é uma segunda falha.

Minha suspeita de que os 14 minutos da janela cabiam nos 10 do TTL estava errada: o TTL não se
aplicava a essas campainhas.

## A causa que se sustenta

`NoticeQueue` guarda a fila exclusivamente em `private readonly queues = new Map<...>`. Não há
restauração a partir do `doorbells.jsonl`.

As três entradas existiram no log durável e nunca no histórico do painel. A substituição da instância
às 20:07 destruiu toda a fila pendente. O que sobreviveu foi o append-only, lido à mão às 19:54Z.

## O limite da evidência, declarado

**Não existe auditoria da fila em memória.** O cadáver não permite dizer qual condição exata manteve
cada item pendente até as 20:07 — classificação `working`, composer com draft, ou o latch de
recuperação.

A evidência sustenta a perda terminal no restart. Ela **não** autoriza escolher entre esses estados
transitórios anteriores. Não há registro durável de profundidade de fila para fechar além disso.

## Controle executável

    npx vitest run test/unit/noticeQueue.test.ts \
                   test/unit/notifyDoorbellDelivery.test.ts \
                   test/unit/humanDraftHoldsNotice.test.ts
    EXIT 0 — 3 arquivos, 37 testes

Prova: campainha autoral passa de 10 minutos sem `onExpired`; `busy→idle` drena; draft segura sem
descartar; remetente dispensado ainda entrega.

## O que isso pede da fatia 2

O requisito mínimo tem nome: **restart não pode ser uma operação silenciosa de descarte.**

Duas saídas, e elas não são exclusivas: reconstituir a fila a partir do witness durável no boot, ou o
hook de fim de turno já descrito no cartão. A segunda é a ideia do dono e continua valendo — mas
agora se sabe que ela ataca um sintoma cuja causa é a fila volátil.

---

# Fatia 2 — as duas metades, e o que foi medido antes de projetar

Medido por `drenoclaude` em 2026-08-18. O dono decidiu as duas metades: reconstituir ataca a causa
que a fatia 1 mediu, e o hook garante a entrega. Entregues em dois commits separados para poderem ser
revertidos independentemente.

## O cursor é uma coisa só, e é o que separa conserto de enxurrada

`.tachyon/notice-cursors.json`, ao lado do witness. Um `baseline` por workspace e um cursor por
agente. **O cursor avança AO ENTREGAR, não ao confirmar leitura** — decisão do dono, agora mecânica:
quem morre no meio perde aquela entrega, e isso é aceitável porque o `doorbells.jsonl` nunca perde.
O cursor é conveniência, não custódia.

As duas metades escrevem o MESMO cursor, e é isso que impede entrega dupla: quem chegar primeiro no
agente ganha, e o outro lado se retira (`Workspace.noticeAlreadyHandedOver` para o lado do painel,
o próprio cursor para o lado do hook).

`baseline` é o que faz o primeiro boot depois do upgrade não repetir nada: ele é sempre semeado no
fim da trilha, então as 3.291 linhas já existentes deste workspace ficam todas atrás dele. Um agente
sem cursor próprio é medido contra o baseline, nunca contra o começo da trilha.

Falha aberta em toda direção: trilha ilegível, cursor corrompido, ou cursor que não se consegue
escrever → nada é restaurado e nada é despejado, que é exatamente o comportamento de hoje.

## Metade A — prova, com o controle negativo que é a metade que importa

`test/unit/noticeSurvivesEngineRestart.test.ts` roda DUAS instâncias de `Workspace` sobre um único
workspace root, com o servidor tmux falso sobrevivendo à troca (cada instância abre seu próprio
`TmuxService` — em produção os panes são processos do SO e não morrem porque o extension host
recarregou).

    POSITIVO  notice enfileirada pela instância 1 chega depois que a instância 2 sobe
    NEGATIVO  notice que a instância 1 JÁ entregou não é entregue de novo

**Fail-before medido, nos dois sentidos:**

| mutação | positivo | controle negativo |
|---|---|---|
| laço de `restore` desligado | **falha** | passa |
| avanço do cursor na entrega removido | passa | **falha** |

A segunda linha é a que dá dente ao controle: sem ela, trocar perda por enxurrada passaria em todo
teste positivo do arquivo.

## Metade B — quais runtimes, e por que só esses três

A regra da casa é medir antes de projetar. Medido hoje, nesta máquina, com um hook `Stop` de sonda:
**exit 2 com uma linha em stderr coloca o texto no contexto do modelo e continua o turno**, nos três.

| runtime | versão | canal | invocações de `Stop` | resultado |
|---|---|---|---|---|
| claude | 2.1.235 | `--settings` | 2 | chega como turno de usuário rotulado `Stop hook feedback:` |
| codex | 0.147.0 | `-c hooks.Stop=[…]` | 2 | segundo `agent_message`, depois `turn.completed` |
| grok | 1.0.5 (`5115b46bc9`) | `$GROK_HOME/hooks/stop.json` | **3** | `num_turns: 2`, token na resposta |

As três invocações do grok são o motivo de o cursor avançar ANTES do emit: um emit que não move o
cursor primeiro re-dispararia em cada uma delas. E como o grok guarda só a PRIMEIRA linha de stderr
(medido no `t-685a0c`), o despejo é **uma linha só** em qualquer runtime — uma linha por notice
entregaria a primeira e descartaria o resto em um dos três, que é a forma exata de defeito que esta
task existe para remover. O que não cabe é NOMEADO (contagem + `read_notices`), nunca cortado calado.

**Fora**: pi, opencode, hermes, gemini, qwen — Tachyon não tem canal `Stop` por spawn medido para
eles. Ficam de fora nomeados, não por omissão. São os mesmos três que `t-09edf2` e `t-685a0c`
alcançaram, pela mesma razão.

## Metade B — prova, com o script REAL

Não a função TypeScript: o `notice-drain.cjs` materializado, executado como os runtimes o executam.
Workspace de sonda com duas notices pendentes para `drenoprobe`:

| runtime | despejo | cursor depois | turno seguinte |
|---|---|---|---|
| claude 2.1.235 | as duas, citadas nominalmente pelo agente | `2026-08-18T11:31:00.000Z` | segunda sessão: 1 turno, **zero** `Stop hook feedback` |
| codex 0.147.0 | "Notices received." | `2026-08-18T11:31:00.000Z` | encerra |
| grok 1.0.5 | as duas, citadas nominalmente | `2026-08-18T11:31:00.000Z` | encerra (`end_turn`) |

`test/unit/noticeDrainHook.test.ts` roda o mesmo script como subprocesso e fixa o resto: a segunda
execução sai 0 sem stderr, uma notice já entregue pelo painel não é despejada, cursor ausente ou
corrompido silencia, um append danificado não esconde o resto da trilha, e o compositor de dentro do
script bate byte a byte com o exportado (o script não pode importar código Tachyon, então esse teste
é a única coisa entre duas renderizações da mesma linha e uma divergência silenciosa).

## Custo declarado

O hook lê a trilha inteira a cada fim de turno em que roda, com um pré-filtro de substring pelo nome
do agente antes de qualquer `JSON.parse`. Nesta workspace são 3.291 linhas (~650 KB). É O(arquivo) e
cresce com a idade do workspace; foi medido como aceitável ao lado do custo de subir um `node`, e
está escrito aqui em vez de ser resolvido com maquinaria que ninguém pediu.
