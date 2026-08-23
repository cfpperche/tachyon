# 515 — notes

## Fatia 1 — o que a implementação encontrou (2026-08-23)

**Três vezes o sistema já tinha o que eu ia construir.** Vale registrar porque muda o custo estimado
da spec inteira, e porque é o mesmo erro repetido: propor antes de medir.

1. `LoadResult.provenance` já é **opcional**, e no lockfile `source`/`integrity` também
   (`lockfile.ts:544-545`). A porta por zip não precisou de nenhuma mudança de schema.
2. `checkUpdates` já pula plugin sem `source` — com o comentário "a dir install has no source to
   re-resolve". A checagem de atualização nunca ia consultar um plugin instalado por arquivo.
3. O view-model do card já tem `localInstall` e já desenha o caso sem `sourceSpec`; as ações
   "Reinstall" e "Check for updates" já eram condicionadas a ele. Só troquei o texto de "local dir
   install" para "installed from a local file", porque agora são duas formas de chegar local.

**O que exigiu decisão de verdade:** onde o manifesto pode estar dentro do arquivo. Um zip de release
tem tudo sob uma pasta (`demo-1.0.0/…`), e obrigar o humano a achatar isso seria transferir a ele um
detalhe do empacotador. Aceitar raiz **ou** uma única pasta com manifesto cobre as duas formas; duas
pastas com manifesto é recusado pelo nome em vez de adivinhado.

**Dogfood real:** empacotei o `sdd` instalado neste workspace no formato de release (sob pasta) e
carreguei pela porta nova — `sdd 1.9.0`, skill `sdd`, sem procedência. Script em
`scripts/dogfood/plugin-zip-install.ts`.

## Um conflito que a fatia 2 vai ter que resolver (achado durante a fatia 1)

`restoreWorkspaceSkillDest` (t-318d7d) — a função que faz a concessão funcionar para um agente codex,
já que o codex não descobre skills do próprio `CODEX_HOME` — **consulta o lockfile** para saber qual
dest de workspace materializar. O plano da fatia 2 diz que a instalação deixa de declarar `skill-dir`
no lockfile. Se as duas coisas valerem juntas, a restauração fica sem o que apontar e o codex volta a
ser recusado no launch.

A saída está no espírito da própria spec: **derivar em vez de consultar**. A concessão já carrega
`path: .tachyon/plugins/<nome>/skills/<skill>`, que é tudo o que a materialização precisa — o
lockfile nunca foi necessário ali, só era o que estava à mão. A fatia 2 muda `restoreWorkspaceSkillDest`
para derivar do payload, e o T9 (provar antes de remover) passa a testar exatamente isso.

`plan.md` foi atualizado com essa decisão.
