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
| Perfil de isolamento | `private-home` via harness XDG por-agente (t-e2ebe3, merged 2026-07-08): XDG_CONFIG/DATA/STATE_HOME redirecionados pra `.tachyon/harness/<agent>/`, auth.json semeado (cópia mode 600, falha dura se a fonte faltar), independente de cwd — **restrição gated-only REMOVIDA** | `src/runtime/runtimeProfile.ts` + `src/harness/HarnessManager.ts` |
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

## Isolation tiers (t-ef19a1)

`private-home` acima descreve o mecanismo, não uma garantia incondicional — ela só se aplica quando o
agente é efetivamente materializado num home isolado:

- **Delegado/harnessed** (ad-hoc via Bridge, `worktree: true`, ou `harness: {}` declarado em
  `tachyon.yml`) → isolado: XDG_CONFIG/DATA/STATE_HOME redirecionados pra
  `.tachyon/harness/<agent>/` (t-e2ebe3). Auth semeado, config/sessão privados por agente.
- **Declarado simples** (`agents.<nome>.cmd: opencode` sem `harness:` e sem `worktree: true`) →
  **NÃO isolado por padrão**: compartilha o `~/.local/share`/`~/.config`/`~/.local/state` globais
  (config/auth/sessões) com todo outro agente opencode não isolado na máquina. Isso é **intencional**
  (RULING t-ef19a1): quem declara em `tachyon.yml` já tem confiança total da extensão — um tier
  diferente do spawn ad-hoc delegado — então NÃO é tratado como gap de segurança nem bloqueado.
  Tachyon emite um aviso de uma linha via `host.notify(..., "warn")` no momento do spawn apontando
  `harness: {}` como o opt-in de isolamento; a decisão de allow/refuse não muda.

## Limitações conhecidas / follow-ups

- ~~Ungated via Bridge exige `worktree: true`~~ RESOLVIDO (t-e2ebe3): o harness XDG dá isolamento
  cwd-independente; spawn ungated/shared-cwd passa. CAVEATS medidos: auth é CÓPIA (diverge do home
  real até respawn — token refrescado no real fica stale na cópia; erro de auth visível, não
  silencioso); reuso de worktree existente por cwd segue PODADO (owner-vs-occupant) — design de
  ocupância em t-815796.
- Reviews do landing: `.tachyon/reviews/f81cd7f.md` (1 CRITICAL: materializeHomeOnly sem os 3 XDG
  vars no caminho ad-hoc comum — fechado em 2ec9f65, delta CLEAN) — leitura obrigatória pra quem
  mexer no HarnessManager. Follow-ups: t-a08d3d (teste H4 spawn-level), t-0b2f30 (Activity).
- Composer profile (promptLine da TUI) segue não-medido no runtimeProfile (opcional; attention capta
  por patterns).
- Affordance de aprovação humana para dialogs/escalações: t-7d8bdf.
