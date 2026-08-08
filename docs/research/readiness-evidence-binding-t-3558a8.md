# A que a evidência de prontidão está amarrada — t-3558a8

**Verified — Resposta 1:** GitHub/GitLab amarram o verde ao SHA/run; Tachyon indexa por Git tree — o reuso do gate também valida ambiente/idade, mas o land hoje não.
**Verified — Refutação:** não achei outro cache global de prontidão indexado só pelo tree OID, mas Gerrit já preserva `Verified` entre patch sets sem mudança de código; portanto o diferencial comportamental “só Tachyon não perde verde por rewrite” é falso.
**Verified — Resposta 2:** sim, Gerrit (e historicamente Phabricator) oferece uma caixa de mudanças prontas fora da metáfora de PR/GitHub, mas ainda é um servidor de revisão.
**Verified — Limite:** não achei produto que una, sem servidor/forge, inbox humano + prova de gate + `primary-on-trunk` + `primary-clean` + land local; GitButler landa sem forge, mas declara que pula CI e review.

## 1. Método e vocabulário de evidência

**Verified —** Pesquisa realizada em 2026-08-08. `Verified` abaixo significa documentação primária do fornecedor ou código deste repositório. `Marketing/secundário` identifica afirmação do fornecedor sem contrato técnico suficiente ou fonte não primária. `Não verificado` significa que não achei prova suficiente; não é uma conclusão negativa.

**Verified —** “Amarrada” responde qual identidade precisa continuar igual para um verde existente satisfazer prontidão: Git commit SHA, pipeline/run, patch set/change ou Git tree (snapshot). “Sobrevive” significa que a evidência anterior continua válida para a nova identidade, não apenas que a ferramenta pode executar outro job rapidamente.

**Verified —** Um rebase só preserva o tree do tip quando o snapshot resultante é idêntico. O rebase comum sobre um trunk que ganhou arquivos ou conteúdo produz outro tree, mesmo sem conflito; nesses casos nem o Tachyon deve reutilizar o verde. “Sobrevive a rebase” abaixo é, portanto, condicional ao tipo de mudança, não uma promessa genérica.

## 2. Tabela de amarração

| Produto / sinal de “pronto” | Evidência amarrada a | Rebase | Amend só da mensagem | Squash | Mesma árvore em outro commit | Grau / fonte |
|---|---|---|---|---|---|---|
| **Tachyon `verify:full` + land** | Registro indexado pelo Git **tree OID**; `verify:full` só o reutiliza com fingerprint/idade válidos, mas o land reader hoje aceita qualquer schema 1/2 correspondente ao tree; o comando fixa um commit SHA | **Sim apenas se** o tree final continuar idêntico; rebase que incorpora novo conteúdo dá outro tree e perde o verde | **Sim** | **Sim apenas se** o snapshot final tiver exatamente o mesmo tree | **Sim**, dentro do mesmo clone/shared git dir; no reuso do gate, sujeito a fingerprint/idade | **Verified** — [`verify-record.mjs`](../../scripts/verify-record.mjs), [`verifyRecordReader.ts`](../../src/workspace/verifyRecordReader.ts), [`land.ts`](../../src/worktree/land.ts) |
| **GitHub commit status** | Status criado/consultado para um **commit/ref**, resolvido a SHA; branch é só ponteiro de consulta | **Não**: novo SHA | **Não**: novo SHA | **Não**: o commit squash criado no trunk é outro SHA; o verde do head autorizou a operação, não foi reanexado ao squash | **Não** | **Verified** — [Commit statuses API](https://docs.github.com/en/rest/commits/statuses) |
| **GitHub check run / required check** | Check run tem `head_sha`; required checks devem passar no **latest commit SHA** | **Não**; strict mode ainda exige atualizar e reconstruir contra a base | **Não** | **Não como evidência no commit resultante**; GitHub permite land após o check do head e cria outro commit conforme a estratégia | **Não** | **Verified** — [Check runs API](https://docs.github.com/en/rest/checks/runs), [required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks), [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) |
| **GitLab pipeline / commit status** | Objeto pipeline/run com `sha`; status externo é aplicado a um commit SHA | **Não**: rebase/push cria novo commit e pode disparar novo pipeline | **Não** | **Não** para o novo SHA; merged-result/merge-train usa seu próprio ref/SHA efêmero | **Não** | **Verified** — [Pipelines API](https://docs.gitlab.com/api/pipelines/), [Commits API](https://docs.gitlab.com/api/commits/), [MR pipelines](https://docs.gitlab.com/ci/pipelines/merge_request_pipelines/) |
| **Gerrit `Verified` / submit requirements** | Voto pertence a patch set, mas `copyCondition` pode copiá-lo ao patch set seguinte conforme **change kind**; a mudança mantém `Change-Id` | **Configurável: sim** para `TRIVIAL_REBASE` ou `TRIVIAL_REBASE_WITH_MESSAGE_UPDATE`; não para rework salvo política mais permissiva | **Sim por padrão** para o label `Verified` opcional via `NO_CODE_CHANGE` | **Não verificado** como equivalência geral; squash pode mudar a estrutura da mudança | **Sim dentro da mesma Change**, inclusive SHA diferente em `NO_CHANGE`; não achei reutilização global entre Changes independentes | **Verified** — [Review labels / sticky votes](https://gerrit-review.googlesource.com/Documentation/config-labels.html), [Changes](https://gerrit-review.googlesource.com/Documentation/concept-changes.html) |
| **Devin Review merge bar** | Reflete mergeability e required checks do **GitHub PR**; reviews do Devin podem postar commit status no PR | **Herda GitHub: não** para o verde anterior | **Herda GitHub: não** | **Herda GitHub: não** como evidência no squash | **Herda GitHub: não** | **Verified** — [Devin Review](https://docs.devin.ai/work-with-devin/devin-review); a herança de SHA é inferência direta do contrato GitHub acima, não um store próprio documentado |
| **Cursor PR review / cloud agent** | A tela mostra PR, checks e approvals do provedor; não achei documentação de uma evidência de CI própria, tree-keyed | **No caminho GitHub: não** | **No caminho GitHub: não** | **No caminho GitHub: não** como evidência no squash | **No caminho GitHub: não** | **Verified** para a tela — [Cursor PR review](https://cursor.com/changelog/05-07-26), [Cursor mobile review/inbox](https://cursor.com/changelog); **Não verificado** para um binding próprio do Cursor |
| **GitHub Copilot app / coding agent** | Mostra CI check results e só mergeia “assim que GitHub permite”: sinal subjacente do PR/GitHub | **Herda GitHub: não** | **Herda GitHub: não** | **Herda GitHub: não** como evidência no squash | **Herda GitHub: não** | **Verified** — [Managing PRs with the Copilot app](https://docs.github.com/en/copilot/how-tos/github-copilot-app/managing-issues-and-pull-requests) |
| **Graphite PR / stack merge** | Usa e espera **GitHub checks** em cada PR; após rebase volta à fase waiting-for-CI | **Não**; a própria documentação prevê checks adicionais após rebase | **Não** sob o binding GitHub | **Não** como evidência no commit squash | **Não** sob o binding GitHub | **Verified** — [Merge pull requests](https://graphite.com/docs/merge-pull-requests), [CI optimizations](https://graphite.com/docs/stacking-and-ci) |
| **Sapling ISL público** | Badge de commit mostra status do **GitHub PR** e CI; não achei store público próprio de prontidão | **Herda o provedor; no GitHub, não** | **No GitHub, não** | **No GitHub, não** como evidência no squash | **No GitHub, não** | **Verified** — [ISL](https://sapling-scm.com/docs/addons/isl/); **Não verificado** para a infraestrutura interna da Meta |
| **Jujutsu (`jj`)** | `change ID` sobrevive a rewrite; `commit ID` muda. Isso é identidade de mudança, **não evidência de CI/readiness** | A identidade de change sobrevive; não há verde nativo medido | Idem | Pode reescrever mudanças; não há verde nativo medido | Não há verde nativo medido | **Verified** — [Glossary](https://docs.jj-vcs.dev/latest/glossary/), [GitHub/GitLab workflow](https://docs.jj-vcs.dev/latest/github/) |

## 3. O que exatamente caiu na hipótese

**Verified — A hipótese estrita ainda sobrevive:** entre os produtos medidos, não achei outro que grave uma atestação de gate em arquivo/registro cujo lookup primário seja o Git tree OID e que a reutilize globalmente para qualquer commit com aquele tree. O Tachyon resolve `HEAD^{tree}`, arquiva `${tree}.json` no git common dir e ignora commit SHA/mensagem. Na decisão de **reusar a execução** do gate, também exige fingerprint de comando/Node/plataforma/arquitetura e idade máxima. Isso é mais preciso que dizer apenas “tree-keyed”.

**Verified — O land é hoje mais fraco que o reuso do gate:** `probeLandSuggestion()` chama `readVerificationRecord()`, que confere tree, schema e presença de timestamp, mas não compara fingerprint, não aplica a janela de sete dias e não rejeita timestamp futuro. Assim, um registro que `verify:full` recusaria reutilizar ainda pode deixar `verified-tree` verde e armar o comando humano. O defeito foi registrado em `t-40e655`; evidência: [`land.ts`](../../src/worktree/land.ts), [`verifyRecordReader.ts`](../../src/workspace/verifyRecordReader.ts) e [`reuseDecision()`](../../scripts/verify-record.mjs).

**Verified — O diferencial comportamental não sobrevive:** Gerrit documenta `copyCondition` para copiar aprovações ao novo patch set. O `Verified` opcional usa `NO_CODE_CHANGE` por padrão, preservando-o quando só a mensagem muda; administradores podem usar `TRIVIAL_REBASE` ou `TRIVIAL_REBASE_WITH_MESSAGE_UPDATE` para rebases sem rework. Portanto, o efeito de não pedir novamente a prova após certos rewrites sem mudança relevante já existe no mercado.

**Verified — Gerrit não é equivalente exato ao Tachyon:** sua decisão compara patch sets consecutivos dentro da mesma `Change-Id` e aplica uma política por label/change kind. Não achei prova de que um `Verified` de Change A seja descoberto por tree OID e reutilizado numa Change B independente com o mesmo snapshot. O Tachyon, ao contrário, faz lookup por tree no shared git dir do clone, sem consultar linhagem ou identidade da mudança.

**Verified — GitHub Actions cache não refuta o binding:** o workflow pode criar chaves de cache com `hashFiles(...)`, mas isso restaura artefatos/dependências dentro de um novo job. O resultado requerido continua sendo um check run com `head_sha` e deve passar no latest commit SHA. Cache de execução e identidade da atestação são camadas diferentes. Fonte: [dependency caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching) e [required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).

**Verified — A frase do cabeçalho de `land.ts` precisa ser lida com precisão:** “survive a rebase” só vale quando o rebase deixa o snapshot/tree idêntico. Se o novo parent traz conteúdo, `HEAD^{tree}` muda e o registro não é encontrado. Essa perda é correta: o conteúdo combinado não foi verificado.

## 4. Transformações: prova anterior versus autorização de land

| Operação | SHA-keyed (GitHub/GitLab) | Tree-keyed (Tachyon) | Change/policy-keyed (Gerrit) |
|---|---|---|---|
| Reescrever apenas mensagem/metadata | **Verified:** perde o verde porque nasce outro SHA | **Verified:** preserva, pois `HEAD^{tree}` é igual | **Verified:** pode copiar; `Verified` usa `NO_CODE_CHANGE` por padrão |
| Rebase sem conflito sobre base cujo snapshot mudou | **Verified:** perde pelo novo SHA | **Verified:** perde se o snapshot final/tree mudou | **Verified:** pode copiar com `TRIVIAL_REBASE`, porque a política olha o delta da Change, não igualdade do snapshot completo |
| Squash antes do land, mantendo o mesmo snapshot final | **Verified:** novo SHA não herda check | **Verified:** preserva se o tree final for idêntico | **Não verificado:** depende de como a série vira patch set/change e da política local |
| Merge/squash executado pelo servidor após checks | **Verified:** o head verde autoriza a operação; o commit resultante não precisa herdar aquele check | **Verified:** fora do modelo atual, que só sugere `ff-only` para SHA fixo | **Verified:** submit requirements tornam a Change submittable; a estratégia pode produzir o commit landed |

**Verified —** Esta distinção evita um falso positivo na tabela: GitHub “consegue squashar um PR verde” não significa que o check foi transferido ao SHA squash. Significa que a regra aceitou evidência sobre o head do PR para autorizar uma transformação controlada.

## 5. Existe uma caixa de entrega fora do PR e sem forge?

### 5.1 Gerrit: sim fora do PR/GitHub; não sem servidor

**Verified —** Gerrit põe uma **Change** estável entre autor e trunk. Vários commits/patch sets compartilham `Change-Id`; somente o patch set mais recente é submetido. A tela da Change mostra patch sets, diff, comentários, reviewers, attention set, labels, submit requirements, checks de plugins, conflitos/relacionamentos e a ação `Submit`. Fontes: [Changes](https://gerrit-review.googlesource.com/Documentation/concept-changes.html) e [Review UI](https://gerrit-review.googlesource.com/Documentation/user-review-ui.html).

**Verified —** A tela nomeia o estado **Ready to Submit** quando todas as aprovações e demais submit requirements foram satisfeitas. Dashboards listam conjuntos de Changes e podem exibir requisitos abreviados. Isso é precisamente uma inbox de entrega medida para um humano, sem metáfora de pull request e sem depender de GitHub; ainda requer o servidor Gerrit e seu repositório/review database. Fonte: [Review UI](https://gerrit-review.googlesource.com/Documentation/user-review-ui.html) e [Submit requirements](https://gerrit-review.googlesource.com/Documentation/config-submit-requirements.html).

**Verified —** Gerrit chega mais perto do padrão desejado que as ADEs baseadas em PR, mas não conhece as duas verdades locais do Tachyon: qual branch está checked out no checkout primário e se esse checkout está limpo. Seu botão `Submit` atua no repositório servido, não no índice/worktree primário do dono.

### 5.2 Phabricator/Arcanist: precedente histórico fora do PR

**Verified —** Differential usa uma **Revision** atualizada por diffs; Harbormaster trata revisions/diffs como buildables e reporta progresso/status de builds. O fluxo normal de landing era `arc land`; houve também um `Land Revision` web experimental. Isso prova que review + build + estado landable existia fora do objeto PR. Fontes: [Harbormaster](https://secure.phabricator.com/book/phabricator/article/harbormaster/) e [Automated Landing](https://secure.phabricator.com/book/phabricator/article/differential_land/).

**Verified —** O próprio manual marca o web land como protótipo com limitações e alerta que faltava chain of custody — o que landed podia diferir do mostrado. Portanto é precedente de forma, não benchmark atual de segurança nem equivalente à fixação SHA/tree do Tachyon.

### 5.3 Sapling/ISL: UI local forte, prontidão pública ainda terceirizada

**Verified —** `sl web` abre ISL num servidor/browser local e mostra stacks de commits, working-copy changes, comandos, rebases e conflitos. Porém a documentação pública de code review exige `gh`, submete a GitHub (`sl ghstack` ou `sl pr`) e mostra badges/status de CI do GitHub PR. Não achei uma inbox pública autônoma da Meta/Sapling que calcule readiness sem backend de review. Fonte: [ISL](https://sapling-scm.com/docs/addons/isl/).

### 5.4 Graphite: stacks diferentes, caixa ainda é PR

**Verified —** Graphite organiza stacks e automatiza restack/merge, mas cada unidade continua sendo PR e a readiness vem de approvals, checks e protections do GitHub. Ao precisar rebase, o merge job reentra na fase de esperar CI. Não é uma caixa sem forge. Fonte: [Merge pull requests](https://graphite.com/docs/merge-pull-requests).

### 5.5 Jujutsu: identidade certa, produto de entrega ausente

**Verified —** `jj` separa `change ID` estável de `commit ID` reescrito; describe/rebase/squash mudam commit ID e normalmente preservam change ID. Isso fornece a identidade sobre a qual uma futura caixa poderia existir. A documentação pública, porém, manda criar bookmark/push e usar GitHub/GitLab ou Gerrit; não documenta inbox, CI evidence ou decisão “ready to land” nativa. Fontes: [Glossary](https://docs.jj-vcs.dev/latest/glossary/), [GitHub/GitLab](https://docs.jj-vcs.dev/latest/github/) e [Gerrit](https://docs.jj-vcs.dev/latest/gerrit/).

### 5.6 GitButler: land sem forge existe, mas sem a prova procurada

**Verified —** GitButler oferece “Push to main / Skip pull requests mode”; o botão `Land` funciona sem forge integration e integra/pushes direto. A mesma documentação afirma que isso **bypasses code review, CI checks, and branch protection**. Logo é resposta “sim” para ação de land sem forge, mas “não” para caixa de trabalho pronto com readiness medida. Fonte: [Land branches without pull requests](https://docs.gitbutler.com/features/branch-management/pushing-and-fetching).

**Verified —** O antigo Butler Review era uma review por série de patches, acompanhava rebase/amend e permitia approvals, mas está oficialmente “paused”; não é base atual para um fluxo de entrega. Fonte: [Butler Review](https://docs.gitbutler.com/review/overview).

## 6. Comparação direta com as cinco pré-condições locais

| Pré-condição de `land.ts` | Forge/review server consegue provar? | Resultado medido |
|---|---|---|
| `worktree-clean` do agente | Só se tiver agente/runner no checkout exato | **Verified:** Tachyon mede localmente; nenhum fluxo forge acima documenta essa mesma árvore de trabalho local |
| `verified-tree` | Sim, mas normalmente como check/pipeline no SHA; Gerrit pode copiar label por política | **Verified:** aqui está o binding diferencial discutido nesta pesquisa |
| `fast-forward` de trunk para head | Servidor consegue medir sua própria ref/topologia | **Verified:** Graphite/Gerrit medem mergeability no remoto; isso não prova o checkout local do dono |
| `primary-on-trunk` | Não sem acesso ao checkout primário local | **Verified:** verdade exclusivamente host-local no desenho atual |
| `primary-clean` | Não sem acesso ao checkout primário local | **Verified:** verdade exclusivamente host-local no desenho atual |

**Verified —** A conclusão de produto não é “copiar Gerrit inteiro”. É que Gerrit prova a existência e a utilidade da **Change inbox com Ready to Submit + requisitos explícitos**, enquanto o Tachyon tem evidência local que essa tela remota não pode produzir. A combinação ainda não apareceu nos produtos públicos medidos.

## 7. Veredito para preservar ou revisar

**Verified — Preservar:** lookup por tree OID; no reuso do gate, preservar também fingerprint/idade e fail-closed. Ele evita rerun por amend puramente textual e permite compartilhar a atestação entre worktrees do mesmo clone.

**Verified — Corrigir antes de chamar land de equivalente:** fazer o consumidor de readiness aplicar o mesmo contrato de validade do reuso do gate; hoje `t-40e655` documenta a divergência.

**Verified — Corrigir o argumento competitivo:** não dizer “ninguém preserva verde sobre rewrite sem mudança de código”. Gerrit faz isso de forma configurável há tempo, e em trivial rebase pode ser até mais permissivo que igualdade do snapshot inteiro.

**Verified — Preservar a vantagem local:** `primary-on-trunk` e `primary-clean` não são substituídos por PR, Gerrit Change, merge queue ou stack. São propriedades do checkout onde o humano executa o `ff-only`.

**Verified — Copiar a forma útil:** uma inbox de entregas com estado `ready/blocked`, requisitos nomeados, evidência inspecionável e ação humana. Gerrit é a prova mais forte de que essa forma não depende da metáfora de PR; Tachyon pode aplicá-la ao seu objeto local sem importar forge obrigatório.

## 8. Não verificado

1. **Não verificado —** qualquer ADE, além do Tachyon, com store global de resultados indexado diretamente pelo Git tree OID e reutilizado entre mudanças independentes.
2. **Não verificado —** o binding interno de readiness do Cursor fora dos checks retornados pelo SCM/PR provider; as páginas públicas mostram UI e fluxo, não schema de evidência.
3. **Não verificado —** se Devin mantém algum atestado interno adicional tree/content-keyed; a documentação medida só explicita GitHub required checks e commit statuses de review.
4. **Não verificado —** infraestrutura interna da Meta que liga Sapling/ISL a seu sistema de code review e CI. A documentação pública medida descreve GitHub.
5. **Não verificado —** uma UI atual e suportada de Phabricator/herdeiros que resolva o alerta documentado de chain of custody do web land experimental.
6. **Não verificado —** comportamento geral de squash em Gerrit para transportar `Verified`; depende de modelagem da Change, submit strategy e `copyCondition` local.
7. **Não verificado —** equivalência de binding em Cursor quando o SCM é Bitbucket ou Azure DevOps; não medi os contratos desses provedores nesta tarefa.
8. **Não verificado —** produto atual que combine, sem servidor/forge, inbox multi-worktree, gate reutilizável, duas verdades do checkout primário e land humano local.
9. **Não verificado —** qualidade prática, falsos positivos ou segurança dos reviewers de IA; esta pesquisa mede identidade e transporte de evidência, não eficácia da revisão.

## 9. Fontes primárias em ordem de decisão

1. **Verified — Tachyon:** [`scripts/verify-record.mjs`](../../scripts/verify-record.mjs), [`src/workspace/verifyRecordReader.ts`](../../src/workspace/verifyRecordReader.ts), [`src/worktree/land.ts`](../../src/worktree/land.ts).
2. **Verified — Gerrit:** [sticky votes / `copyCondition`](https://gerrit-review.googlesource.com/Documentation/config-labels.html), [Review UI](https://gerrit-review.googlesource.com/Documentation/user-review-ui.html), [Changes](https://gerrit-review.googlesource.com/Documentation/concept-changes.html), [submit requirements](https://gerrit-review.googlesource.com/Documentation/config-submit-requirements.html).
3. **Verified — GitHub:** [check runs](https://docs.github.com/en/rest/checks/runs), [commit statuses](https://docs.github.com/en/rest/commits/statuses), [latest-SHA requirement](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks), [branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), [Actions cache](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).
4. **Verified — GitLab:** [pipelines API](https://docs.gitlab.com/api/pipelines/), [commits API](https://docs.gitlab.com/api/commits/), [merge request pipelines](https://docs.gitlab.com/ci/pipelines/merge_request_pipelines/).
5. **Verified — alternativas fora do PR:** [Phabricator Harbormaster](https://secure.phabricator.com/book/phabricator/article/harbormaster/), [Phabricator land](https://secure.phabricator.com/book/phabricator/article/differential_land/), [Sapling ISL](https://sapling-scm.com/docs/addons/isl/), [Jujutsu glossary](https://docs.jj-vcs.dev/latest/glossary/), [GitButler land](https://docs.gitbutler.com/features/branch-management/pushing-and-fetching).
6. **Verified — ADEs/stackers:** [Devin Review](https://docs.devin.ai/work-with-devin/devin-review), [Cursor PR review](https://cursor.com/changelog/05-07-26), [Copilot app](https://docs.github.com/en/copilot/how-tos/github-copilot-app/managing-issues-and-pull-requests), [Graphite merge](https://graphite.com/docs/merge-pull-requests).
