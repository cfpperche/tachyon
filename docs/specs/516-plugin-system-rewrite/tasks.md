# 516 — plugin-system-rewrite — tasks

**Verify:** `npm run typecheck && npm test`

**Dogfood:** `npx vite-node scripts/dogfood/plugin-system-v2.ts`

**Dogfood:** `npx vite-node scripts/dogfood/runtime-drift.ts`

## Fatia 0 — medir antes de prometer

- [x] **T1 (R1, PRIMEIRO)** — medir se o claude descobre `<cwd>/.claude/skills` com
  `CLAUDE_CONFIG_DIR` apontando para uma home privada. O resultado decide se a lei do isolamento vale
  para os quatro runtimes ou para três; escrever a medição na `spec.md`, não só no código.
- [x] **T2** — medir o que o pi faz com um recurso de cada família vindo de um diretório qualquer:
  nomes aceitos, forma exigida do diretório, o que acontece quando o caminho não existe.

## Fatia 1 — o manifesto e o catálogo

- [x] **T3** — `plugins2/manifest.ts`: seis campos, e a leitura do payload por convenção. Recusa pelo
  nome um campo do formato antigo (`tools`, `data`, `blocks`, `externalTools`, `dependencies`),
  dizendo o que fazer.
- [x] **T4** — erro do autor: payload com `extensions/` e `runtimes` que não inclui pi é recusado.
- [x] **T5** — `plugins2/catalog.ts`: ler `.tachyon/plugins/` como catálogo. Sem lockfile.
- [x] **T6** — testes do manifesto e do catálogo, incluindo um payload de cada família.

## Fatia 2 — instalar e remover

- [x] **T7** — `plugins2/install.ts`: zip → `.tachyon/plugins/<nome>/`, reusando
  `extractZipContained`. Reinstalar substitui. Remover é apagar a pasta.
- [x] **T8** — a aba Plugins passa a falar com o sistema novo: listar, instalar por zip, remover,
  docs. O caminho de git e o de atualização somem da tela.
- [x] **T9** — testes: instalar não cria `.claude`/`.agents`/`.grok`; remover não deixa resíduo;
  instalar duas vezes é idempotente.

## Fatia 3 — entregar, com o mecanismo de cada runtime

- [x] **T10** — `plugins2/deliver.ts`: dado um plugin e uma concessão, o que materializar e onde,
  por runtime. Pi por caminho explícito; codex materializa e suprime; grok home privada + `compat`
  fechado; claude conforme o T1 disser.
- [x] **T11** — o primeiro plugin no formato novo: `sdd`, escrito à mão, com `skills/` e `prompts/`
  (para exercitar o pi). Não sai do `tachyon-plugins`, que fica intocado.
- [x] **T12** — conceder o `sdd` a um agente de cada runtime e verificar que chega inteiro e que o
  digest confere. **Medido nos agentes vivos do autor em 2026-08-24**, nos três que existem no
  workspace: claude → `.tachyon/harness/claude/skills/sdd/`, codex →
  `.tachyon/harness/codex/skills/sdd/`, grok → `bridge-mcp/grok.grok/skills/sdd/`. Os três idênticos
  ao payload (`diff -rq` limpo) e o checkout intocado. Falta o pi, que não tem agente aqui.
- [x] **T13** — a prova do segundo sentido: uma skill escrita à mão em
  `<workspace>/.agents/skills/intrusa` não chega a um codex que não a recebeu. **Medido**, e no
  caminho achou um defeito: a supressão inteira vivia dentro de um `if (capabilities)`, então um
  agente sem concessão nenhuma não ganhava supressão e enxergava tudo — quem foi concedido de MENOS
  ficava isolado de MENOS (corrigido na 0.93.61). A supressão é por CAMINHO DESCOBERTO no launch, não
  por nome conhecido: provado rodando o caso com nomes que não existem no produto.

## Fatia 4 — apagar o antigo

- [x] **T14** — remover `apps/vscode-extension/src/plugins/*` (inclusive `gitHookRegistry.ts`, o
  dispatcher gerado e o ownership de `core.hooksPath`) e
  `packages/engine/src/plugins/{manifest,lockfile}.ts`. O sistema de git hooks futuro lê isso no
  histórico como referência, não como herança.
- [x] **T15** — `agentDest.ts` perde `WORKSPACE_DESTS` e o que só servia à escrita no workspace.
- [x] **T16** — `plugins2/` vira `plugins/`.
- [x] **T17** — contar as linhas antes e depois e escrever o número na `notes.md`. Se não caiu para
  perto de 3.000, entender por quê antes de fechar.

## Human dogfood

- [x] instalar o `sdd` novo por zip, conceder a um claude e a um codex, e usar de verdade numa spec
  — **fechado por si mesmo**: o `sdd` que escreveu esta spec roda em
  `.tachyon/harness/claude/skills/sdd/`, entregue pelo sistema novo e `diff -rq` limpo contra
  `.tachyon/plugins/sdd/skills/sdd/`. O `new.sh` que criou o diretório `516-` veio por esse cano.
- [x] conceder ao pi e ver `prompts/` chegar — **FECHADO em 2026-08-25**, e o caminho estava quebrado,
  não faltando agente: cinco defeitos na autorização (`t-16cb18`, corrigidos na 0.93.68). O runtime
  lista `[Prompts] /nova-spec` no próprio banner. Texto antigo abaixo, preservado — **provado nas duas camadas de baixo** (unit
  "SDD 428" e o dogfood, que diz `prompts/ chega ao pi e a mais ninguém`), **sem prova em agente pi
  vivo**: não existe agente pi neste workspace. O que falta virou `t-16cb18`, com o aviso de que o
  autorrelato do modelo não serve de instrumento ali.
