# Inbox sweep — os 7 que estavam em `triaged`

**Task:** `t-617077`
**Árvore:** `39476818` (`0c5f26b575e10725dd7407956f4eab53bc184821`) — mesmo tip que o checkout primário em 2026-08-17
**Agente:** sweeptri · 2026-08-17
**Regra:** conferir, não reescrever cartão, não mudar status, não implementar.

Três perguntas por cartão: o caminho citado ainda existe? o problema ainda acontece? alguma entrega posterior já resolveu, no todo ou em parte?
Vereditos: **VALE COMO ESTA** · **PRECISA REESCREVER** · **NAO FAZ MAIS SENTIDO**.

A varredura de 2026-08-16 cobriu os 45 da inbox. Estes 7 já estavam em `triaged` e nunca tinham sido medidos contra a vizinhança atual. Idade não é critério — a inbox de ontem mostrou os quatro mais velhos intactos e os apodrecidos três dias mais novos.

---

## Tabela

| id | veredito | motivo |
|---|---|---|
| `t-312ad8` | VALE COMO ESTA | Sem spec/plan/tasks da fatia de profundidade. SDD 369 shipped e ainda nomeia Grok como follow-up. `grokSessionReader` é inspeção de sessão, não inventário de quota. |
| `t-4bd6a5` | VALE COMO ESTA | Aquisição Tachyon-owned de quota do Grok continua zero: `RuntimeOpsProviderV2` é `codex \| claude`; o serviço só coleta esses dois. |
| `t-a9789e` | VALE COMO ESTA | Quinze plugins no lock do primário, nenhum `adr`. Sem `docs/decisions/`. `t-54cdb2` é dest de install, não convenção ADR. |
| `t-4590b2` | PRECISA REESCREVER | O contexto (doorbells sem conteúdo, sem porta de leitura) envelheceu com spec 493. As 9 perguntas e o critério build/no-build ainda estão abertos. |
| `t-a48431` | VALE COMO ESTA | Caso especial: as três deps existem e estão `done`, não mortas. O contrato V1 não foi implementado (zero `heartbeat.*` no schema). |
| `t-f27be7` | VALE COMO ESTA | Sem plugin Wispr/voz. `transcribe` 0.2.0 é STT de arquivo e recusa live. `audio` é TTS. A investigação não começou. |
| `t-54c51a` | VALE COMO ESTA | Binário ainda `0.31.0` sha256 `71dbe415…`. Plugin 3.1.0 ainda documenta o defeito. Issue upstream não envelhece por tempo. |

Nenhum dos sete é **NAO FAZ MAIS SENTIDO**. Nenhum foi grande demais para julgar.

---

## Medição

### `t-312ad8` — Design RuntimeOps depth (Codex, Claude, Grok)

A entrega é spec/plan/tasks executável **antes** de implementação. Não existe spec posterior à 369 com esse título ou escopo (`docs/specs/` não tem `runtimeops-depth` / `grok-observab`). A 369 está **shipped** e o próprio **Closure** ainda diz: *"Cost/history enrichment and Grok support remain follow-up slices"* (`docs/specs/369-runtimeops-observability-v2/spec.md:9`).

O item 1 do corpo ("inventory current Grok runtime/source capabilities first") continua sendo o passo real. O que nasceu depois — `packages/engine/src/runtimeOps/grokSessionReader.ts` — lê `config.toml` / presença de `auth.json` / hooks / MCP do harness. Isso é inspeção de sessão (o painel de Runtime Ops já faz o mesmo para Claude/Codex), não o inventário de fontes de quota/janela/plano/custo que o cartão pede.

`docs/runtimes/parity.md` (última verificação 2026-08-15, SDD 508) confirma o escopo vivo: Claude, Codex e Grok. A premissa dos três sobrevive. Dep `t-1a8ae3` (handoff F5 da 369) está `done`.

O desenho ainda não foi escrito. O cartão descreve exatamente isso.

### `t-4bd6a5` — Implement Grok observability

Depende de `t-312ad8` (ainda `triaged`) e das fatias Codex/Claude, ambas `done` (`t-71f42a`, `t-32cd68`).

A união de tipos já reserva Grok (`RuntimeObservabilityProviderV1 = "codex" | "claude" | "grok"`, `packages/engine/src/runtimeObservability/types.ts:3`). O validador aceita o literal (`validate.ts:32`). **Ninguém coleta.**

- Serviço: `const PROVIDERS = ["codex", "claude"]` (`service.ts:26`).
- Preferências: a mesma lista (`preferences.ts:10`).
- Projeção RuntimeOps: `RuntimeOpsProviderV2 = "codex" | "claude"` (`runtimeOps/types.ts:152`); `PROVIDERS` idêntico em `providerProjection.ts:15`.
- Fontes de quota no diretório: `codexAppServerSource.ts` e `claudeStatusLineSource.ts`. Não há `grok*Source` de quota.

`snapshotService.ts:282–285` ainda só registra que grok/opencode não carimbam `runtimeVersion` e cai no `model`. Sem fixture de sucesso/auth/timeout/drift/degradação para Grok. Sem o desenho de `t-312ad8`, implementar agora seria adivinhar a ordem das fontes. O cartão de implementação sobrevive atrás do de desenho.

### `t-a9789e` — Plugin ADR

Lock do primário (`/home/goat/tachyon/.tachyon/plugins.lock.json`): quinze plugins — `agent-browser`, `audio`, `dep-audit`, `diagram`, `hyperframes`, `image`, `product-foundation`, `sdd`, `secrets-guard`, `sound`, `terrarium`, `transcribe`, `verify-gate`, `video`, `visual-qa`. Nenhum `adr`. O diretório instalado confirma a mesma lista.

Não existe `docs/decisions/` neste repositório. Os ADRs que o repo tem (`docs/architecture/token-economy-boundary.md`, spike CodexBar) são documentos do próprio Tachyon, não o plugin independente que o cartão pede.

`t-54cdb2` entregou dest de install (`packages/engine/src/plugins/installScope.ts:1–12`: `{type:"workspace"|"agent"}`). Isso é *onde o engine escreve o plugin*. Não é convenção `docs/decisions/`, não é ID atômico, não é proposed/accepted/superseded. Nenhuma decisão do ADR foi tomada de fato no código. A fronteira que o cartão impõe (Tachyon funciona sem o plugin; SDD e ADR não se conhecem) continua verdadeira por vacuidade.

### `t-4590b2` — Inspetor do canal A2A

Ainda é backlog para discussão humana: as 9 perguntas não foram respondidas e não há SDD de inspetor.

O que **envelheceu** é o contexto. Em 2026-08-02 o journal dizia que `.tachyon/doorbells.jsonl` gravava `notify_agent` sem summary/pointer/resultado e que nada era consultável. Isso deixou de ser verdade:

- Spec 493 **shipped** (`docs/specs/493-doorbell-read-inbox/spec.md`). `DoorbellEvent` carrega `summary` e `pointer` (`packages/engine/src/workspace/doorbell.ts:17–21`). `read_notices` lê o log, self-only, cursor `since`.
- `t-167b5c` (a caixa de entrada que o journal antigo apontava como critério 9) está `done`.
- `docs/research/t-a5b186-one-tui-delivery.md` já mapeia estados de entrega (`notified` / `queued` / `held-human-draft` / `submit-unconfirmed` / `refused-not-ready`) e o residual (agente que não chama `read_notices`).

O que **ainda não existe**: visão unificada de origem+destino+conteúdo+estado de entrega+retries+sequência. Nenhum webview A2A — o `inspector` do produto é o inspetor de sessão tmux (`TmuxPanel.ts`), outra superfície. Host-pokes e relays unbound continuam de fora do log (non-goal da 493). Entrega em pane segue best-effort.

O cartão ainda escreve como se o canal não deixasse rastro. A discussão humana agora começa da 493 + `t-a5b186`, e o critério 9 (não construir se logs/receipts resolvem) ficou concreto em vez de hipotético. Envelheceu o enquadramento, não as 9 perguntas.

### `t-a48431` — Agent Heartbeat (caso especial: deps)

As três dependências **existem e estão `done`**, não mortas:

| dep | título curto | status |
|---|---|---|
| `t-357879` | fallback de completion / vínculo autoritativo + exact-once | `done` (`e61b3e96` em main) |
| `t-04052d` | corte etapa 2: `lifetime`, sem `declared` | `done` (`f36c48f4` em main) |
| `t-4071e4` | proposta de Saved Agent com worktree isolada | `done` (`e51bfa1e` em main) |

O HOLD humano de 2026-07-29 pedia ainda o corte integral do legado e a release com Saved Agents + worktrees. `t-7e5843` (plano do corte) e as etapas 3–4 (`t-eb4b30`, `t-7ff13d`) também estão `done`. Isso **desbloqueia mecanicamente**; não implementa o Heartbeat.

O contrato V1 ratificado não entrou:

- Grep por `heartbeat.enabled` / `subscriptions` / `safetyIntervalMinutes` / `whileBusy` em schema e código = zero.
- `packages/engine/src/config/agentProfileSchema.ts` não tem campo `heartbeat`.
- Não há SDD de heartbeat em `docs/specs/` (as ocorrências de "heartbeat" são o tick de 3 s do workspace, tmux, companion — outro mecanismo).

O que o journal de 2026-07-29 mediu e ainda vale: estender `taskNotificationPolicy` em vez de segundo catálogo; `dedupeWindowMs` é anti-spam de toast, não exact-once. O corpo V1 continua sendo o contrato. O que envelheceu é só o sequenciamento ("depende de t-357879" / HOLD) — isso é nota, não reescrita do problema.

Não é "dep morta". É cartão vivo cujo bloqueio mecânico já saiu.

### `t-f27be7` — Plugin de voz (Wispr Flow)

Investigação de fornecedor + proposta. "Não implementar nesta task." Nada disso foi escrito.

Lock do primário: sem `wispr`, sem `voice`, sem plugin de dicção. `transcribe` 0.2.0 (`github:cfpperche/tachyon-plugins@v2.3.1#path=transcribe`) é STT **de arquivo** via whisper.cpp e o SKILL recusa explicitamente live/streaming (`transcribe/skills/transcribe/SKILL.md:3`, `:47`). `audio` 0.2.0 é TTS (Piper/Kokoro), o inverso. O core não depende de nenhum fornecedor de voz — o contrato de independência nasce satisfeito.

O precedente de binário provisionado + `launchPolicy` (agent-browser) e o de captura local (transcribe) continuam sendo o modelo. Não cobrem iniciar/parar captura, destino no composer, revisão antes de enviar, nem Wispr. A pergunta (integrar direto / abstrair multi-provider / só documentar convivência) não foi respondida.

### `t-54c51a` — Issue upstream `confirmActions`

Issue upstream não envelhece por tempo. A regra desta varredura: se a versão do binário não mudou, o cartão vale.

Medido hoje no lock do primário e no binário instalado:

- Plugin wrapper: `3.1.0` (era `3.0.0` na varredura de 2026-08-02 — só o envelope Tachyon).
- CLI pinado: **`0.31.0`**, `linux-x64-glibc`, sha256 `71dbe415ab3ded286c71eca67933575eb9f451be9155283a2e3a1ab878d75eff` — o mesmo do corpo.
- `agent-browser --version` no path do lock: `agent-browser 0.31.0`.
- Manifesto 3.1.0 ainda descreve o defeito no `description`: *"Measured on the pinned CLI 0.31.0, confirmActions is accepted and then ignored on the CLI surface"* (`/home/goat/tachyon/.tachyon/plugins/agent-browser/tachyon-plugin.json:4`).
- `denyArgs` ainda inclui `--confirm-actions`; `scrubEnv` ainda inclui `AGENT_BROWSER_CONFIRM_ACTIONS`.

`t-7d67a0` (retirar a promessa do plugin) está `done`. Este cartão é a ação que sobrou: abrir o issue na conta do usuário. Busca no tracker upstream (`vercel-labs/agent-browser`) não encontrou issue que relate o CLI aceitar `confirmActions` e ignorar; a documentação de lá ainda anuncia a flag. Sem mudança de versão, o relato medido do corpo continua o texto a colar.

---

## O que isto não é

Não é triagem. O dono decide se reescreve, despacha ou larga. Nenhum cartão foi editado, nenhum status mudou, nenhum cartão novo foi aberto.
