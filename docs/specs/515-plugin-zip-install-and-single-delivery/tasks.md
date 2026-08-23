# 515 — plugin-zip-install-and-single-delivery — tasks

_Gerado de `plan.md` em 2026-08-23. De cima para baixo. Se uma tarefa revelar que o plano está errado,
corrija `plan.md` antes de seguir._

**Verify:** `npm run typecheck && npm test`

**Dogfood:** `npx vite-node scripts/dogfood/plugin-zip-install.ts`

**Dogfood:** `npx vite-node scripts/dogfood/plugin-single-delivery.ts`

## Visual QA

Evidence: `.tachyon/visual-qa/515-plugin-zip-picker/` (gerado por `test/browser/pluginZipPickerShots.test.ts`)
Verdict: as duas telas do picker aprovadas em 880 e 360, depois de consertar a trilha duplicada e a
ordem bidi dos caminhos — ambos defeitos do 514 que só o screenshot revelou.

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

- [x] **T9 (R1, PRIMEIRO)** — `restoreWorkspaceSkillDest` passa a DERIVAR o dest do payload que a
  concessão nomeia, em vez de consultar o lockfile (que a fatia 2 esvazia). Provar com um agente codex
  cuja concessão é entregue sem nenhum registro de `skill-dir` existindo. Se falhar, a fatia para.
- [x] **T10** — `previewInstall`/`applyInstall` deixam de planejar e escrever `skill-dir` de
  workspace. MCP, hooks, git hooks, tools e data seguem intactos.
- [x] **T11** — o lockfile deixa de receber `skill-dir` no install. O schema não muda: `skill-dir`
  continua válido porque a exportação (fatia 3) o escreve.
- [x] **T12** — desinstalar continua removendo o que o lockfile registra, inclusive `skill-dir` de
  uma instalação anterior (R3): a assimetria durante a transição é comportamento correto, não bug.
- [x] **T13** — testes: instalar não cria diretório em `.claude`/`.agents`/`.grok`; a concessão
  continua entregando; desinstalar remove entrada mesclada de MCP e hook exatamente como antes.

## Fatia 3 — a porta explícita de exportação

**Ela já existia.** O `applyContribution({kind:"skill"})` do spec 486 — o botão `Apply` no card, ao
lado de `installed · not applied` — é a porta que esta fatia ia construir. Só tinha o mesmo defeito do
T9: resolvia os destinos lendo o lockfile. Por isso as fatias 2 e 3 landaram juntas: entre uma e outra,
`Apply` responderia "plugin não tem skill chamada X" para uma skill listada no próprio card.

- [x] **T14** — exportar DERIVA os destinos (`lock.runtimes` × diretório de skills de cada runtime) em
  vez de lê-los, materializa, e registra `skill-dir` no lockfile. Registro existente ganha quando há —
  uma instalação com escopo de agente escreve no harness daquele agente, que nenhum layout deriva.
- [x] **T15** — desfazer remove o que a exportação registrou E apaga o registro; o payload fica.
- [x] **T16** — a ação no card já existia (`Apply` / `Unapply`, com o estado `installed · not applied`).
- [x] **T17** — testes: `test/unit/pluginSingleDelivery.test.ts` (8 casos) cobre exportar nos runtimes
  consentidos, desfazer, colisão com o diretório do humano, re-exportar sobre a nossa própria
  exportação, e as duas regressões de reinstalação. A independência entre exportar e conceder está no
  dogfood: a entrega ao codex acontece com o lockfile declarando zero `skill-dir`.

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
