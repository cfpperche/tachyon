# t-83d04e — por que agentes grok encerram o turno no meio do trabalho

Medição de 2026-08-18, worktree `paradaclaude`, agente `claude` (Opus 5) investigando grok de
propósito, para que o runtime sob suspeita não se auditasse.

## Resposta curta

**Não é o grok encerrando o turno.** É o **Tachyon trocando o processo do runtime enquanto o turno
estava em voo**. O próprio grok registra a parada como cancelamento externo:

```json
{"type":"turn_ended","outcome":"cancelled",
 "cancellation_category":"mid_turn_abort",
 "cancellation_context":{"trigger":"ctrl_c"}}
```

O processo `grok` que estava rodando é substituído por um novo, lançado com `-r <sessionId>`.
`-r` restaura a **conversa**, não o **turno**: o processo novo sobe no prompt vazio, sem nada
para responder. Daí `running: true` / `attention: idle`, zero commits, e um único `notify_agent`
"resolvendo" o problema — porque a única coisa que faltava era uma linha de entrada que
começasse um turno.

A frase "o modelo declara a próxima ação e então o turno acaba" descreve o sintoma ao contrário.
O modelo não declarou e parou: ele foi **cortado no meio da frase**. Ver §3.

Isto também significa que o **controle negativo do cartão se inverte**: `sizingcodex` não estava
numa condição de ambiente diferente. Ele foi alcançado pela mesma varredura (§4).

---

## 1. Amostra e janela

| item | valor |
|---|---|
| janela de medição | 2026-08-18, 11:49–12:15 local (`-03:00`) |
| janela dos fatos medidos | 2026-08-18, 11:33:01 → 11:43:51 local |
| agentes com evidência viva | `podagrok`, `envgrok`, `menoresgrok` (3 das 5 ocorrências) |
| agentes sem evidência | `hunkgrok`, `modelogrok` (08-17): panes, sessões e ledgers já removidos |
| controle negativo | `sizingcodex`: **apagado às 11:49**, durante esta medição (§4) |
| runtime | `grok 1.0.5 (5115b46bc9) [stable]`, modelo `grok-4.6-build` (`model_id: grok-4.6`) |

**Fuso**: o host roda em `-03:00`. Todo timestamp `Z` dos ledgers é local **+3 h**. As "11:36:41 /
11:37:01 / 11:37:14" do cartão são horas locais; nos arquivos aparecem como `14:36`–`14:37Z`.
Confundir os dois foi o que fez a janela parecer vazia numa primeira leitura.

**Preservação**: `sizingcodex.log` e `sizingcodex-*.jsonl` existiam às 11:49:06 e não existiam às
11:49:57 — o agente foi dispensado no meio da medição. Copiei panes e ledgers dos três grok para
o scratchpad antes de analisar; as citações abaixo saem dessa cópia e dos arquivos vivos do
runtime, que ainda existem.

---

## 2. A cadeia causal, com carimbo de tempo

Fonte primária: `events.jsonl` do próprio grok, em
`.tachyon/bridge-mcp/<agente>.grok/sessions/<cwd>/<sessionId>/events.jsonl`.

```
11:37:07.??  processo tachyon-engine:b349073a INICIA          (ps -o lstart)
11:37:08     tmux -C attach-session -t =tachyon-ctl-b349073a
11:37:09.24  .tachyon/config.lkg.json reescrito
11:37:10.37  claude: bridge-mcp/claude.json + spawn-settings/claude.json + hooks .cjs reescritos
11:37:13     claude: SessionStart source="resume"                (session-owners.jsonl)
11:37:15.35  envgrok:     turn_ended cancelled / mid_turn_abort / ctrl_c
11:37:15     envgrok:     NOVO processo grok -r 3611210f…        (ps -o lstart)
11:37:16.41  envgrok:     hooks/{session-start,stop}.json reescritos
11:37:17.09  envgrok:     mcp_init_completed  is_reinit=false
11:37:18.50  menoresgrok: turn_ended cancelled / mid_turn_abort / ctrl_c
11:37:18     menoresgrok: NOVO processo grok -r 0d9d6b35…        (ps -o lstart)
11:37:19.61  menoresgrok: hooks reescritos
11:37:20.27  menoresgrok: mcp_init_completed  is_reinit=false
11:37:21.74  podagrok:    turn_ended cancelled / mid_turn_abort / ctrl_c
11:37:22.85  podagrok:    hooks reescritos
11:37:23.57  podagrok:    mcp_init_completed  is_reinit=false
11:37:26.26  codex:       activity/codex-tool-hook-record.cjs reescrito
…
11:43:38.87  podagrok:    turn_started turn=1  (o notify do coordenador)
11:43:48.64  envgrok:     turn_started turn=1
11:43:50.93  menoresgrok: turn_started turn=1
```

Três coisas fecham o caso:

1. **O horário de início do processo é o horário do cancelamento.** `ps -eo pid,lstart` mostra os
   processos `grok --always-approve -r … --no-memory` de `envgrok` e `menoresgrok` iniciados em
   `11:37:15` e `11:37:18` — exatamente os instantes dos respectivos `turn_ended cancelled`. O
   turno não terminou e depois algo aconteceu: **o turno terminou porque o processo foi trocado**.

2. **O espaçamento é de laço sequencial**: 15.35 → 18.50 → 21.74, ou seja **3,15 s e 3,24 s**.
   Cinco agentes em ordem (claude 13, envgrok 15, menoresgrok 18, podagrok 21, codex 26). Isso é
   um `for` sobre a frota, não três modelos coincidindo.

3. **Cada grok reinicializa MCP 1,7–2,2 s depois do cancelamento, com `is_reinit=false`.** Um
   processo que continuasse vivo não faria uma inicialização de MCP do zero. É processo novo.

As panes tmux **sobreviveram** (`tachyon-b349073a-envgrok` criada 11:33:28, `…-menoresgrok`
11:34:17): o Tachyon não recriou o painel, trocou o **processo dentro** dele. Por isso o pane
transcript é contínuo e a parada parece um evento do modelo.

### 2.1 Por onde a troca entra

`AgentManager.resume()` (`packages/engine/src/agents/AgentManager.ts:4800`) mata e relança o
processo. Ele **sabe** que o alvo pode estar vivo — o comentário da checagem de vagas diz
literalmente que "respawning THIS agent (already live) is a replace, not a new seat"
(`AgentManager.ts:4855-4862`) — e **não há nenhuma guarda de "este agente está no meio de um
turno"** em nenhum ponto da função.

A porta automática *é* protegida: `planResume` (`packages/engine/src/resume/planResume.ts:44`)
classifica sessão viva como `reattach`, nunca `auto-resume`. As outras portas não:

- `Workspace.resumeAgent(name)` — `packages/engine/src/workspace/Workspace.ts:6644` (↻ da sidebar)
- `Workspace.resumeAllOffered()` — `packages/engine/src/workspace/Workspace.ts:6663` ("Resume all")

Ambas iteram e chamam `manager.resume` direto, sem consultar se o agente está trabalhando. O laço
sequencial de `resumeAllOffered` tem exatamente a forma do espaçamento medido.

**O que NÃO ficou provado:** qual dessas portas disparou às 11:37. O disco não guarda essa
decisão — não há log do engine, `.tachyon/deploys/` não tem entrada às 11:37, e `tachyon.yml` não
mudou (mtime 08-17 20:00). Sei que **o processo do engine reiniciou** e que **cinco runtimes foram
trocados em sequência logo depois**; não sei se o gatilho foi auto-resume com `liveSessions` ainda
vazio, um clique humano em "Resume all", ou o ↻. Registro isso como pergunta aberta em vez de
escolher a versão mais bonita. O conserto proposto em §7 vale para as três.

---

## 3. O que o modelo estava fazendo quando foi cortado

`podagrok`, `events.jsonl`, janela 11:37:20–11:37:22:

```
11:37:20.506 … 11:37:21.100   phase_changed -> streaming_text   (39 chunks)
11:37:21.738                  turn_ended cancelled / mid_turn_abort / ctrl_c
```

O modelo estava **transmitindo texto** e foi cortado 0,6 s depois do último chunk. O pane mostra a
frase que ele estava escrevendo:

> *"vsce is on PATH. I'll start the before-change build and write the pack/inventory script in /tmp
> so we can measure a real VSIX without touching release."*

Essa frase **não existe em nenhum registro durável**: não está no `chat_history.jsonl` (grep por
`vsce is on PATH` → 0 ocorrências) nem como `assistant.message.completed` no ledger de atividade
do Tachyon. Ela foi renderizada e perdida. É por isso que o turno interrompido termina, no
histórico, num `tool_result` que ninguém consumiu:

| agente | tipo da última linha antes do notify | tamanho |
|---|---|---|
| `podagrok` | `tool_result` | 3.753 B |
| `envgrok` | `tool_result` | 4.272 B |
| `menoresgrok` | `tool_result` | 1.635 B |

**Isso é anômalo, e a taxa-base diz o quanto.** Varri as 9 sessões grok em disco
(`*.grok/sessions/*/*/chat_history.jsonl`) e classifiquei o tipo da linha imediatamente anterior a
cada fronteira de turno: **37 `assistant` contra 12 `tool_result`**. Descontando as fronteiras de
bootstrap (índices ≤ 11, artefato do meu detector), sobram **5** `tool_result` reais — as **3
paradas** desta investigação mais duas no agente persistente `grok`. Uma dessas duas é
especialmente eloquente: a mensagem seguinte do humano é **"acabou ?"**. Mesmo formato, mesma
pergunta, ocorrência mais antiga.

Turno normal termina em `assistant` persistido. Turno cortado termina em `tool_result` com a
última fala do modelo perdida.

---

## 4. Runtime ou projeção do Tachyon? — e o controle negativo se inverte

**É do Tachyon.** Duas medições independentes.

### 4.1 Controle: grok FORA do Tachyon

`grok 1.0.5`, `~/.grok/hooks` **vazio** (verificado: 0 arquivos), sem MCP do Bridge, repositório
git isolado no scratchpad, tarefa de 8 passos com leitura, escrita, execução, teste, correção e
commit — a mesma forma das tarefas que morreram.

```
grok --always-approve --no-memory --cwd <repo> \
     --output-format streaming-json --prompt-file <prompt>
```

| run | exit | segundos | REPORT.md | inventory.mjs | test.mjs | commits | stopReason |
|---|---:|---:|---|---|---|---:|---|
| 1 | 0 | 93 | sim | sim | sim | 2 | `end_turn` |
| 2 | 0 | 137 | sim | sim | sim | 2 | `end_turn` |
| 3 | 0 | 191 | sim | sim | sim | 2 | `end_turn` |

**3 de 3 entregaram os oito passos e terminaram em `end_turn`.** Nenhum abandonou o trabalho no
meio. Amostra pequena e declarada como tal; o ponto não é provar que nunca aconteceria fora do
Tachyon, é que o comportamento **não aparece sem a varredura do Tachyon** e aparece **3 de 3** com
ela, com o runtime dizendo por escrito que foi cancelamento externo.

### 4.2 O controle negativo do cartão não separa o que se pensava

O cartão apoia-se em `sizingcodex` ter continuado trabalhando na mesma janela, concluindo "os três
grok encerram sozinhos, o codex não". Mas `activity/codex-tool-hook-record.cjs` foi reescrito às
**11:37:26.26** — 4,5 s depois do `podagrok`. **O codex estava na mesma varredura**, era só o
próximo da fila. E o `■ Conversation interrupted` no pane dele não é o oposto de uma interrupção:
é o codex **renderizando uma**.

Então a diferença medida entre os runtimes não é "grok para sozinho, codex não". É: **diante da
mesma troca de processo, o grok volta ocioso e silencioso, e o codex não fica nesse estado.** Isso
continua sendo uma diferença de runtime que vale registrar — mas não é a diferença que o cartão
supunha, e ela não faz o defeito ser do grok.

Não pude fechar essa metade: os arquivos do `sizingcodex` foram apagados às 11:49, entre duas
listagens minhas. O que afirmo dele vem do mtime do hook e do pane que li antes do apagamento.

---

## 5. O hook de Stop: correlação por horário (o item 1 do cartão)

### 5.1 O que é o `[hooks: 1]`

Exatamente um hook de Stop, e está em disco:
`.tachyon/bridge-mcp/podagrok.grok/hooks/stop.json` →
`node .tachyon/activity/runtime-status-publish.cjs grok <failureFile> podagrok`.

Grok escreve `Stop` para 1 hook; a dupla de persistência (`persistence-stop-record.cjs`) **não**
está ligada para grok — `persistence-stop.jsonl` tem 1.460 linhas e **zero** de qualquer agente
grok (`claude` 1.433, `claude-cowntdown` 23, `claude-prosa` 3, `codex` 1).

### 5.2 O hook não pode causar a parada, e isso é executável

A documentação do próprio grok neste host (`~/.grok/docs/user-guide/10-hooks.md`, §"Stop Decision
Control") diz que um hook de Stop **pode** segurar o turno: `{"decision":"block","reason":…}` no
**stdout**, ou saída 2, mantêm o agente trabalhando; *"Allow the stop: exit 0 with no output"*.

`runtime-status-publish.cjs` termina em `.catch(logFailure)`, e `logFailure` escreve **num
arquivo**, nunca no stdout. Medido:

```
$ TACHYON_BRIDGE_URL=http://127.0.0.1:59999/mcp TACHYON_AGENT_BRIDGE_TOKEN=dummy \
    node .tachyon/activity/runtime-status-publish.cjs grok /tmp/f.jsonl testagent
HOOK_EXIT=0          # stdout vazio
```

Saída 0, stdout vazio, nos dois caminhos — sucesso e falha. Pela regra citada, isso é sempre
"allow the stop". **O hook observa; não decide.** A doc reforça: *"Hook failures fail open: the
agent stops normally."* Duas refutações independentes.

### 5.3 A correlação por horário: negativa para as três paradas

`persistence-hooks-failures.jsonl`, **contagem completa, 88 linhas** (o arquivo tem 16 KB e 88
linhas, abaixo dos limites de poda de 256 KB / 2.000 linhas do próprio script — logo nenhuma linha
foi descartada por deduplicação, e essas 88 são tudo que existe):

| fato | valor |
|---|---|
| linhas na janela `14:30Z–14:45Z` (as três paradas) | **0** |
| linhas de `menoresgrok`, `podagrok`, `envgrok` | **0** (nenhuma, em nenhum horário) |
| última falha antes das paradas | `edhgrok`, `13:28:23.898Z` = **10:28 local**, 1 h 08 min antes |
| `hunkgrok` | `01:14:27.262Z` (08-17, 22:14 local) |
| `modelogrok` | `01:20:39.296Z` (08-17, 22:20 local) |

**Nas três paradas de 08-18 não houve falha de hook de Stop nenhuma.** As dezenas de linhas do
ledger são reais, mas de outros agentes e outros horários.

### 5.4 O que essas falhas são de verdade — reproduzido

`"reason":"runtime status hook initialize failed"` significa que o POST `initialize` chegou e foi
recusado. Reproduzi contra o Bridge **vivo** com um token inválido:

```
$ curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:42897/mcp \
    -H 'authorization: Bearer stale-token-xyz' … 
401
$ TACHYON_BRIDGE_URL=http://127.0.0.1:42897/mcp TACHYON_AGENT_BRIDGE_TOKEN=stale-token-xyz \
    node .tachyon/activity/runtime-status-publish.cjs grok /tmp/f2.jsonl testagent
HOOK_EXIT=0
{"agent":"testagent","event":"Stop","script":"runtime-status-publish",
 "reason":"runtime status hook initialize failed", …}
```

String idêntica à do ledger, a partir de **401**. Com o Bridge inalcançável a razão é outra
(`"The operation was aborted due to timeout"`), o que distingue os dois casos.

Ou seja: essas linhas marcam **agentes cujo token não autentica mais** — o estado em que fica um
runtime que continua vivo depois de o engine reemitir credenciais. É **outro sintoma do mesmo
evento** (o engine reiniciando), não a causa dele. Encaixa com as duas ocorrências de 08-17
carregarem linha de falha e as três de hoje não: hoje os processos foram trocados, e o hook do
processo morto não chegou a rodar.

---

## 6. O que descartei, e como

Os descartes do cartão foram respeitados e não remedidos. Estes são os meus.

| hipótese | como descartei | resultado |
|---|---|---|
| Hook de Stop causa/participa da parada | doc do runtime + execução do hook com exit code capturado (§5.2) | **descartada** — exit 0, stdout vazio = "allow", nos dois caminhos |
| Falha de hook coincide com as paradas | contagem completa das 88 linhas, janela declarada (§5.3) | **descartada** — 0 linhas na janela, 0 para os 3 agentes |
| Limite de contexto | `conversation_message_count` no `turn_started` do turno seguinte: 98, 76 e 71 mensagens; o pane mostra 65K/500K, e o turno 1 seguiu adiante por mais de 10 min sem parar | **descartada** — não há teto sendo tocado, e o mesmo contexto continuou funcionando |
| O modelo decidiu parar após anunciar o próximo passo | `events.jsonl`: `streaming_text` até 0,6 s antes do fim, e `outcome: cancelled` (§3) | **descartada** — foi cortado no meio da frase, não terminou |
| Comportamento do runtime grok | 3 runs fora do Tachyon, sem hooks, tarefa equivalente (§4.1) | **descartada** — 3/3 completaram, `end_turn` |
| Disco cheio / falha de escrita da sessão | `df`: 883 GB livres em `/` | **descartada** |
| Tachyon poupa agente vivo no caminho automático | `planResume.ts:44` classifica sessão viva como `reattach` | **confirmado** — a porta automática é protegida; as outras não (§2.1) |

Duas coisas que **não** meço aqui, declaradas: **qual porta** chamou `resume` às 11:37 (§2.1), e o
comportamento do `sizingcodex` depois do apagamento dos arquivos (§4.2).

---

## 7. Conserto proposto — para virar cartão, não implementado aqui

O defeito é uma pergunta de "quem mais alcança isto?" não feita: `resume()` foi pensado para um
agente **parado** e é alcançado por portas que pegam um agente **trabalhando**.

**Arquivo e linha:**

- `packages/engine/src/agents/AgentManager.ts:4800` — `async resume(name, record, opts)`. Não há
  checagem de ocupação. A guarda cabe aqui, na função, não em cada chamador: é o ponto por onde
  todas as portas passam.
- Chamadores que hoje alcançam agente vivo:
  - `packages/engine/src/workspace/Workspace.ts:6644` — `resumeAgent` (↻ da sidebar)
  - `packages/engine/src/workspace/Workspace.ts:6663` — `resumeAllOffered` ("Resume all")
  - `packages/engine/src/agents/AgentManager.ts:4377` — dentro de `restart`
- Contraste que mostra a forma certa: `packages/engine/src/resume/planResume.ts:44` já resolve
  isso para o caminho automático (`liveSessions` → `reattach`).

**A lista ATOR × GATILHO que vira lista de casos de teste**, na convenção do repositório:

| ator | gatilho | hoje | esperado |
|---|---|---|---|
| Tachyon | reconciliação no start | `reattach` (protegido) | manter |
| Interface | ↻ da sidebar num agente em turno | troca o processo, turno perdido em silêncio | recusar ou avisar |
| Interface | "Resume all" com agente em turno | idem, para a frota inteira | idem |
| Agente | `restart` via Bridge | passa pelo mesmo `resume` | idem |

**Forma mínima sugerida:** `resume()` recusa (ou exige confirmação) quando o alvo está vivo **e**
em turno, com o estado já disponível em `attention`. Um agente ocioso continua sendo retomável sem
atrito — que é o caso de uso real da porta.

**Barato e independente:** quando a troca acontecer mesmo assim, quem relança deveria **resubmeter
o turno interrompido** ou deixar um sinal visível. Hoje `-r` restaura a conversa e some com a
última fala do modelo (§3), o que apaga a própria pista.

Não implementei nada disso: o contrato desta tarefa é medição, e o conserto mexe em autoridade de
ciclo de vida — assunto de cartão próprio, com revisão adversarial.

**Relação com `t-3d3bdd`:** aquele cartão (detectar e cutucar agente parado, qualquer runtime)
**continua valendo e fica mais barato**, porque agora se sabe que uma das causas produz um estado
reconhecível — sessão cujo último registro é um `tool_result` não consumido. Mas ele não substitui
este: cutucar é remediar o sintoma, e o `resume` que atropela um turno é evitável na origem.

---

## 8. Achados laterais (não são o pedido; registro para não se perderem)

1. **A última fala do modelo num turno cortado não é persistida** (§3). Quem retoma não vê o que
   ele acabou de dizer que ia fazer — e foi exatamente essa informação que o coordenador teve de
   redigitar à mão nos cinco notifies.
2. **O comentário do adaptador grok cita versões que a máquina não roda.**
   `packages/engine/src/plugins/adapters/grok.ts:17` diz *"transcribed at grok 0.2.114, re-read
   unchanged at 0.2.118"*; o host roda **1.0.5**. É a forma exata do problema já registrado em
   `t-1322b5` / `t-0ac2e9`. A doc lida em 1.0.5 (§5.2) descreve `StopCancelled`, `StopFailure`,
   `idle_prompt` e o limite de 8 continuações — mecanismos que o Tachyon hoje não usa.
3. **Não há trilha de auditoria para reinício do engine.** O que aconteceu às 11:37:07 só é
   visível por `ps -o lstart` e por mtime de arquivos materializados. Enquanto for assim, a
   pergunta de §2.1 fica sem resposta em qualquer investigação futura.
4. **`grok` sombreia `grep`→`ugrep` e `find`→`bfs`** dentro da sua ferramenta de shell (visível no
   `ps` do processo). Não afeta este caso; afeta quem for ler exit codes de agentes grok.

---

## 9. Como reproduzir a leitura

Tudo abaixo é leitura; nada toca agente vivo.

```bash
# 1. O veredito do próprio runtime
python3 - <<'PY'
import json,glob
for a in ('podagrok','envgrok','menoresgrok'):
    for p in glob.glob(f'.tachyon/bridge-mcp/{a}.grok/sessions/*/*/events.jsonl'):
        for l in open(p):
            r=json.loads(l)
            if r.get('type')=='turn_ended': print(a, r['ts'], r.get('outcome'), r.get('cancellation_context'))
PY

# 2. Horário de início do processo == horário do cancelamento
ps -eo pid,lstart,args | grep -a '[g]rok --always-approve -r'

# 3. Correlação com as falhas de hook: contagem completa, janela declarada
python3 -c "
import json
rows=[json.loads(l) for l in open('.tachyon/activity/persistence-hooks-failures.jsonl') if l.strip()]
print('total', len(rows))
print('na janela', len([r for r in rows if '2026-08-18T14:30' <= r['ts'] <= '2026-08-18T14:45']))
print('dos 3 agentes', len([r for r in rows if r['agent'] in {'podagrok','envgrok','menoresgrok'}]))"

# 4. O hook de Stop permite a parada nos dois caminhos (exit code real, sem pipe)
TACHYON_BRIDGE_URL=http://127.0.0.1:59999/mcp TACHYON_AGENT_BRIDGE_TOKEN=dummy \
  node .tachyon/activity/runtime-status-publish.cjs grok /tmp/f.jsonl testagent
echo "HOOK_EXIT=$?"
```
