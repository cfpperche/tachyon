# 515 — plugin-zip-install-and-single-delivery — tasks

_Gerado de `plan.md` em 2026-08-23. De cima para baixo. Se uma tarefa revelar que o plano está errado,
corrija `plan.md` antes de seguir._

**Verify:** `npm run typecheck && npm test`

**Dogfood:** `npx vite-node scripts/dogfood/plugin-zip-install.ts`

**Human dogfood:** aba Plugins → "From zip" → escolher um zip de plugin → a gaveta abre sem procedência → instalar.

## Fatia 1 — instalar por zip

- [x] **T1** — extrair o descompactador com contenção de `packages/engine/src/apps/index.ts`
  (`extractAppZip`, hoje privado) para um módulo comum, sem mudar comportamento. O comentário que diz
  que a contenção é higiene e não barreira vai junto: ele é a razão de a função existir assim.
- [x] **T2** — `apps/vscode-extension/src/plugins/zipSource.ts`: descompactar em temporário, chamar
  `loadPlugin(dir)`, devolver `LoadResult` **sem** `provenance`. Falha em qualquer ponto limpa o
  temporário e devolve erro nomeado.
- [x] **T3** — `loadPluginFromZip` exportado de `engine.ts`, ao lado de `loadPluginFromSource`, para
  que o painel tenha uma porta só por fonte.
- [x] **T4** — `PluginsPanel`: a mensagem de instalar por arquivo, o seletor (reusar o `PathPicker` da
  514, filtrado a `.zip`), e `previewInstallOp` aceitando o caminho de um zip.
- [x] **T5** — a gaveta de consentimento com procedência ausente: conferir que `buildInstallConsent`
  já desenha isso (o parâmetro é opcional) e que o texto não promete uma origem que não existe.
- [x] **T6** — botão na aba Plugins. Um zip é escolhido pelo mesmo gesto de um app.
- [x] **T7 (R2)** — um plugin sem `source` não é consultado por `resolveEffectiveUpdateSpec` nem
  rotulado "atualização disponível"; o card diz que veio de arquivo local.
- [x] **T8** — testes: instalar por zip materializa o payload; zip sem manifesto / manifesto recusado
  não deixa nada; reinstalar por cima substitui; `tools`/`gitHooks` num zip continuam exigindo aceite.

## Fatia 2 — uma entrega, não duas

- [ ] **T9 (R1, PRIMEIRO)** — `restoreWorkspaceSkillDest` passa a DERIVAR o dest do payload que a
  concessão nomeia, em vez de consultar o lockfile (que a fatia 2 esvazia). Provar com um agente codex
  cuja concessão é entregue sem nenhum registro de `skill-dir` existindo. Se falhar, a fatia para.
- [ ] **T10** — `previewInstall`/`applyInstall` deixam de planejar e escrever `skill-dir` de
  workspace. MCP, hooks, git hooks, tools e data seguem intactos.
- [ ] **T11** — o lockfile deixa de receber `skill-dir` no install. O schema não muda: `skill-dir`
  continua válido porque a exportação (fatia 3) o escreve.
- [ ] **T12** — desinstalar continua removendo o que o lockfile registra, inclusive `skill-dir` de
  uma instalação anterior (R3): a assimetria durante a transição é comportamento correto, não bug.
- [ ] **T13** — testes: instalar não cria diretório em `.claude`/`.agents`/`.grok`; a concessão
  continua entregando; desinstalar remove entrada mesclada de MCP e hook exatamente como antes.

## Fatia 3 — a porta explícita de exportação

- [ ] **T14** — operação de exportar: `planSkillTargets` com `WORKSPACE_DESTS`, materializa e registra
  no lockfile como `skill-dir`.
- [ ] **T15** — operação de desfazer: remove exatamente o que a exportação registrou.
- [ ] **T16** — ação no card do plugin, com o estado visível (exportado ou não).
- [ ] **T17** — testes: exportar cria os diretórios dos runtimes presentes; desfazer os remove;
  desinstalar um plugin exportado remove os dois; exportar nunca é pré-requisito para a concessão.

## Verification

- [ ] `npm run typecheck && npm test` verde no tree entregue
- [ ] instalar um zip de plugin real (empacotar o `sdd` do catálogo) materializa e o card aparece
- [ ] depois da fatia 2, `.claude/skills`, `.agents/skills` e `.grok/skills` não são criados por
      instalação nenhuma
- [ ] um agente codex com concessão recebe o skill sem que nada tenha sido exportado

## Visual QA

Superfície afetada: a aba Plugins (botão de instalar por arquivo, card com estado de exportação) e o
seletor de arquivo. Risco visual: o card de plugin já é denso; uma ação a mais pode empurrar o rodapé.

- [ ] Evidence:
- [ ] Verdict:
