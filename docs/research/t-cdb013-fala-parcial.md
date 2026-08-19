# t-cdb013 — onde a fala parcial de um turno fica persistida

Medição feita em 2026-08-18/19, no checkout `falacodex`. Este documento mede o que já existe; não
propõe desenho de produto.

## Amostra, janela e método

Os homes dos agentes temporários `podagrok`, `envgrok`, `menoresgrok`, `hunkgrok`, `modelogrok` e
`sizingcodex` já tinham sido removidos quando esta medição começou. Portanto, a amostra original de
nove sessões Grok do cartão **não existe mais** e não pode ser recontada honestamente.

Usei o que ainda estava em disco:

| runtime | amostra sobrevivente | janela UTC observada | cortes observáveis |
|---|---:|---|---:|
| Grok | 6 sessões, 6 pares `events.jsonl`/`updates.jsonl`/`chat_history.jsonl` | 2026-08-07 21:18:23 → 2026-08-14 15:30:01 | 1 `turn_ended` com `mid_turn_abort` |
| Codex | 1 rollout do agente `falacodex` | 2026-08-19 00:48:14 → 00:50:55 | 0 |
| Claude | 1 transcript principal persistente, 6.900 registros `assistant` com texto | 2026-07-30 18:13:53 → 2026-08-19 00:48:26 | não classificáveis pelo transcript |
| ledger Tachyon | `falacodex-47be21b3bf46b15e.jsonl` e `claude-c857d09db23e6822.jsonl` | mesmas janelas das duas sessões vivas | 0 cortes identificáveis |

Antes de contar, abri uma linha de cada formato. Os nomes de tempo são diferentes: Grok
`events.jsonl` usa `ts`, Grok `updates.jsonl` usa `timestamp` inteiro em segundos, e os rollouts,
transcripts e ledger usam `timestamp` ISO (o ledger acrescenta `loggedAt`).

```console
$ head -1 .../events.jsonl
{"ts":"2026-08-14T15:12:54.847Z","type":"mcp_config_resolved",...}

$ head -1 .../updates.jsonl
{"timestamp":1786720375,"method":"session/update","params":{"sessionId":"d16a...","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"── TACHYON PRIMER ──..."}}}}

$ head -1 .../chat_history.jsonl
{"type":"system","content":"You are Grok 4.6 released by xAI..."}

$ head -1 .../rollout-2026-08-18T21-48-14-01a0177d-....jsonl
{"timestamp":"2026-08-19T00:48:14.888Z","ordinal":0,"type":"session_meta","payload":{"session_id":"01a0177d-...","cwd":".../falacodex",...}}

$ head -1 .../projects/.../05dfb028-....jsonl
{"type":"custom-title","customTitle":"tachyon-tachyon-claude","sessionId":"05dfb028-..."}

$ head -1 .tachyon/activity/falacodex-47be21b3bf46b15e.jsonl
{"schemaVersion":1,"source":{"runtime":"codex",...},"timestamp":"2026-08-19T00:48:16.509Z","loggedAt":"2026-08-19T00:48:16.649Z","events":[...]}
```

### Recontagem da taxa-base Grok

Comando: para cada linha `user`, classificar o `type` da linha imediatamente anterior.

```console
$ for f in $(find /home/goat/tachyon/.tachyon/bridge-mcp \
    -path '*/sessions/*/chat_history.jsonl' -type f); do
    jq -s -r 'range(1;length) as $i | select(.[$i].type=="user") | .[$i-1].type' "$f"
  done | sort | uniq -c
     37 assistant
      7 tool_result
```

Nas **6 sessões sobreviventes**, entre 2026-08-07 21:18:23Z e 2026-08-14 15:30:01Z, são portanto
**37 `assistant` contra 7 `tool_result`**, não 37 contra 12. Das sete fronteiras `tool_result`, cinco
estão nos índices 8–11 e são bootstrap; sobram **duas reais**. Uma delas é seguida por `acabou ?`.
Isso não contradiz nem confirma a contagem antiga: a amostra mudou de nove para seis sessões e os
homes que continham os três cortes de 18/08 foram apagados. O número novo vale para a amostra nova;
o antigo não é reproduzível com o disco atual.

## 1. Quem já escreve a fala parcial em algum lugar?

**Resposta curta: os três runtimes escrevem blocos de fala enquanto o turno maior ainda está em
andamento. Grok escreve o melhor witness, `agent_message_chunk`, em `updates.jsonl`; Codex escreve
mensagens de fase `commentary` no rollout; Claude escreve blocos `assistant` no transcript. Nenhum
dos três artefatos prova persistência token a token de uma frase cortada no meio do próprio bloco.**

### Grok: sim, em `updates.jsonl` (não em `chat_history.jsonl`)

O achado novo é que a busca anterior olhou `events.jsonl` e `chat_history.jsonl`, mas a sessão também
tem `updates.jsonl`. Este arquivo guarda a fala emitida antes do fim do turno, com texto e identidade
da sessão:

```console
$ jq -c 'select(.params.update.sessionUpdate=="agent_message_chunk")' \
  /home/goat/tachyon/.tachyon/bridge-mcp/grok.grok/sessions/%2Fhome%2Fgoat%2Ftachyon-ade-bench/a7068f4a-e8fb-4920-bb02-5b4c12fa7035/updates.jsonl | head -1
{"timestamp":1786323944,"method":"session/update","params":{"sessionId":"a7068f4a-e8fb-4920-bb02-5b4c12fa7035","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Vou ler o plano da goal e as regras de catalogação, depois catalogar os 5 faltantes, validar, commitar e fazer push."}}}}
```

Na sessão sobrevivente que contém um corte, há duas falas gravadas antes do `turn_ended` cancelado
de 2026-08-10 01:08:31Z. A frase específica de `podagrok` (`vsce is on PATH...`) não pode ser
retestada: o home de `podagrok`, incluindo seu possível `updates.jsonl`, foi removido.

`chat_history.jsonl` só recebe a versão consolidada `assistant`. Uma fala normal aparece nos dois
arquivos, literalmente igual:

```console
$ rg -n -F "Startup brief is clear: no board task and no substantive assignment." \
  .../a7068f4a-e8fb-4920-bb02-5b4c12fa7035/chat_history.jsonl
12:{"type":"assistant","content":"Startup brief is clear: no board task and no substantive assignment. I'll checkpoint that and idle for an explicit brief.",...}
```

### Codex: sim, no rollout

O rollout do próprio turno desta medição já continha uma fala antes de o turno acabar:

```json
{"timestamp":"2026-08-19T00:48:18.839Z","ordinal":13,"type":"response_item","payload":{"type":"message","id":"msg_0aaccf...","role":"assistant","content":[{"type":"output_text","text":"I’ll read the full task contract and repository guidance first, then carry out the assigned board work and verify the exact tree I deliver."}],"phase":"commentary"}}
```

Comando e resultado sobre a amostra de **1 sessão, 00:48:14–00:50:55Z, zero cortes**:

```console
$ jq -s -r '[.[]|select(.type=="response_item" and .payload.type=="message" and .payload.role=="assistant")] | length' rollout-....jsonl
3
```

São blocos completos de comentário no meio do turno, não deltas de token. Se o processo morrer
depois da linha ser anexada, o bloco sobrevive; não medi morte no meio dessa própria linha.

### Claude: sim, no transcript

Claude anexa uma linha `assistant` com bloco `text` e, em outra linha, o `tool_use` seguinte. Exemplo
bruto do transcript principal:

```json
{"message":{"id":"msg_011CdYhN6L1uPVj6bdnZgBrq","role":"assistant","content":[{"type":"text","text":"I'll start by reading the startup brief."}],"stop_reason":"tool_use"},"type":"assistant","uuid":"b6f059be-...","timestamp":"2026-07-30T18:13:53.238Z",...}
{"message":{"id":"msg_011CdYhN6L1uPVj6bdnZgBrq","role":"assistant","content":[{"type":"tool_use","id":"toolu_01H5...","name":"Read",...}]},"type":"assistant","uuid":"3f25532d-...","timestamp":"2026-07-30T18:13:53.820Z",...}
```

A amostra é **1 sessão persistente, 2026-07-30 18:13:53Z–2026-08-19 00:48:26Z, 6.900 linhas
`assistant` com texto**. O transcript não traz um campo confiável que permita contar quais turnos
foram cortados. Como no Codex, o que se prova é persistência por bloco/resposta, não token a token.

## 2. Quem expõe um evento de streaming utilizável?

**Resposta curta: Grok expõe `agent_message_chunk` utilizável em `updates.jsonl`. Codex e Claude
expõem blocos textuais antes do fim do turno e o Tachyon já os lê rapidamente, mas não são deltas de
token. O `phase_changed: streaming_text` do Grok não é utilizável sozinho porque não carrega texto.**

### Grok

Há dois canais diferentes, e confundi-los mudaria a resposta:

```console
$ jq -c 'select(.type=="phase_changed" and .phase=="streaming_text")' .../events.jsonl | head -3
{"ts":"2026-08-14T15:12:56.178Z","type":"phase_changed","phase":"streaming_text"}
{"ts":"2026-08-14T15:12:56.179Z","type":"phase_changed","phase":"streaming_text"}
{"ts":"2026-08-14T15:12:56.179Z","type":"phase_changed","phase":"streaming_text"}
```

Essas linhas apenas dizem “está streamando”; **não carregam texto e não contam**. Já
`updates.jsonl` traz `session/update → agent_message_chunk → content.text`, antes de `turn_completed`.
Na amostra de **6 sessões, 07/08–14/08, 1 corte**, ele é um evento utilizável e durável no home do
runtime. O Tachyon não o ingere hoje no ledger.

### Codex

O evento utilizável é `response_item`/`message` de fase `commentary`, com `content[].text`. Na
amostra viva, a linha do rollout foi gravada às `00:48:18.839Z` e a linha equivalente chegou ao
ledger às `00:48:19.150Z`, **311 ms depois e durante o mesmo turno**. Portanto chega ao Tachyon antes
de um corte posterior e carrega texto. É streaming por bloco de mensagem, não por token.

### Claude

O transcript `assistant` carrega `message.content[].text`; o writer do Tachyon o acompanha durante
o turno. Nos três últimos blocos observados, por exemplo, `timestamp → loggedAt` foi
`00:42:39.606 → 00:42:39.845`, `00:47:46.749 → 00:48:13.630` e
`00:48:26.211 → 00:48:26.660`. Assim o canal é utilizável por bloco, embora a segunda demora de
26,881 s mostre que “antes do corte” depende de o poll ocorrer a tempo. Não há evento de delta de
token medido no transcript.

## 3. O ledger consegue registrar a fala parcial sem duplicar o turno normal?

**Resposta curta: não com o contrato atual. Ele consegue anexar blocos Codex/Claude no meio do
turno, mas só conhece `assistant.message.completed`; não lê `updates.jsonl`, não tem evento de delta
e não substitui uma parcial quando a versão consolidada normal chega. Ingerir hoje os dois registros
Grok produziria duas falas semanticamente iguais.**

Turno normal e turno cortado, lado a lado:

| | turno normal observado (Codex) | turno cortado observado (Grok) |
|---|---|---|
| runtime em disco | rollout anexa `response_item/message` com texto | `updates.jsonl` anexa `agent_message_chunk`; `events.jsonl` termina `turn_ended/cancelled` |
| ledger Tachyon | anexa `assistant.message.completed` | nenhum ledger sobrevivente da sessão; o writer atual nem lê `updates.jsonl` |
| consolidação | o bloco já é rotulado `completed` | `chat_history.jsonl` pode não receber a última fala |

Evidência bruta do normal:

```json
{"source":{"runtime":"codex","recordId":"msg_0aaccf..."},"timestamp":"2026-08-19T00:48:18.839Z","loggedAt":"2026-08-19T00:48:19.150Z","events":[{"type":"assistant.message.completed","payload":{"text":"I’ll read the full task contract and repository guidance first..."}}]}
```

Evidência bruta do corte sobrevivente:

```json
{"ts":"2026-08-10T01:08:31.793Z","type":"turn_ended","outcome":"cancelled","cancellation_category":"mid_turn_abort","cancellation_context":{"trigger":"ctrl_c"}}
```

O limite é verificável no código atual:

```console
$ rg -n 'assistant.message.delta|assistant.message.completed' packages/engine/src/activity/types.ts
28:  | "assistant.message.completed"
64:  "assistant.message.completed": { text: string };
```

`packages/engine/src/activity/logStore.ts` grava uma linha append-only por `source.recordId` e recusa
apenas a repetição da **mesma identidade de origem**. `updates.jsonl` e `chat_history.jsonl` dão
identidades diferentes à mesma fala; a igualdade textual demonstrada na seção 1 não é deduplicada.
Logo o arquivo consegue guardar uma parcial fisicamente, mas **não consegue hoje representá-la e
depois conciliá-la com o turno normal sem duplicação semântica**.

## O que não deu para medir

- A frase exata de `podagrok` em `updates.jsonl`: o home do agente foi removido. Só sobrevivem a
  citação no documento anterior e a ausência já medida em `chat_history.jsonl`/ledger.
- A amostra original de nove sessões e seus 37/12: só seis sessões existem agora. A recontagem
  reproduz 37/7 e duas fronteiras reais nessa outra amostra.
- Codex ou Claude mortos no meio de um bloco de texto. Os arquivos provam flush de blocos durante o
  turno, não preservação de prefixo token a token.
- Um ledger de Tachyon correspondente ao corte Grok sobrevivente: não existe arquivo de atividade
  cuja `source.sessionId` seja `a7068f4a-e8fb-4920-bb02-5b4c12fa7035`.
- Latência Grok `updates.jsonl` → Tachyon: hoje não há consumidor desse arquivo no activity writer,
  portanto não há chegada ao ledger para cronometrar.
- Quantos cortes há no transcript Claude: o formato observado não marca de forma determinística o
  encerramento externo do turno; silêncio não foi contado como ausência nem como corte.

