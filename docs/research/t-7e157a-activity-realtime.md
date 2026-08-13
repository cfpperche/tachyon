# t-7e157a — Sensação de tempo real no Activity

Medido 2026-08-13 no worktree `tachyon/tmp.actlatency.20260813-165555-c8fb`, contra o `src/` de `e002617d` (tree `3fc7035a`, igual a `main` no momento da medição). Agente `actlatency`, runtime Grok, engine a escrever em `/home/goat/tachyon`. Investigação somente — nenhum `src/` foi alterado; este arquivo é o único delta.

Uma passagem anterior (journal `j-49ab38dbb7f2`) cronometrou hop 1/2 e o tick, mas **não o pixel**. Esta é a medição que fecha o DONE_WHEN: write nativo → JSONL → watcher → texto no DOM → `requestAnimationFrame` (e PNG que muda).

Brutos: `/tmp/t-7e157a-actlatency/` (`live.jsonl`, `watch_compare.jsonl`, `tick_bench.json`, `render_bench.json`, `resolve_bench.json`, `pixel/pixel_bench.json`).

---

## 1. O mapa do dono está certo. O número ao vivo não o derruba.

Cadeia viva (confirmada no processo, não só no código):

```
runtime escreve o transcript nativo
  → ActivityLogManager.timer          setInterval 2000 ms   (daemon)
  → ActivityLogWriter.poll            append no JSONL durável
  → activityFeed fs.watchFile         interval 500 ms       (extension host)
  → render() + postMessage(vm inteiro)
  → webview setVm(vm)                 Preact reconcilia por sequence
```

`stateTimer` 1000 ms só empurra `agentState` (bolinha "working"). Não carrega evento.

### Hop 1 — write nativo → append no JSONL (ao vivo, poll 5 ms)

Sessão desta investigação. Transcript nativo:

`/home/goat/tachyon/.tachyon/bridge-mcp/actlatency.grok/sessions/%2Fhome%2Fgoat%2F.cache%2Ftachyon%2Fworktrees%2Fb349073a%2Factlatency/cd550ef4-e95a-4ddb-9a25-7d6ab84a4f2c/chat_history.jsonl`

JSONL durável: `/home/goat/tachyon/.tachyon/activity/actlatency-0828843b8d619f3c.jsonl`

Comando:

```
python3 /tmp/t-7e157a-actlatency/live_monitor.py   # poll 5 ms, grava live.jsonl
# emitir no runtime (echo MARKER-t7e157a-L1 … L4, e o trabalho normal da sessão)
```

Espera `native_grow → próximo durable_grow` (14 amostras independentes nesta sessão):

| | ms |
|---|---|
| min | **85** |
| p50 | **1096** |
| média | **1080** |
| máx | **1946** |

Marcadores explícitos (mesmo relógio):

| marker | hop 1 |
|---|---|
| `MARKER-t7e157a-bench` | 1128 ms |
| `MARKER-t7e157a-L1`…`L4` (mesmo assistant) | 993 ms |
| tool_result L1 | 1898 ms |
| tool_result L2 | 898 ms |
| tool_result L3 | 1946 ms |
| tool_result L4 | 945 ms |

Nenhum sample passou de 2000 ms — o teto do timer não foi atingido, a fase caiu no meio ou perto do fim. **Média ~1,1 s.** O dono escreveu média ~1,25 s / teto ~2,5 s (2 s + 500 ms). Hop 1 sozinho explica a média. O teto de 2,5 s continua o modelo certo quando se soma o watcher.

A quantização de 2 s é visível: L1–L4 foram escritos no nativo a ~3 s de intervalo; o Activity os despeja no tick, não os acompanha.

Grok **escreve** `tool_result` no nativo quando o comando retorna (L1–L4 caíram em writes distintos). O que o olho vê no Activity ainda é o lote do tick.

### Hop 2 — JSONL → callback do feed (ao vivo, mesmo arquivo)

```
node /tmp/t-7e157a-actlatency/watch_compare.js
```

`fs.watchFile({interval:500})` vs `fs.watch` (inotify) vs poll 5 ms no JSONL desta sessão. 22 disparos do `watchFile`:

| | ms após o poll 5 ms ver o write |
|---|---|
| min | 2 |
| p50 | **222** |
| média | 233 |
| máx | **467** |

Esperado 0–500, média 250. A amostra caiu no meio da fase. **Baixar 500→100 corta no máximo 20 % do teto e multiplica `stat()` por 5.** Não comece aqui.

`fs.watch` / inotify acorda no mesmo write; o atraso medido contra o poll de 5 ms é 0–3 ms quando o poll já viu o byte (o script também vê inotify *antes* do poll — aí o número grande é “desde o write anterior”, não o atraso deste).

### Hop 3 — `postMessage` → pixel (App real, Chrome headless)

Não abri janela VS Code (não autorizado). O último hop foi o **mesmo** `src/webview/activity/main.tsx` + `App.tsx` que o painel Activity carrega, empacotado por esbuild deste worktree, servido em `http://127.0.0.1:5179`, dirigido por `puppeteer-core` + `/usr/bin/google-chrome --headless=new`. Envelope idêntico: `{type:"activity", vm}`. O `JSON.stringify` do host foi medido à parte (abaixo). O chrome do webview VS Code não está neste número; o que falta é o `postMessage` do extension host, que é o stringify (1–2 ms) mais o IPC do webview (não cronometrado; em qualquer conta razoável fica em milissegundos).

```
cd <este worktree>
node /tmp/t-7e157a-actlatency/pixel_bench.mjs
```

VM primada: 600 itens do JSONL vivo do `claude` desta máquina (530 172 bytes no post). 12 incrementos com marker único; o PNG do viewport **mudou em todos**.

| caminho | texto no DOM p50 | 2× rAF p50 | PNG mudou |
|---|---|---|---|
| cold `setVm` de 600+1 | 151 ms | 178 ms | — |
| **+1 item em cima de 600** | **16 ms** | **39 ms** | sim, 12/12 |
| +1 item em cima de 5 | 4 ms | 32 ms | — |
| `JSON.parse` do envelope de 600 no cliente | 0,8 ms | — | — |

Os ~32 ms de rAF no feed pequeno são dois frames a 60 Hz, não trabalho. O texto já estava no DOM em 4–16 ms.

Uma corrida encadeada (poll 5 ms no JSONL vivo → `postMessage` imediato → texto) deu **9–17 ms** durable→pixel. Isso é o hop 3 com o watcher já acordado, não o E2E.

### Soma: nativo → pixel

| | hop 1 | hop 2 | hop 3 | total |
|---|---|---|---|---|
| típico (p50) | 1096 | 222 | 16 | **~1,3 s** |
| teto do modelo / máx medido | 2000 / 1946 | 500 / 467 | ~40 | **~2,5 s** |

O termo dominante é o tick de 2 s (~80 % do teto). O watcher é ~20 %. O pixel é ruído (1–2 %).

---

## 2. Duas coisas chamadas “tempo real”

### (a) Latência de verdade

O evento chega 0,09–1,95 s depois do write nativo, depois mais 0–0,47 s até o feed acordar, depois 16 ms até o pixel. **É latência real, não só percepção.** O mapa do dono manda.

### (b) Sensação de vivo

Independentes, e as duas pesam:

1. **O runtime não streama token no arquivo.** Grok escreve records completos (`reasoning` / `assistant` / `tool_result`) quando o passo fecha. Um `echo` só aparece no transcript **depois que o comando retorna** — um `sleep 5` no mesmo bash segura o marker. Mesmo com tick 0 ms, o Activity não “digita”.
2. **A bolinha “working” já existe.** `vm.agentState === "working"` pinta `.bubble.typing` (CSS 1,2 s). Atualiza pelo `stateTimer` de 1 s, fora da cadeia de eventos. Se o dono olha o Activity com o agente ocupado e ainda assim “parece morto”, a queixa é o **conteúdo** chegando em lotes, não a falta de spinner.
3. **O 2 s quantiza.** Vários `tool_result` nativos viram um único `render()` no tick. É exatamente a sensação de “atualiza de vez em quando”.
4. **O primeiro tool de um lote Grok some** (reproduzido nesta sessão — ver §6). O chip fica “rodando” para sempre. Isso é sensação de morto **mesmo com latência zero**.

(b) sem (a) (animar append, manter a bolinha) entrega percepção barata. **Não substitui cortar o tick:** o lote de 2 s é o que o olho lê como “morto”.

---

## 3. O tick de 2 s pode cair? Sim. O custo medido é ruído.

`ActivityLogWriter.poll` contra cópias do transcript grok vivo desta sessão (~468 KB), 40 ticks idle / 20 ticks com 1 record novo. Não tocou o log durável real.

```
npx esbuild /tmp/t-7e157a-actlatency/tick_bench.ts --bundle --platform=node --format=esm --outfile=/tmp/t-7e157a-actlatency/tick_bench.mjs
node /tmp/t-7e157a-actlatency/tick_bench.mjs
```

| agentes | idle p50 | idle p95 | 1 record novo p50 | first-tail (ativação, 1×) |
|---|---|---|---|---|
| 1 | 0,007 ms | 0,017 ms | 0,019 ms | 17 ms |
| 4 | 0,028 ms | 0,059 ms | 0,071 ms | 31 ms |
| 8 | 0,054 ms | 0,117 ms | 0,131 ms | 54 ms |

Resolve (o outro meio tick, a cada 3 s):

```
node /tmp/t-7e157a-actlatency/resolve_bench.mjs
```

| caminho | p50 |
|---|---|
| `existsSync` do transcript grok saudável | 0,001 ms |
| `readdir`+`stat` dos 28 jsonl de `~/.claude/projects/-home-goat-tachyon` | 0,14 ms |
| ler 256 B do head dos 28 | 0,09 ms |

A lição spec-221 (“o caro é o scan”) é verdadeira na forma e **irrelevante na magnitude atual**. 8 agentes idle a 250 ms = ~0,2 ms de CPU por segundo. O intervalo de 2 s não está protegendo a máquina. Está só atrasando o pixel.

Cuidado de comportamento, não de CPU: `LIFECYCLE_GRACE_POLLS = 3` (`src/activity/logWriter.ts:32`) é “uns 6 s” só porque o poll é ~2 s. Tick 250 ms vira ~750 ms de graça no marker `resumed`. Ajustar a constante se o tick cair.

---

## 4. Push em vez de pull? Não é a 492.

SDD 492 (draft, 2026-08-06) é outra pergunta: N janelas VS Code cada uma em `setInterval(3000)` rederivando o modelo. Conclusão dela: o hub em grande parte já existe; rejeitar delta com payload; no máximo centralizar tmux/PID.

O que **já existe** e não serve este problema:

- `onAppended` → `host.onActivityAppended` → evento `activity-appended` (`src/workspace/DaemonEngineHost.ts:417`)
- o cliente só faz `sidebarProto.refresh()` com isso (`src/extension.ts:2445`)
- o feed do Activity **não assina**. Ele lê o JSONL com `watchFile` 500 ms
- o `client.sync` que entrega o evento é ele próprio um poll de **1 s** (`src/extension.ts:2460`)

Ligar o feed a `activity-appended` hoje: hop 1 (0–2 s) + sync (0–1 s) = **pior** que hop 1 + `watchFile` (0–0,5 s). Só fica melhor se o sync passar a ser event-driven (socket readable). Isso é fatia da 492, e **não corta o termo dominante**.

O push que este problema pede é um andar abaixo:

```
fs.watch(transcript nativo)  →  poll() imediato  →  JSONL (fonte da verdade, append-only)
tick lento (2–3 s)           →  catch-up + re-resolve   (borda de descida)
fs.watch(JSONL) ou catchUp() →  feed visível
```

Isso **não** é reinventar meia 492. Não é canal paralelo. O JSONL continua a única fonte; o watcher só acorda o `poll` que já existe. Superfície escondida continua sem ler/construir/postar (SDD 485 B1). O tick lento é o trailing edge — se o inotify perder o último write, o próximo tick recupera.

`fs.watch` no JSONL (em vez de `watchFile` 500) é o mesmo padrão no último hop: barato, ≤20 % do teto, faça **depois** do tick.

---

## 5. O render é incremental no modelo e inteiro no fio. Não é o gargalo.

`createActivityBuilder().push` é O(novos) — o comentário em `activityView.ts:138` não mente.

```
node /tmp/t-7e157a-actlatency/render_bench.mjs
```

`render()` então:

1. `builder.view()` — p50 **0,002 ms** (actlatency 142 itens; claude 1967)
2. `items.slice(-600)`
3. `io.post(vm inteiro)` — `JSON.stringify` p50 **1,2 ms / 319 KB** (actlatency, 122 postados) e **1,9 ms / 530 KB** (claude, 600 postados)
4. webview `setVm(raw.vm)` — troca o VM todo
5. Preact reconcilia por `key={node.sequence}`
6. `Bubble` **não** é `memo`; `MarkdownView` memoíza em `text`, então markdown velho não reparseia
7. `buildSearchIndex` reconstrói os 600 a cada VM (`App.tsx:467`)
8. `content-visibility: auto` nos itens antes dos últimos 30 (`TAIL_LIVE`, `feedModel.ts:14`)

Não é 600 innerHTML cegos, e não é append. Cada evento **reenvia** até ~0,5 MB e **reexecuta** 600 componentes. Custa **16 ms até o texto no DOM** com 600 itens no Chrome, não segundos. O gargalo percebido **não** é o render.

Delta no post só se justificaria por jank medido no webview VS Code (não medido aqui — o PNG mudou limpo em 16 ms no Chrome). Não por latência.

---

## 6. Achado colateral — o primeiro tool_result de um lote Grok some

Já era `t-08abf8` (inbox). Reproduzido nesta sessão, não só lido.

Grok escreveu um `assistant` com 6 `tool_calls` (`call-41e0ceda-…-82` … `-87`). `ingestLines` (`logWriter.ts:202`) grava o record inteiro com `recordId = events[0].recordId` = id da **primeira** tool (`…-82`, o S2). O `tool_result` de S2 usa o mesmo `tool_call_id`. `ActivityLog.appendRecord` é idempotente nessa chave (`logStore.ts:232`) → **S2 nunca entrou como `tool.completed`**. Completions de `-83/84/85/86/87` entraram.

Causa no ponto de uso: `grokNormalizer.handleAssistant` emite `tool.started` com `recordId = call.id` (`grokNormalizer.ts:177`); `handleToolResult` reusa o mesmo id (`:199`); `ingestLines` chaveia o record de origem inteiro nesse id.

Efeito no Activity: o primeiro tool de um lote paralelo fica “rodando” para sempre. Isso é sensação de morto **mesmo com latência zero**. Não misturar com o corte do tick.

---

## 7. Recomendação, custo/benefício

Não implementar nesta task. Ordem se alguém for implementar:

| # | o quê | o que ganha | o que custa | fazer? |
|---|---|---|---|---|
| 1 | Tick 2000 → **250 ou 500 ms** | Corta ~75–87 % do teto de hop 1. CPU medido 0,05 ms / 8 agentes idle | Rever `LIFECYCLE_GRACE_POLLS` | **Sim. Primeiro.** |
| 2 | `fs.watch` no transcript nativo + tick lento de catch-up/resolve | Hop 1 ≈ tempo do `poll` (~0,02–0,2 ms) | Desenhar a borda de descida (já existe: o tick). Não afrouxar 485 B1 | Sim, se (1) ainda “parecer morto” |
| 3 | Consertar o `recordId` Grok (t-08abf8) | O primeiro tool de um lote passa a completar | Pequeno, separado | Sim, bug próprio |
| 4 | `fs.watch` no JSONL no lugar de `watchFile` 500 | Corta hop 2 de 0–500 ms para ~0 | Barato | Depois de (1) |
| 5 | Confiar na bolinha; no máximo um flash no append | Percepção, sem mexer em timer | Quase nada | Só se o dono ainda reclamar depois de (1) |
| 6 | Baixar `watchFile` 500→100 | ≤20 % do teto, 5× `stat` | Ruim | **Não começar aqui** |
| 7 | Delta / append DOM / post incremental | 16 ms → talvez 4 ms | Protocolo novo, catch-up de payload (492 rejeitou) | Não agora |
| 8 | Construir a 492 para “consertar o Activity” | Não corta o tick de 2 s | Spec draft, problema errado | **Não** |
| 9 | Canal paralelo que desvie do JSONL | Proibido pela task | Quebra reload / durabilidade | **Não** |

Se a conclusão tivesse sido “é percepção, não latência”, este documento a sustentaria. **Não é.** A latência é o timer de 2 s, medida ao vivo (p50 1,1 s, máx 1,95 s, teto do modelo 2,5 s com o watcher), e o custo de baixá-lo é ruído. O pixel do App é 16 ms. A percepção (lotes, tool que não completa, ausência de stream de token) é o segundo problema, não o primeiro.

---

## 8. O que não se afrouxa

- SDD 485 B1: superfície escondida não lê, não constrói, não posta (`activityFeed.ts:40-45, 161-163`). `catchUp()` no reveal é o trailing edge.
- Coalesce só com trailing edge. O tick lento **é** o trailing edge de qualquer `fs.watch` no transcript nativo.
- JSONL append-only, uma linha por record, atômico. Continua a fonte da verdade.

---

## 9. Como reproduzir cada afirmação

Caminhos vivos desta sessão (substituir se o agente/sessão mudou):

```
NATIVE=/home/goat/tachyon/.tachyon/bridge-mcp/actlatency.grok/sessions/%2Fhome%2Fgoat%2F.cache%2Ftachyon%2Fworktrees%2Fb349073a%2Factlatency/cd550ef4-e95a-4ddb-9a25-7d6ab84a4f2c/chat_history.jsonl
DURABLE=/home/goat/tachyon/.tachyon/activity/actlatency-0828843b8d619f3c.jsonl
TREE=/home/goat/.cache/tachyon/worktrees/b349073a/actlatency   # ou o checkout que se está medindo
```

| afirmação | comando |
|---|---|
| hop 1 p50 1096 / máx 1946 | `python3 /tmp/t-7e157a-actlatency/live_monitor.py` + emitir no runtime; parear `native_grow` com o próximo `durable_grow` |
| hop 2 watchFile p50 222 / máx 467 | `node /tmp/t-7e157a-actlatency/watch_compare.js` enquanto o JSONL cresce |
| hop 3 +1 item / 600 = 16 ms, PNG muda | `cd $TREE && node /tmp/t-7e157a-actlatency/pixel_bench.mjs` |
| tick idle 1/4/8 = 0,007 / 0,028 / 0,054 ms | `node /tmp/t-7e157a-actlatency/tick_bench.mjs` |
| stringify 600 itens = 1,9 ms | `node /tmp/t-7e157a-actlatency/render_bench.mjs` |
| `activity-appended` só refresca sidebar | `rg -n 'activity-appended' src/extension.ts src/workspace/DaemonEngineHost.ts` |
| `client.sync` é poll de 1 s | `src/extension.ts:2460` (`setTimeout(..., 1_000)`) |
| primeiro tool do lote some | `rg '41e0ceda-30db-4d81-b3ff-df240db74580-82' $DURABLE` — há `tool.started`, não há `tool.completed` |
| timers no código | `ActivityLogManager.ts:52,60` (2000); `activityFeed.ts:166` (500); `activityFeed.ts:178` (1000) |

Os scripts em `/tmp/t-7e157a-actlatency/` importam `src/` **deste** worktree. Reler o `state.json` do writer no monitor precisa tolerar rewrite vazio (o primeiro monitor desta sessão morreu nisso).

---

## 10. O que não foi medido

- Pixel **dentro** do webview VS Code (não abri o desktop). O número de 16 ms é o App Activity no Chrome, mesmo bundle.
- Jank de Preact com 600 itens no webview VS Code (no Chrome o PNG mudou limpo).
- Tick com dezenas de agentes, ou first-tail de um transcript de 180 MB.
- Claude ao vivo como fonte do hop 1 (o writer é o mesmo timer; o hop 3 usou o JSONL claude só como VM de 600 itens).
- `client.sync` event-driven (não existe hoje).
