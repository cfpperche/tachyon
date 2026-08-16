# Inbox sweep — bloco C (runtime config, memória e política)

**Task:** `t-affc0b`  
**Agente:** sweepC  
**Árvore medida:** `34a2887b` / `b4e7195e` (`tachyon/tmp.sweepC.20260816-233808-067b`, igual a `origin/main` no momento da medição)  
**Regra:** conferir, não consertar, não reescrever cartão, não mudar status.

Varredura de idade. Não é triagem — o dono decide. Método do bloco A (`t-1cacae`): cartão contra codebase, `git log -S` e tasks relacionadas. Três perguntas: o caminho ainda existe? o problema ainda acontece? alguma entrega posterior já resolveu, no todo ou em parte?

## Premissa que atravessa o bloco

O dono cortou o escopo para **claude, codex e grok**. SDD 508 (`PARITY_RUNTIMES`) e `t-c2209d`: *"Claude, Codex e Grok. Só esses três."* OpenCode, Pi e Hermes saíram do trabalho novo.

Isso não mata um cartão só porque cita um dos três. Mata quando, depois de tirar os não-suportados, **não sobra trabalho**. Nove dos catorze são sobre Pi, Hermes ou OpenCode.

O produto ainda *opera* esses runtimes (`SUPPORTED_AGENT_RUNTIMES` inclui pi/opencode/hermes; `ATTESTED_RUNTIMES` ainda inclui `pi`). A decisão medida aqui é de **escopo de trabalho**, não de remoção de código.

## Tabela

| id | veredito | motivo |
|---|---|---|
| t-94ec10 | PRECISA REESCREVER | Switch de conta nomeada não existe; GLM saiu; Grok é first-class e falta no cartão; detecção de rate-limit (`t-71ec3b`) já landou. |
| t-1d9d15 | PRECISA REESCREVER | Troca de adapter no mesmo nome ainda é recusada; `continue_task` e `t-c777ac` cobrem outro gesto. Arquitetura de julho envelheceu. |
| t-a1da29 | NAO FAZ MAIS SENTIDO | Só existia para Pi. Os três já são concorrentes por home privado. |
| t-88a720 | NAO FAZ MAIS SENTIDO | Só existia para OpenCode. Os três já projetam por família, não por `inherit: workspace\|none`. |
| t-a8d7ef | NAO FAZ MAIS SENTIDO | Só existia para mapear Pi na política comum. A política comum já cobre os três. |
| t-d715cc | NAO FAZ MAIS SENTIDO | Só existia para Hermes (`inherit: none` ainda semeia o global). Sem resto nos três. |
| t-383473 | NAO FAZ MAIS SENTIDO | Adapter de Runtime Config para Pi. O seletor só lista claude/codex/grok. |
| t-53ba72 | NAO FAZ MAIS SENTIDO | Adapter de Runtime Config para Hermes. Idem. |
| t-b26437 | NAO FAZ MAIS SENTIDO | Adapter de Runtime Config para OpenCode. Idem. |
| t-91df30 | NAO FAZ MAIS SENTIDO | Fatias dos três suportados já entregues (`t-e5cb7c`, `t-ce83a2`). O que resta do épico só existia para runtime fora de escopo. |
| t-8c7431 | PRECISA REESCREVER | Registry + adapters dos três existem; o verificador foi apagado de propósito (`t-74b75a`). Sobra a UX (`t-c3dccf`) e eixos ainda `declared`. |
| t-b4a557 | NAO FAZ MAIS SENTIDO | Declaração digest-bound de plugin para OpenCode/Pi. Os três têm memória nativa; a regra fail-closed já está em `resolveMemoryPolicy`. |
| t-b5d28c | NAO FAZ MAIS SENTIDO | Só existia para isolar o store built-in do Hermes. |
| t-c3dccf | PRECISA REESCREVER | Superfície ainda não existe, e isso ainda é trabalho nos três. O default canônico `disabled` já é projetado no harness; deps Hermes/OpenCode/Pi envelheceram. |

**Contagem:** 0 vale como está · 4 precisa reescrever · 10 não faz mais sentido.

---

## Medição por cartão

### t-94ec10 — Multi-account switch per runtime

**Veredito: PRECISA REESCREVER.** Depois de tirar GLM, ainda é trabalho nos três.

- `accountProfile` / `codex:work`: `git log -S` vazio; grep em `src/` zero. A varredura de 2026-08-02 (`t-29c627`) continua verdadeira.
- O seam que o cartão nomeia existe: homes privados `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `GROK_HOME` (specs 357/358, `HarnessManager`). Isolamento por *agente*, não por *conta nomeada*.
- GLM não é runtime first-class (`PARITY_RUNTIMES` = claude/codex/grok). Grok é, e o cartão não o lista.
- A fronteira "sem rotação automática por rate-limit" segue de pé. `t-71ec3b` (deteção) está `done`; `t-c777ac` também recusa escolha automática de runtime. O switch *manual* declarado no spawn/perfil não foi construído.
- O que envelheceu: GLM como exemplo; ausência do Grok; `t-71ec3b` deixou de ser dependência futura.

### t-1d9d15 — Agent Runtime Rebinding

**Veredito: PRECISA REESCREVER.** Depois de tirar OpenCode, ainda é trabalho — mas não o desenho de 20 itens de julho.

Medido nesta árvore:

```671:673:packages/engine/src/config/agentProfileLifecycle.ts
  if (target.runtime.adapter !== current.runtime.adapter) {
    throw new Error("runtime adapter changes require an explicit authority migration");
  }
```

O produto recusa a troca de adapter no mesmo perfil e nomeia a porta que não existe. `continue_task` (`packages/bridge/src/tools/tasks-continue.ts`) é outro gesto: agente *diferente*, não para a origem, não muda `cmd`, injeta brief. A dimensão tipada `cross-runtime-task-continuation` mede exatamente essa metade.

Parente vivo `t-c777ac` (triaged P2, 2026-08-16): fallback quando o primário trava, *sem* matar a sessão, com aprovação humana. Notas de hoje: passo 1 (deteção) já existe ponta a ponta; passos 2–6 precisam de decisão; o estudo `t-2791f3` nomeou o buraco do passo 5 — o bastão do Tachyon é por *nome de agente*, o do ai-memory é do *projeto*.

O que envelheceu: a tese lista OpenCode como runtime; a Phase 3 (failover por rate-limit) é o `t-c777ac`; `continue_task` e a dimensão 508 não existiam em 9 de julho. Reescrever contra a porta já nomeada ("explicit authority migration") e contra o que `t-c777ac` já recortou, não contra os 20 componentes.

### t-a1da29 — Remover trava de Pi único

**Veredito: NAO FAZ MAIS SENTIDO.** Só existia para Pi.

A trava ainda está instalada (`AgentManager.ts:4154`, `agent-studio-shell/domain.ts:455`, SDD 408). Claude/codex/grok já correm em paralelo via home privado. Nada sobra para os três. Cartão gated por upstream de um runtime fora de escopo.

### t-88a720 — OpenCode: substituir inherit workspace|none

**Veredito: NAO FAZ MAIS SENTIDO.** Só existia para OpenCode.

`parity.md:538` ainda descreve OpenCode como `inherit: workspace` / `none`. A política por família (`AGENT_NATIVE_CONFIG_FAMILIES`) e a projeção (`projectAgentNativeConfig`) só admitem `codex` / `claude` / `grok` (`agentNativeConfigPolicy.ts:309`). O `inherit: none|workspace` que resta nos três é a camada de harness MCP (spec 226), outro contrato, já em produção. Sem resto.

### t-a8d7ef — Pi: seed, snapshots e estado

**Veredito: NAO FAZ MAIS SENTIDO.** Só existia para mapear Pi.

A política comum que o cartão pede já é a dos três (famílias + Studio mostrando source/treatment/refresh). Pi continua com seed/snapshot próprios (`parity.md:540`, `~`) e sem entrada em `projectAgentNativeConfig`. Mapear Pi não é trabalho dos três.

### t-d715cc — Hermes: herança nativa explícita

**Veredito: NAO FAZ MAIS SENTIDO.** Só existia para Hermes.

`parity.md:541`: `inherit: none` ainda preserva o `config.yaml` global; sem inspector canônico nem política por família. Esse é o defeito do cartão, e é só do Hermes. Os três já tornam a herança explícita por família.

### t-383473 / t-53ba72 / t-b26437 — Runtime Config para Pi / Hermes / OpenCode

**Veredito: NAO FAZ MAIS SENTIDO** nos três. Só existiam para o runtime do título.

O seletor de Control monta exatamente três inventários (`extension.ts:2032–2038`: Codex, Claude, Grok). `apps/vscode-extension/src/runtimeConfig/` tem `claudeInventory.ts`, `codexInventory.ts`, `grokInventory.ts` — nenhum `pi`/`hermes`/`opencode`. `git log -S` desses nomes: vazio. `parity.md` §3.1.2: *"Not eligible yet: OpenCode, Pi, Hermes"*. Depois de tirá-los, não sobra adapter para construir.

### t-91df30 — Umbrella Runtime Config

**Veredito: NAO FAZ MAIS SENTIDO.** O que sobra depois de tirar os não-suportados já foi entregue.

Ordem do épico: Claude → Grok → OpenCode → Pi → Hermes. Claude (`t-e5cb7c`, SDD 464) e Grok (`t-ce83a2`, SDD 481) estão `done`; Codex era o ponto de partida. As três filhas restantes são os três cartões acima. O épico como trabalho restante só rastrea runtime fora de escopo.

### t-8c7431 — Runtime memory: controle verificável multi-runtime

**Veredito: PRECISA REESCREVER.** Depois de tirar Hermes/OpenCode/Pi, ainda há trabalho — não o que o corpo pede.

Já entregue (filhas `done`):

- Registry tipado + `resolveMemoryPolicy` fail-closed: `packages/engine/src/runtime/nativeMemory.ts` (`t-56daa1`).
- Claude: disable/enable/isolation `verified` em 2.1.220 (`t-f22211`, `t-560797`).
- Codex: disable `verified` em 0.146.0 (`t-c46aad`); helpers em `test/helpers/codexMemory.ts`.
- Grok: disable `verified` via `GROK_MEMORY=0`; `--no-memory` refutado (`t-c46c35`, `t-0e88f3`, `adapters/grokMemory.ts`).

O que o corpo ainda pede e **não** é trabalho:

- "verificador comportamental isolado" — `nativeMemoryVerifier.ts` foi apagado em `a595b3a6` (`t-74b75a`, done). As fases que precisavam do protocolo já rodaram à mão e transcreveram. Recriar a máquina não tem dono de fase.
- Adapter Hermes (`t-b5d28c`) e contrato de plugin OpenCode/Pi (`t-b4a557`) — fora de escopo.

O que sobra nos três: a UX (`t-c3dccf`); eixos ainda `declared` (injection/mutation nos três; enable no Codex); `resolveMemoryPolicy` **não** está ligado à readiness canônica (comentário deliberado em `nativeMemory.ts:22–27`).

### t-b4a557 — OpenCode/Pi extension memory

**Veredito: NAO FAZ MAIS SENTIDO.** Só existia porque o core de OpenCode/Pi não tem memória e um plugin pode inventar.

Registry: `opencode` e `pi` têm `mechanism: "none"` + `extensionBoundary`. A regra 4 de `resolveMemoryPolicy` já bloqueia `runtime-managed` quando essa fronteira existe. Claude/codex/grok têm memória *nativa* (dimensão 15 `~`) e **não** declaram `extensionBoundary`. Um contrato digest-bound para plugins dos três seria outro cartão.

### t-b5d28c — Hermes canonical memory

**Veredito: NAO FAZ MAIS SENTIDO.** Só existia para Hermes.

Não há `hermesMemory.ts`. A entrada `hermes` do registry está toda `declared`, default `enabled`, com provider externo. Isolar MEMORY.md/USER.md do Hermes não se recorta para os três: Claude já tem isolation `verified`; Grok já tem pin canônico e isolamento de home.

### t-c3dccf — UX de memória nativa

**Veredito: PRECISA REESCREVER.** A superfície ainda é trabalho nos três; o texto envelheceu em duas frentes.

Ainda falta, medido:

- Agent Studio omite `memoryPolicy` da contagem e não mostra mecanismo/evidência (`agent-studio-shell/App.tsx:765`).
- Runtime Config não menciona memória (`runtime-ops/`: zero hits).
- Sem enable/disable condicionado a eixo `verified`, sem Ready bloqueado por uncontrolled, sem purge com preview.

O que envelheceu:

- "Default canonical disabled" já é projetado no harness: Claude `autoMemoryEnabled: false` (`HarnessManager.ts:2831`); Grok `GROK_CANONICAL_MEMORY_POLICY` (`grokMemory.ts` + `AgentManager.ts:3186`). Isso não é a UX — mas o cartão ainda fala como se o default fosse o trabalho.
- Deps `t-b5d28c` / `t-b4a557` são os dois cartões acima. As fatias dos três (`t-f22211`, `t-c46aad`, `t-c46c35`) já estão `done`; a UX pode partir do registry que existe.

Não misturar com a lane human-approved continua válido.
