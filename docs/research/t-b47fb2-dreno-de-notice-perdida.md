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
