# t-4ab1fb — o verde de uma worktree pode carregar outra árvore

**Data da medição:** 2026-08-14  
**Pergunta:** quando um agente roda testes na worktree dele, exercita o código dela ou o checkout primário?

## Resposta curta

Pode exercitar os dois na mesma execução.

- Imports relativos resolvem na worktree.
- Imports `@tachyon/*` resolvem pelo `node_modules` que estiver naquele checkout.
- Quando `<worktree>/node_modules` é o link configurado para `/home/goat/tachyon/node_modules`, Node,
  Vitest, TypeScript e esbuild seguem os links de workspace dali até **`/home/goat/tachyon/packages/*`**:
  o checkout primário.
- Quando o agente roda `npm ci`/`npm install`, npm substitui esse link por um diretório real e cria
  links de workspace relativos a ele. A partir daí `@tachyon/*` aponta para a própria worktree.

Logo, uma atestação indexada pela árvore Git não prova sozinha que todos os módulos carregados vieram
dessa árvore. O risco não é hipotético: o experimento abaixo fez um teste Vitest da worktree carregar
o módulo homônimo do primário.

## A contradição: Node falhou, mas 8.267 testes passaram

Não há resolvedor especial do Vitest salvando a worktree. Os dois fatos mediam pedidos diferentes.

Na worktree removida `waitdomain`, o registro preservado mostra:

```text
node_modules -> /home/goat/tachyon/node_modules
node_modules/@tachyon/engine -> ../../packages/engine
readlink -f node_modules/@tachyon/engine
/home/goat/tachyon/packages/engine
```

O módulo novo `packages/engine/src/workspace/Waiters.ts` existia apenas na worktree. Por isso Node,
ao pedir `@tachyon/engine/workspace/Waiters.js`, seguiu o link até o primário, não achou o arquivo e
deu `MODULE_NOT_FOUND`/`ERR_MODULE_NOT_FOUND`.

Já o `verify:full` não exige que cada arquivo da árvore seja importado por nome de pacote. Depois do
primeiro typecheck vermelho, `waitdomain` converteu os imports do consumidor e2e que tocavam a mudança
para caminhos relativos. Esses caminhos carregaram `Waiters.ts` da worktree. Os demais imports
`@tachyon/*` continuaram carregando os pacotes do primário, que naquele momento eram uma base válida e
passavam os demais testes. Assim, “8.267 passaram” e “o módulo novo por nome não existe” são
simultaneamente verdadeiros: o gate foi uma execução **mista**, não uma resolução local do Vitest.

O outro contraexemplo, a fatia 1 da SDD 506, também tem explicação medida. O transcript de `pkgshared`
contém:

```text
npm warn reify Removing non-directory .../pkgshared/node_modules
added 635 packages ...
.../pkgshared/node_modules/@tachyon/shared -> ../../packages/shared
```

Um experimento mínimo repetido nesta investigação começou com `node_modules` apontando para um
diretório primário vazio. `npm install` imprimiu a mesma mensagem `Removing non-directory`, terminou
com `node_modules` como **diretório real** e criou `node_modules/probe -> ../packages/probe`. Portanto,
a fatia 1 testou o `packages/shared` dela porque seu `npm ci` desfez o compartilhamento antes do gate.

## Experimento direto com símbolo exclusivo da worktree

Na árvore `c8cecc5d3397a9690cac4cef4c5b1be7a10a2301`, com esta worktree ainda apontando para o
`node_modules` primário, acrescentei temporariamente a
`packages/engine/src/host/hostResources.ts`:

```ts
export const WORKTREE_RESOLUTION_PROBE_4AB1FB = "arvorecerta-worktree" as const;
```

E criei um teste temporário que importava o símbolo pela porta de produção:

```ts
import { WORKTREE_RESOLUTION_PROBE_4AB1FB } from "@tachyon/engine/host/hostResources.js";
expect(WORKTREE_RESOLUTION_PROBE_4AB1FB).toBe("arvorecerta-worktree");
```

Resultados:

| resolvedor | resultado observado | árvore carregada |
|---|---|---|
| Node `require.resolve` | `/home/goat/tachyon/packages/engine/src/host/hostResources.ts` | primário |
| Vitest 3.2.6 | teste coletado, mas recebeu `undefined` em vez do símbolo exclusivo | primário |
| TypeScript 5.7 (`NodeNext`) | `TS2305: ... has no exported member` | primário |
| esbuild 0.25 | `No matching export in "../../../../../tachyon/packages/engine/..."` | primário |

O teste Vitest falhou exatamente como esperado (`expected undefined to be 'arvorecerta-worktree'`).
O símbolo e o teste temporários foram removidos; nenhum contorno ou resolvedor foi alterado.

Não houve divergência entre os quatro resolvedores neste arranjo. A divergência relevante é entre
**formas de import**: relativo = worktree; nome de pacote através do link compartilhado = primário.

## Alcance medido

Na árvore final desta investigação há **2.368 ocorrências de import/require dinâmico ou estático por
`@tachyon/*` em 921 arquivos**: 574 arquivos em `test/`, 161 em `packages/`, 113 em `apps/`, 51 em
`scripts/` e 22 em outros lugares. Há também 83 arquivos de teste com imports relativos explícitos
para `packages/{engine,shared,webview-ui}`. Portanto, os caminhos relativos são um contorno parcial;
eles não tornam um gate com `node_modules` compartilhado uma prova de árvore inteira.

### Atestações da fase

Os transcripts preservados permitem separar as seis fatias da SDD 506:

| trabalho | árvore atestada | estado de dependências antes do gate | conclusão |
|---|---|---|---|
| `t-c7c0db`, fatia 1 | `5eeebd51b40c9fa92fcf6ac607ca058527600600` | `npm ci` removeu o link; diretório próprio | não contaminada por este defeito |
| `t-8e67ef`, fatia 2 | `279f95460ad4f135cce2dcf3ff73566de9455b82` | `npm install` removeu o link; diretório próprio | não contaminada por este defeito |
| `t-547fda`, fatia 3 | `1a6fd0d53d737b39dfbaaf8162b6ce19bd914e08` | começou compartilhada; `npm install` instalou 638 pacotes antes do gate | não contaminada no gate final |
| `t-dde6a6`, fatia 4 | `9a1e89e14823922237fbe45cb32cf93798c50891` | não há ref de atestação para essa árvore | não existe prova a contaminar |
| `t-8ef127`, fatia 5 | `d131a249a930af6823409f97fb93d0a5d60ee3eb` | agente desfez o link e rodou `npm ci` (639 pacotes) | não contaminada por este defeito |
| `t-a41951`, fatia 6 | `6a9341eda40acbdfa4e32cce89b5c1ae8adfa087` | sem instalação local medida; gate rodou com link compartilhado | **sob suspeita nominal** |

A fatia 6 mudou sobretudo documentos e guardas, não os pacotes que o link redirecionava, então não há
evidência de comportamento incorreto nela. Ainda assim, sua ref afirma a árvore inteira e foi calculada
num processo capaz de carregar fontes de outra árvore; deve ser reatestada com dependências locais.

Duas atestações adjacentes à fase têm a mesma exposição e também ficam nominalmente sob suspeita:

- `t-54450c`, árvore `e80df9bbdcef3f83729775fce5b8084b818304d0` (8.260 testes);
- `t-70a76b`/`waitdomain`, árvore `ffbe22dd1f365f84dd22ea3d422aa688607c7d71`
  (8.267 testes), onde a mistura foi observada diretamente.

Isto não invalida automaticamente os resultados focados dessas tarefas: `waitdomain`, por exemplo,
mudou os consumidores da extração para caminhos relativos e eles passaram. Invalida a interpretação
mais forte de que a ref de `verify:full` prova que **toda** a árvore registrada foi a árvore carregada.

## Por que `claude` tem diretório próprio

É ordem de criação, seguida de preservação deliberada — não uma escolha especial para Claude.

- A worktree `claude` nasceu em 2026-07-30 15:12; seu `node_modules` real nasceu às 15:38 do mesmo dia.
- O compartilhamento foi introduzido depois, no commit `f75b982f` de 2026-08-01.
- A regra atual classifica diretório real como `foreign`/`own` e explicitamente não o substitui.
- `claude-cowntdown` (2026-08-05) e as worktrees posteriores nasceram depois da regra e receberam o
  link quando os lockfiles eram idênticos.

Portanto `claude` instalou dependências antes de o mecanismo existir; o mecanismo corretamente preservou
esse diretório nas reutilizações seguintes.

## Conserto proposto (não implementado)

Para este repositório, remover `node_modules` de `settings.worktree.sharedDirectories` e preparar cada
worktree com `npm ci --ignore-scripts --prefer-offline --no-audit --no-fund` antes de qualquer check.
Depois, reexecutar `verify:full` nas três árvores nominalmente suspeitas acima em checkout com
`node_modules` próprio.

O número que sustenta a escolha é a assimetria medida: o benefício economiza aproximadamente **5–7 s
e 478 MB por worktree**, enquanto a superfície silenciosamente redirecionável já é **2.368 imports em
921 arquivos**, e uma mistura real já ocorreu. O detector de lockfile não protege alterações de fonte
com lockfile idêntico — exatamente o caso normal de uma worktree de desenvolvimento.

Uma alternativa futura poderia compartilhar apenas dependências externas e materializar links de
workspace locais, mas isso cria uma segunda instalação parcial para manter. Não há medição que pague
essa maquinaria hoje; a instalação local simples já foi exercitada nas fatias 1, 2, 3 e 5 e tornou os
links corretos.
