# A verdade da entrega: o que o produto afirma e o que ele mediu

Medição para `t-7a297f` (a notice que virou draft e deixou o filho surdo) e `t-4c82fa` (o `working`
sintético dos primeiros ~10 s). Nada foi consertado. O objetivo é responder as quatro perguntas da
`t-7a297f` com número, dizer se as duas tasks são um defeito ou dois, e defender **uma** recomendação.

## Instrumentos

1. **Os bytes do incidente.** O pane fotografado de `grokauth` em 2026-08-09T23:00:49Z e o texto exato
   da notice (de `doorbells.jsonl`, entrada de 22:49:16Z) rodados contra o **código de produção**
   (`src/runtime/composerRegion.ts`, `src/bridge/notifyAgent.ts`) empacotado com esbuild. Nada foi
   transcrito à mão.
2. **Probe ao vivo.** `codex-cli 0.146.1`, pane tmux 220×50, `CODEX_HOME` isolado numa cópia de scratch,
   entregue pelo **mesmo gesto do produto**: `load-buffer` + `paste-buffer -p -d` + 180 ms + `send-keys C-m`,
   e leitura com `capture-pane -J` (e `-e` onde o perfil declara estilo). Sessão morta por nome ao final;
   `~/.codex` real intacto (`auth.json` de 03/08, `config.toml` de 06/08 — sem escrita).
3. **`doorbells.jsonl`** (2379 campainhas; 288 com o texto gravado, o campo existe desde 06/08 — spec 493)
   e os transcripts dos destinatários que ainda existem.
4. **Leitura no ponto de uso** das duas premissas da `t-4c82fa` (não por busca de texto).

Onde cada conclusão vale está dito em cada seção. `docs/runtimes/parity.md` é quem decide o alcance:
o perfil de composer do **codex é `source: "declared", verified: false`** — nunca foi medido ao vivo até
agora.

---

## 1. Por que o submit não landou

**O submit foi tentado, e pelo caminho imediato.** As duas primeiras `notify_agent` daquela noite
(22:48:44Z e 22:49:00Z) foram **recusadas por tamanho** — 503 e 506 caracteres contra o teto de 500 — e
nunca tocaram o pane. Só a terceira chegou: summary de 384 chars, linha composta de **433 chars**, receipt
`notified`. `notified` (e não `queued`) prova que a leitura de estado disse **ocioso**, não "busy". A
hipótese "o submit nem foi tentado porque o estado disse busy" está descartada com evidência, e explica
por que o composer segurava **uma** notice e não três.

**O Enter foi pressionado exatamente uma vez.** `TmuxService.sendSubmittedLine` tem quatro tentativas,
mas só repete enquanto a classificação disser `holds-text`. Rodando o código de produção sobre os bytes
do incidente:

```
NOTICE_LEN  433
STAGED_LEN  120     ← o que o leitor de região consegue recuperar
OCCUPIED    true    ← o guard vê rascunho
CLASSIFY    cleared ← o submit declara ENTREGUE
```

O laço de retry, que existe exatamente para "Enter perdido", foi **desligado pela própria classificação**.

**Por que a classificação erra.** O composer do codex quebra a linha ele mesmo: a primeira linha
renderizada carrega o glifo `›`, as continuações vêm com dois espaços e **sem glifo**. `occupiedLine`
exige o glifo, então `composerText` só devolve a primeira linha. Medido nos dois panes, com a mesma forma:

```
07[› [tachyon] claude → grokauth: Parou certo, diagnóstico errado: … Medi por fora,]
08[  ~/.grok/auth.json não existe mais (só o .lock órfão), então home real e home vazio …]
09[  deslogados. O banner segue autoritativo … SIGA: as quatro instruções estão no]
10[  journal da t-5dcf47, leia antes de escrever qualquer linha. [details: t-5dcf47]]
11[]
12[  gpt-5.6-sol default · ~/.cache/tachyon/worktrees/b349073a/grokauth]
```

Como o texto reconstruído (120 chars) não contém o texto procurado (433), `classifyComposerSubmission`
cai no ramo final — *"a região não contém mais o que digitei, logo saiu"* — e devolve `cleared`, que é a
única prova de entrega que o produto reconhece.

**O composer do codex NÃO engole o Enter.** No probe ao vivo, um único `C-m` submeteu uma linha de
327 chars que quebrava em duas linhas renderizadas, e o codex respondeu `ok`. Ou seja: a causa do incidente
não é um Enter ignorado por design. É que o produto **não tem como saber se ele landou** e, por não saber,
não repete.

**A matriz medida — mesmo runtime, mesmo perfil, 200 ms de intervalo:**

| pane                       | realidade      | `occupied` (guard) | `classify` (receipt) |
| -------------------------- | -------------- | ------------------ | -------------------- |
| 327 chars encostados       | **não** entregue | `true`           | `cleared`            |
| logo após o Enter          | **entregue**     | `false`          | `cleared`            |
| 58 chars encostados        | não entregue     | `true`           | `holds-text` ✔       |

Veredito idêntico para realidades opostas. E o controle de 58 chars mostra que o mecanismo **funciona
abaixo do limiar de quebra** — o defeito é da quebra, não do conceito.

**O limiar, com número:** num pane de 220 colunas a primeira linha renderizada tem 218 chars (`› ` + 216
de texto), então texto acima de **`pane_width − 4`** quebra. Panes de agente criados pelo Tachyon medem
220 colunas; um pane anexado media 134.

**Onde vale:** medido em **codex**. A mesma `occupiedLine` (glifo obrigatório) é usada por claude,
opencode, grok e hermes, então o buraco é estrutural para todos eles — mas **não medi a quebra ao vivo
nesses quatro**. `pi` é o único perfil imune por construção: usa `frameLine` com `occupiedLine: /\S/`,
que inclui as continuações. Um runtime sem composer declarado não oferece sinal nenhum e continua tão
desprotegido quanto sempre foi.

---

## 2. O produto sabe distinguir draft PRÓPRIO de draft humano?

**No ponto do guard, hoje: não.** `Workspace.humanDraftPresent` chama
`AttentionMonitor.probeComposerOccupied`, que devolve `boolean | undefined`. Nenhuma proveniência
atravessa. Os quatro consumidores do mesmo sinal — `deliverNotice`, `flushQueuedNotice`,
`applyPendingContextRenewal` e `write_input` — recebem só o booleano.

**O `delayedSenderMarker` não serve, e a medição mostra por quê.** Ele não está no ponto do guard: é um
sufixo colado na linha no momento do flush (`[delayed ~Nm; reported by 'X']`). Como sufixo, ele cai no
**fim** da linha — exatamente a parte que o leitor de região não enxerga quando a linha quebra. Como sinal
de proveniência para o guard, é inútil por construção.

**Mas a proveniência existe e é mensurável ali, por outra via.** Toda notice começa com o prefixo
`[tachyon] <from> → <to>: ` de `composeBoundedAgentNotice`, e esse prefixo cai na **primeira** linha
renderizada — a única que o leitor consegue ler. Medido, nos dois panes:

```
staged = "[tachyon] claude → grokauth: Parou certo, diagnóstico errado: … Medi por fora,"
staged = "[tachyon] probe -> dc: medicao de entrega, nao execute nada …"
```

Ou seja: o produto **pode** medir "este rascunho é meu" com o mesmo leitor que já usa, sem afrouxar nada.
A distinção seria medida, não inferida.

**Ressalva que a recomendação respeita:** o prefixo é texto, não assinatura. Um humano pode digitá-lo.
Por isso ele não é base suficiente para escrever por cima de um rascunho.

---

## 3. `notified` pode deixar de mentir?

**O que o caminho devolve hoje:** `{ status: "submitted", reason: "composer-cleared", attempts: 1 }`, que
`deliverNotice` traduz em `notified`. **Ele não sabe que falhou** — `cleared` é literalmente o ramo "a
região não contém mais o que eu digitei", e ela nunca contém, porque só a primeira linha é lida.

**O receipt honesto já existe e está inalcançável.** `submit-unconfirmed` foi construído pela `t-8d190f`
e mergeado em `de614358` (2026-07-28), **doze dias antes do incidente**. Para uma linha que quebra, o
caminho até ele é inatingível: `holds-text` exige `staged === wanted`, e `staged` é o primeiro pedaço.
Nenhuma tentativa, nenhum `still-staged`, nenhum aviso.

**O número:** das 288 notices com texto gravado, **264 (92 %) passam de 218 chars**; num pane de 134
colunas, 286 de 288 (99 %) passam de 130. Distribuição: mínimo 152, mediana 380, p90 548, máximo 730.
Portanto, hoje **a confirmação de submit é informativa para ~8 % das notices e cega para ~92 %**, e é
cega nos dois sentidos: não sabe reprovar uma entrega que não houve, nem aprovar a que houve.

**Um dano colateral que a mesma régua causa:** o estado `diverged` — o que existe para **proteger o
rascunho do humano**, mandando parar em vez de apertar Enter sobre texto alheio — também é inalcançável
para conteúdo quebrado, porque uma segunda linha digitada por um humano é invisível para o leitor. O
leitor cego enfraquece a proteção humana; consertá-lo a fortalece.

---

## 4. Quantos agentes já morreram assim

**O instrumento nomeado na task não responde à pergunta.** `.tachyon/pane-transcripts/` são fluxos brutos
de terminal (`pipe-pane`, com movimentação de cursor e redesenho), não linhas: reconstruir o que esteve
na tela exigiria emular um terminal. Existem **13 arquivos** para **354 nomes de agente já criados**, e
**não há transcript de `grokauth`** — o do agente que morreu é justamente um dos que não existem.

**E nada, em lugar nenhum, grava o DESTINO de uma entrega.** `doorbells.jsonl` grava a campainha
(from/to/at/summary), não o desfecho. Os logs de `activity/` espelham o transcript do runtime. O
`NoticeDeliveryResult` volta para quem chamou e é descartado. **A pergunta é indeterminável hoje por
construção** — e essa é a resposta, não uma desculpa.

**O que dá para cercar:**

- **1 morte confirmada, com foto:** `grokauth`.
- **População de risco:** mapeando os 354 spawns, **93 campainhas** foram para agentes lançados com
  comando `codex` (111 agentes codex já criados); 42 delas desde 06/08 têm o texto gravado, e quase todas
  passam do limiar de quebra.
- **Destinatários que sobreviveram** (runtime **claude**, não codex — o transcript do runtime registra a
  linha recebida, então dá para casar campainha com chegada): das **177** campainhas com texto para
  `claude`, **152 aparecem no transcript dele e 25 (14 %) não aparecem em lugar nenhum**; para
  `claude-fork-1`, 2 de 22. Latência das entregues: mediana 0 s, p90 **203 s**, máximo **538 s**, com 8
  acima de cinco minutos. A causa caso a caso não está determinada — parte pode ser expiração na fila
  (que o produto avisa ao humano) e parte encalhe silencioso. O ponto é que **o produto não sabe dizer
  qual foi qual**.

**O caso das 23 minutos de hoje é o mesmo gate por outro lado, e tem número.** `claude → tmuxreap` às
02:21:56Z, entregue por volta de 02:44 — depois de o agente já ter concluído sozinho. O TTL da fila é
**10 minutos** (`DEFAULT_NOTICE_TTL_MS`), então essa notice deveria ter **expirado 13 minutos antes de
chegar**. Não expirou porque `clearExpired` mora dentro de `flushQueuedNotice`, que só roda em
`recoverOnIdle`, que só é chamado na aresta `working → idle`. **Quem nunca vai a idle não recebe e
também não expira** — a saída declarada da `t-fb1453` (expirar e avisar o humano pelo nome) depende
exatamente da aresta que ela existe para cobrir.

**A porta de leitura durável existe e ninguém usa.** `read_notices` (spec 493) foi chamada **3 vezes** em
todos os transcripts que sobrevivem (2 por `claude`, 1 por `claude-fork-1`). É um *pull*, e um agente
surdo não sabe que precisa puxar.

---

## Veredito: um defeito ou dois?

**Dois defeitos, um eixo — e eles se compõem.**

- **`t-7a297f` é um defeito de INSTRUMENTO.** Um leitor de região responde a duas perguntas diferentes
  ("há rascunho?" e "minha linha saiu?") com uma régua que só enxerga a primeira linha renderizada. Ele
  erra para o lado caro nas duas: diz *entregue* quando não entregou, e diz *ocupado* quando o resíduo é
  do próprio produto. Foi este que custou um agente.
- **`t-4c82fa` é um defeito de ESTADO.** O `working` inicial é sintético — o próprio
  `AttentionMonitor.runTick` diz isso três linhas abaixo, ao calcular `hasStartedTurn` — e três
  consumidores acreditam nele sem consultar a evidência que o monitor já tem. **Premissa verificada hoje
  no ponto de uso:** o seed continua em `AttentionMonitor.ts` (`state: "working"` no snapshot novo) e
  `submitRefuseReason` (`src/prompts/injectFlow.ts:42`) continua olhando só `state`. A task segue válida.

O que os une não é a causa, é a consequência: **os dois transformam "não sei" em uma afirmação positiva.**
E eles se encontram num terceiro lugar, que nenhuma das duas tasks nomeia: **a fila**. O `working` sem base
manda a notice para a fila (`deliverNotice` enfileira em `working`), e a fila só drena numa aresta que pode
não vir — foi assim que a notice de hoje chegou 23 minutos depois de deixar de importar. Vale registrar
que `prompt.inject` com submit é uma **terceira porta**, mais fraca que as outras duas: usa o estado
*cacheado* e chama `sendSubmittedLine` **sem** passar o perfil de composer, então cai na heurística antiga.

Ator × gatilho do mesmo efeito, para quem for consertar: Interface (humano injetando prompt), Agente
(`write_input`/`notify_agent` pela Bridge), Tachyon (renovação de contexto, flush da fila, backstop) —
e o gatilho comum "logo depois de spawn/restart/resume", que é a mesma semente por três portas.

---

## Recomendação — uma, defendida

**Consertar o INSTRUMENTO primeiro: fazer o leitor de região enxergar a linha quebrada.**

Concretamente: declarar por runtime uma **regra de linha-de-continuação medida** e fazer `composerText`
reconstruir o texto antes de comparar (normalizando espaço em branco). A regra está medida nos dois panes,
com a mesma forma nos dois: *dentro da região, as linhas não-vazias imediatamente seguintes à linha do
prompt são continuação; a primeira linha vazia encerra* — é isso que separa a continuação da mobília
(`gpt-5.6-sol default · …`), que também começa com dois espaços mas vem depois de uma linha em branco.

Por que esta e não a outra:

- **Conserta as duas mentiras de uma vez.** `holds-text` volta a ser alcançável → o retry volta a
  funcionar → `submit-unconfirmed` volta a ser alcançável → **`notified` para de mentir sozinho**, sem
  inventar semântica nova de receipt. A `t-8d190f` já pagou por essa semântica; o que falta é o
  instrumento que a alimenta.
- **Não afrouxa guard nenhum.** `isComposerOccupied` não muda de resposta (ela já casa na primeira linha);
  o guard continua recusando exatamente o que recusa hoje. Ele só passa a **ler** o que está lá. E como
  mostrado na §3, isso **fortalece** a proteção do rascunho humano, porque devolve o `diverged`.
- **A alternativa "o guard aprende a distinguir a própria notice" é a que afrouxa, e sozinha não resolve.**
  Ela depende de um prefixo de texto que um humano pode digitar, e não conserta o receipt: um agente cuja
  notice encalhou continua surdo — só que agora o produto escreve por cima do que estiver lá. Se depois do
  instrumento ainda quisermos limpar resíduo próprio, a distinção estará medida (o prefixo está na primeira
  linha, §2) e o risco fica limitado a *re-submeter o que eu mesmo digitei*, nunca a sobrescrever.
- **Custo e risco.** Mudança confinada a `src/runtime/composerRegion.ts` mais um campo medido no perfil de
  runtime. O fail-before já existe em bytes reais: o pane do incidente (deve dar `holds-text`, hoje dá
  `cleared`) e o pane pós-Enter do probe (deve seguir `cleared`). Vale só onde há região declarada;
  `parity.md` decide onde, e o perfil do codex deveria subir de `declared/false` para medido, porque agora
  ele foi medido.

**Ordem sugerida, do mais barato e mais urgente para o mais arriscado:**

1. **O instrumento** (acima). É o que custou um agente e é a mudança mais contida.
2. **A fila.** Drenar e expirar fora da aresta `working → idle`, para que "queued" tenha um fim que não
   dependa de um evento que pode não acontecer. É o caso das 23 minutos, e é independente do item 1.
3. **`t-4c82fa`.** Fazer a recusa consultar `hasStartedTurn` em vez de só `state`. É a mais arriscada das
   três — mexe em semântica de attention para a frota inteira, com três portas para o mesmo seed — e é a
   menos urgente, porque a janela é de ~10 s e o custo é atraso, não perda.

---

## O que NÃO foi medido

- A quebra de linha do composer **ao vivo em claude, grok, opencode e hermes**. O buraco é estrutural pela
  forma da `occupiedLine`, mas a largura e o formato da continuação de cada um são suposição até serem
  medidos.
- **Por que o Enter do incidente não landou.** Medi que um Enter basta no codex 0.146.1 hoje, e medi que o
  produto só mandou um. O estado exato do pane de `grokauth` no instante do `C-m` não é recuperável 12 h
  depois — o transcript daquele agente não existe. O que está provado é que, se o Enter tivesse se perdido,
  o produto **não poderia** ter percebido nem repetido.
- **O desfecho individual das 93 campainhas para agentes codex**, pela razão da §4: o produto não grava
  desfecho de entrega.
