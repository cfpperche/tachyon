# SDD 506 — Monorepo por fecho de entrypoint

**Status:** shipped
**Criada:** 2026-08-14
**Base de medição:** [`docs/architecture/tachyon-monorepo-transitive-baseline.md`](../../architecture/tachyon-monorepo-transitive-baseline.md)

## 1. O problema

O Tachyon é um pacote só. Um `package.json` na raiz, uma versão, um VSIX, e 777 módulos de runtime
dentro de `src/` sem nenhuma fronteira que uma ferramenta consiga ler.

O dono nomeou o incômodo assim: *"estamos construindo o produto um monolito sem separar isso em um
monorepo classico com os modulos do systema desacoplados"*. E fixou a condição de saída:
*"somente tasks bloqueantes vao ser resolvidas enquanto nao transformarmos esse repositorio em um
monorepo sem acoplamento direto entre os modulos"*.

**"Sem acoplamento direto" é a parte que não pode ser esquecida.** Reorganizar pastas produz um
monorepo em aparência. O que o dono pediu exige que uma regra que o build cumpre recuse o import
errado — senão o acoplamento volta na primeira semana e ninguém vê.

### O que a medição mostrou, e por que ela muda o desenho

    727 de 777 módulos de runtime (93,6%) são PORTÁVEIS — não alcançam `vscode` por fecho transitivo
     50 são acoplados
     42 importam `vscode` em valor; 9 só em tipo, que o compilador apaga

O código já está separado por dentro. O que falta é embalagem e imposição, não desacoplamento.

E a medição derrubou o corte que qualquer um faria primeiro:

- **`agents` e `runtime` não caem sozinhos.** A engine alcança 36 dos 46 arquivos de `agents` e 17
  de 20 de `runtime`; o navegador alcança 2 e 5. Cortar pelos nomes atuais cria dependência cruzada
  antes de criar isolamento.
- **`src/webview/` não é um pacote.** Só 165 dos 206 arquivos do programa navegador moram lá, e 104
  dos 269 que moram lá não pertencem ao navegador. A pasta se parte em três.

**A regra que sai disso, e que governa toda esta SDD: o corte é pelo fecho de quem inicia o
programa, nunca pelo nome da pasta.**

## 2. A forma pretendida

```
tachyon/
├── package.json              declara os workspaces; nenhum código de produto
├── apps/
│   └── vscode-extension/     manifesto, ativação, hosts de painel
└── packages/
    ├── engine/               355 módulos, zero VS Code
    ├── shared/                36 módulos — 32 na interseção engine/navegador
    │                             + os 4 `.cjs` que já viviam em `shared/` na raiz
    └── webview-ui/           174 módulos, as 27 telas
```

Os **212 residuais** — app do VS Code, hosts de webview, entradas auxiliares, validadores — **não
viram um quinto pacote nesta SDD**. Eles serão classificados por medição, não batizados por nome.

### `apps/` é plural desde o primeiro dia

Nada em build, script ou `tsconfig` pode assumir que existe um app único. Não porque um segundo app
esteja planejado — não está, e desenhar para ele seria especulação. É porque assumir singular custa
zero agora e custa uma semana depois, e o repositório já tem histórico de caminho cravado como
literal (a fatia 1 quase deixou `@tachyon/shared` fixo em quatro pontos de um varredor de gate).

O dono perguntou se a estrutura suportaria um segundo app — Electron, ou Tauri com casca em Rust. A
resposta medida: **a peça que torna isso possível já existe e não é o monorepo.** A engine já roda
como processo próprio atrás de um socket Unix por workspace (spec 382, entregue), com `protocol.ts` e
`controlClient.ts`. É exatamente o formato que um sidecar de Tauri consome.

O que esta SDD acrescenta é manter isso vivo: `packages/engine` com zero `vscode` e um gate que
impede a portabilidade de apodrecer em silêncio.

O que NÃO vem de graça, e fica registrado para não virar surpresa: os 212 residuais são o app do VS
Code e seus hosts, e não transferem; os 61 tokens do design system resolvem todos para `--vscode-*`,
então fora do VS Code alguém precisa fornecer cor; e a spec 382 declara Linux/WSL, com macOS
explicitamente sem suporte.

## 3. Critérios de aceite

- [x] **Cenário: o import errado é recusado pelo build**
  - **Dado** um pacote que não declara dependência de outro
  - **Quando** um arquivo dele importa um módulo daquele outro pacote
  - **Então** o gate falha nomeando o arquivo, o alvo e a fronteira violada, antes de qualquer teste

- [x] **Cenário: o produto continua sendo um VSIX instalável a cada fatia**
  - **Dado** qualquer fatia desta SDD já mergeada
  - **Quando** se roda `npm run release` e `npm run smoke:vsix`
  - **Então** o VSIX é produzido e instala, com a mesma identidade de versão de antes

- [x] **Cenário: a medição volta a rodar e o número anda**
  - **Dado** uma fatia que moveu módulos para um pacote
  - **Quando** se roda `node scripts/research/measure-monorepo-graph.mjs`
  - **Então** a contagem daquele pacote bate com o que a fatia declarou ter movido

- [x] O `package.json` da raiz declara workspaces e **não contém código de produto**.
- [x] `engine`, `shared` e `webview-ui` existem como pacotes com fronteira imposta.
- [x] Nenhum módulo de `packages/engine` ou `packages/webview-ui` importa `vscode`, e o gate prova.
- [x] O produto continua com **uma versão e um VSIX**.
- [x] Os 212 residuais estão classificados por escrito, com o número de cada grupo.
- [x] `docs/architecture/tachyon-monorepo-transitive-baseline.md` foi re-rodado ao final e os números
      do documento batem com a árvore.

**Closure:** A árvore usa quatro workspaces de produto/fonte (`apps/vscode-extension` e três
`packages/*`), mantém uma versão e um VSIX, impõe fronteiras sem exceções, e registra no baseline a
medição final de 805 fontes/runtime, incluindo as divergências causadas pelo fecho de tipos.

## 4. Fora de escopo

- **PoC de React no lugar de Preact.** O dono adiou explicitamente: *"isso fica pra depois"*.
- **Versionar engine e shell à parte.** Nenhuma medição nova justifica; o levantamento anterior
  precificou em trimestre+.
- **Mudar a identidade de release.** A medição sustenta migração organizacional, e diz que fazer as
  duas ao mesmo tempo não se sustenta.
- **Trazer o companion (browser/mobile) para dentro.** Continua em `cfpperche/tachyon-companion`.
- **Escolher pnpm, turbo ou nx.** A escolha de ferramenta é uma decisão do plano, tomada depois de a
  forma dos pacotes existir, e a resposta padrão é a mais simples que resolve.
- **Inventar um quinto pacote para os 212 residuais.**

## 5. Invariantes de produto afetados

Nenhum invariante de comportamento. Esta SDD move fonte e adiciona imposição; o produto instalado
deve ser indistinguível do atual em cada fatia.

## 6. Riscos nomeados

- **O manifesto quebra primeiro.** `package.json#main` aponta para `./dist/extension.js`,
  `vscode:prepublish` chama `scripts/prepare-package.mjs`, e `.vscodeignore` inclui `!dist/**`. Mover
  o manifesto para `apps/vscode-extension/` é a operação mais arriscada da SDD, e por isso é a última.
- **`esbuild.mjs` tem 20 configurações de saída sob `dist/`** e mais de 60 operações de estágio/cópia.
  É o segundo ponto de dor e não tem atalho.
- **F5/dev-host tem cinco referências explícitas** a `${workspaceFolder}[/...]/dist/**/*.js`. Quebrar
  o F5 tira a capacidade de dogfood do dono no meio da migração.
- **Tipos não são runtime.** Somar os 9 imports só de tipo aos 42 de valor infla o acoplamento em 38
  arquivos (76% sobre os 50 reais). Um desenho que empurra esses 38 para dentro do shell está errado.
