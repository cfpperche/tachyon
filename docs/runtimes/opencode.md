# OpenCode (GLM 5.2) como runtime Tachyon — relatório de capacidades

_t-6a5dae, medições de 2026-07-07/08 (opencode 1.17.15, modelo `opencode-go/glm-5.2`). Entregável 5
do método da task; fontes primárias nos journals de t-6a5dae e t-ce50a2 e nas reviews em
`.tachyon/reviews/`._

## Veredito

OpenCode é um **runtime de primeira classe** para delegação gated no Tachyon desde 0.55.64. Todas as
capacidades protocolo-críticas foram provadas ao vivo, ponta a ponta e sem bootstrap manual: brief no
spawn, Bridge MCP visível, doorbell com token próprio, entrega gated ACCEPT merged na main.

## Suporte construído (o mapa de paridade, tudo shipado)

| Peça | Mecanismo | Onde |
|---|---|---|
| Perfil de isolamento | `project-scoped`, medido/verificado; aceito pelo guard SÓ com worktree isolado (`TranscriptIsolationContext`) | `src/runtime/runtimeProfile.ts` |
| Entrega de brief | `--prompt <brief>` no `INSTRUCTION_ARG` (TUI pré-preenche o composer) | `src/config/loadConfig.ts` |
| Bridge MCP | `OPENCODE_CONFIG=<.tachyon/bridge-mcp/<agent>.opencode.json>` injetado no env (spawn/restart/resume/fork); header `Bearer {env:TACHYON_AGENT_BRIDGE_TOKEN}` resolvido pelo opencode em runtime — **zero segredo em disco**; fold-in aditivo do opencode.json do projeto com degradação graciosa em JSON malformado | harness/registration/AgentManager |
| Attention | patterns de erro empíricos (`APIError` statusCode JSON, unexpected server error) | `src/attention/patterns.ts` |
| Resume | adapter pré-existente com `-s <sessionID>` explícito | `src/resume/adapters.ts` |
| Label | `GLM 5.2` via aliases do profile | runtimeProfile |

## Fatos medidos do runtime

- **Isolamento**: sessões escopadas por project-root (git root); runs concorrentes no mesmo root
  ganham session ids distintos, zero contaminação. HAZARD documentado: `session list` vaza entre
  paths irmãos e dirs não-git dividem um balde — `run -c` é inseguro em árvore compartilhada; sempre
  `-s` explícito. Worktrees gated isolam naturalmente.
- **Autorrelato NÃO é fonte**: na entrevista o GLM errou/desconheceu o próprio harness (resume flag,
  context window, "não tenho prompts interativos" — a TUI TEM dialog de permissão para diretório
  externo ao project root). Fatos de runtime vêm de medição nossa + primer.
- **Latência**: one-shots de 30s a 3min+; "thinks" longos leem como idle momentâneo no monitor
  (flicker) — esperar confirmação dupla antes de tratar como terminado.
- **Captura**: a TUI reescreve o scrollback — `read_output` profundo/postmortem é limitado; extrair
  evidência determinística de arquivos/git, não do pane.
- **Permissões**: dialog "Access external directory" ao ler fora do project root (worktree lendo o
  repo fonte). Mitigação live: `write_input` Enter (`answering=true`). Melhoria futura: bloco
  `permission` na config gerada.

## Perfil de obediência (ledger 3-runtimes, detalhes em specs/363 notes)

Mecanicamente obediente primeiro-try (stub canônico sem rename — inédito; doorbell; full suite
espontânea; cita o PRECEDENCE do primer para raciocinar exceções). Acha o seam arquitetural certo
sozinho e **argumenta deviações de scope** em vez de desviar calado. Slips classe parâmetro-literal
(task id fora de commit msg — não recorreu após o before-finishing reforçado; exemplo literal
trocado). Um MEDIUM de robustez no primeiro contato com parse de arquivo user-editable. Custo
observado: US$0,05–0,30 em tasks pequenas; ~US$5 na task multi-módulo grande.

## Limitações conhecidas / follow-ups

- Ungated via Bridge exige `worktree: true` (spawn parenteado cria worktree real desde 0.55.63);
  reuso de worktree existente por cwd foi PODADO (owner-vs-occupant) — design de ocupância em
  t-815796.
- Composer profile (promptLine da TUI) segue não-medido no runtimeProfile (opcional; attention capta
  por patterns).
- Affordance de aprovação humana para dialogs/escalações: t-7d8bdf.
