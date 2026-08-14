# SDD 506 — plano

Fonte de todo número aqui: `docs/architecture/tachyon-monorepo-transitive-baseline.md`, medido em
2026-08-14 sobre a 0.91.0 por `scripts/research/measure-monorepo-graph.mjs`.

## Decisões, e o que foi rejeitado

### D1 — npm workspaces. Não pnpm, não turbo, não nx.

O repositório já usa npm, tem `package-lock.json`, e o CI roda `npm ci`. Workspaces é o recurso que
já existe na ferramenta que já está lá.

**Rejeitado:** pnpm, turbo, nx. Nenhum deles resolve um problema MEDIDO deste repositório. Cache de
build distribuído e grafo de tarefas resolvem dor de monorepo grande com CI lento; o nosso gate roda
em uma máquina e o `verify:full` já tem orçamento próprio. Trocar de gerenciador no meio de uma
migração de layout é somar dois riscos que não precisam andar juntos.

Se depois da migração aparecer dor medida, trocar de ferramenta fica mais fácil, não mais difícil.

### D2 — o manifesto sai da raiz por ÚLTIMO.

O instinto é começar pela forma final: criar `apps/vscode-extension/`, mover `package.json` para lá,
e depois arrumar o resto. A medição diz que isso quebra primeiro e quebra tudo — `package.json#main`,
`vsce`, `.vscodeignore`, os 20 outputs do `esbuild.mjs`, e as cinco referências de `launch.json`.

**Decisão:** a raiz continua sendo a extensão até a última fatia. Os pacotes nascem embaixo dela e o
manifesto se muda no fim, quando não sobra mais nada para descobrir.

**Rejeitado:** manifesto primeiro. O custo é perder o F5 e o VSIX no dia um, no meio da migração,
que é exatamente quando se precisa dos dois para saber se algo quebrou.

### D3 — a fronteira é imposta por um gate que lê imports relativos, e nasce com o primeiro pacote.

npm workspaces **não impede** que um arquivo de `packages/engine` importe `../../webview-ui/algo`.
Workspaces resolve instalação e resolução de módulo por nome; caminho relativo atravessa qualquer
fronteira em silêncio.

A regra: **dentro de `packages/`, um import relativo não pode escapar da raiz do próprio pacote.**
Quem precisa de outro pacote importa pelo NOME dele, e só se o `package.json` declarar a dependência.

O gate `check:engine-boundary` (spec 233) já é exatamente esse tipo de guarda — uma lista de quem
pode importar `vscode`, com o motivo escrito ao lado de cada entrada. O novo gate é o mesmo desenho,
numa segunda dimensão. E o resolvedor de imports já existe e já foi medido: está em
`scripts/research/measure-monorepo-graph.mjs`.

**Rejeitado:** dependency-cruiser ou eslint-plugin-boundaries. São ferramentas boas e trariam uma
configuração nova, um formato novo e uma dependência nova para uma regra que cabe num script que já
sabe resolver os imports deste repositório.

**Rejeitado também:** deixar a imposição para o fim. Um pacote sem gate acumula travessia por semanas
e o gate final vira uma lista de exceções em vez de uma regra.

### D4 — TypeScript project references, um `tsconfig` por pacote.

`typecheck` é gate e hoje roda três configs (`tsconfig.json`, `tsconfig.webview.json`,
`tsconfig.browser-test.json`). Com pacotes, cada um declara o seu e a raiz referencia. Project
references são o mecanismo do próprio TypeScript para dizer "este pacote só enxerga aqueles".

Isso dá uma segunda imposição, de graça e no compilador: um import fora das referências declaradas
não compila. O gate de D3 continua necessário porque ele pega o caminho relativo que o compilador
aceita.

### D5 — `git mv`, uma fatia por pacote, gate verde em cada.

Nada de mover tudo e consertar depois. Cada fatia move um conjunto medido, ajusta o que aponta para
ele, e passa o gate inteiro antes da próxima começar.

### D7 — refatorar é permitido; o vocabulário de tipo ganha casa no pacote.

Descoberto oito minutos depois de a fatia 1 começar, e é um buraco na medição, não um erro de quem
executou.

**A interseção dos 32 foi calculada sobre arestas de VALOR.** É a pergunta certa para "isto alcança
`vscode` em runtime" e a pergunta errada para "o que este pacote precisa para compilar". Um módulo
de tipo puro não emite JavaScript — `src/richDoc/types.ts` tem 65 linhas e zero exports de valor,
`src/externalTools/types.ts` tem 41 e zero. Nenhum dos dois pode aparecer numa interseção de runtime,
por construção.

O baseline separou tipo de valor e acertou. A consequência que ninguém tirou: **um pacote precisa dos
seus tipos, e o grafo de runtime não consegue enumerá-los.** Quem descobriu foi o `typecheck`
independente do pacote — critério de aceite que fica.

O que o buraco revelou é o problema que esta SDD existe para resolver, em forma concreta:
`TemporaryBackstopMonitor` importa `ManagedEntryInfo` de dentro de uma classe de **5.587 linhas**, e
`sidebar/types.ts` importa `EntryKind` de um carregador de config de **2.080**. O tipo está certo; o
ENDEREÇO está errado. Um vocabulário compartilhado sem casa mora dentro da implementação, e quem
precisa da palavra arrasta o arquivo inteiro.

**Decisão do dono, tomada quando eu propus encolher a fatia para evitar a refatoração:** *"eu nao to
preocupado com refatoracoes, se tiver que criar pacotes e arquivos novos crie ... quero essa merda
monoreporizada sem acoplamento direto entre as camadas do projeto"*.

Então:

- o tipo se muda para o pacote; a implementação importa de volta. **Nunca `shared` → `src/`.**
- criar arquivo e módulo novo é permitido e esperado;
- criar um pacote novo exige o número que o justifica, não simetria;
- **é mudança de ENDEREÇO, não reescrita.** Cada tipo extraído mantém a forma exata. Uma mudança de
  forma escondida dentro de uma migração de 5.587 linhas não é revisável por ninguém;
- **não vale depósito de tipos.** Um `types.ts` gigante no pacote é o mesmo problema com endereço
  novo. O tipo mora junto do conceito dele.

Consequência para as fatias seguintes: as contagens de `engine` (355) e `webview-ui` (174) têm o
mesmo viés. Cada fatia mede o fecho de TIPO dos seus membros antes de mover, e a diferença contra o
número de runtime é resultado esperado, não defeito.

### D6 — a medição vira ratchet.

`measure-monorepo-graph.mjs` é reproduzível. Cada fatia termina rodando ele e comparando o número do
pacote com o que a fatia declarou ter movido. Divergência é defeito da fatia, não do script.

## Ordem das fatias

A ordem sai da ordem de quebra medida, invertida: o que quebra por último se move primeiro.

    1  workspaces ligados + packages/shared (36) + o gate de fronteira nasce
    2  packages/engine (355)
    3  packages/webview-ui (174)
    4  classificar os 212 residuais — medição, sem mover nada
    5  apps/vscode-extension — o manifesto sai da raiz
    6  fechar: re-rodar a medição, atualizar o documento, aposentar o que sobrou

**A fatia 1 é a mais importante e a menor.** `shared` tem 36 módulos, zero deles alcança `vscode`, e
a direção das arestas já foi medida: `src/` e scripts apontam para os quatro `.cjs`, e eles não
apontam para ninguém. Se a instalação, o build, o typecheck, o F5 e o VSIX sobrevivem a esse pacote,
sobrevivem aos outros. Se não sobrevivem, descobrimos com 36 arquivos em jogo em vez de 355.

O gate nasce junto porque é a fatia em que existe pela primeira vez uma fronteira para impor.

## Arquivos que cada fatia toca

Os 18 operacionais medidos, e quando cada um entra:

| arquivo | fatia |
|---|---|
| `package.json` (workspaces) | 1 |
| `package-lock.json` | 1, e a cada pacote |
| `tsconfig.json`, `tsconfig.webview.json` | 1, e a cada pacote |
| `scripts/check-package-boundary.mjs` (novo) | 1 |
| `esbuild.mjs` | 2, 3, 5 |
| `scripts/verify-full.mjs`, `scripts/verify-record.mjs` | 1 |
| `.github/workflows/ci.yml`, `.vscode/tasks.json` | 1 |
| `scripts/prepare-package.mjs`, `scripts/package-closure.mjs` | 5 |
| `scripts/record-provenance.mjs`, `scripts/ship-boundary.mjs` | 5 |
| `scripts/vsix-artifact.mjs`, `scripts/vsix-smoke.mjs` | 5 |
| `.vscodeignore`, `.vscode/launch.json`, `scripts/dev-host/pointer.mjs` | 5 |

## Riscos, e o que fazer quando acontecerem

- **O F5 quebra no meio.** É a capacidade de dogfood do dono. Qualquer fatia que toque `launch.json`
  ou `dev-host/pointer.mjs` prova o F5 antes de notificar, e diz como provou.
- **`npm ci` fica mais lento ou o lockfile incha.** Medir antes e depois da fatia 1 e registrar. Se
  piorar de forma relevante, é dado para reabrir D1, não motivo para seguir calado.
- **Um pacote precisa de um tipo que mora do outro lado.** É esperado: 9 imports só de tipo existem
  hoje. Resolver por `exports` de tipos ou pelo `shared`, nunca empurrando o arquivo inteiro para o
  lado errado.
- **Um ciclo aparece entre `shared` e um consumidor.** O documento chama os 32 de teto inicial, não
  de API pronta. Dividir `shared` é permitido; qualquer divisão preserva os dois consumidores medidos.
