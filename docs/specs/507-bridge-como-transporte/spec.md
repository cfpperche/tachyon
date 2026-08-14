# SDD 507 — a bridge vira transporte, e a engine deixa de saber quem a chama

**Status:** draft
**Criada:** 2026-08-14
**Medição base:** [`docs/research/bridge-engine-boundary-t69ae46.md`](../../research/bridge-engine-boundary-t69ae46.md)
**Régua:** `node scripts/research/measure-engine-bridge-imports.mjs`

## 1. O problema

O dono observou: as tools são MCP, MCP é um jeito de falar com a engine, e **a engine não deveria saber como a comunicação é feita**. Se amanhã os agentes falarem por outro protocolo, a engine não devia mudar.

A medição confirmou o instinto e mostrou que a causa era outra: `bridge/` nunca foi uma camada. Era uma gaveta com transporte, domínio e utilitário misturados — 37 dos 68 símbolos que a engine importava de lá eram vocabulário dela mesma.

**Seis extrações já devolveram esses 37.** Esta SDD trata do que sobrou.

## 2. O estado de hoje, medido

    31 bindings · 14 imports · 5 arquivos

| consumidor | bindings | do quê |
|---|---:|---|
| `workspace/Workspace.ts` | **23** | `Bridge`, `clientRebind` (7), `token` (5), `callerIdentity` (5), `notifyAgent` (2), `agentTokenHeal`, canal de aprovação |
| `engine-service/stateMigration.ts` | 4 | `token` (2), `callerIdentity`, `clientRebind` |
| `engine-service/extensionOperationService.ts` | 2 | `tools`, canal de aprovação |
| `agents/AgentManager.ts` | 1 | `token` |
| `workspace/bridgeSlowRequestPolicy.ts` | 1 | `Bridge` |

**Três quartos estão num arquivo só, e esse arquivo é quem faz `new Bridge(...)`** (`Workspace.ts:1785`).

Isso muda a natureza do trabalho. As seis extrações foram mudança de endereço. Esta é **mudança de quem cria o quê**.

## 3. O que se compra, e é a única razão que sustenta o custo

Hoje, com tudo dentro de `packages/engine`, **nenhum gate consegue expressar "a engine não depende do transporte"**. É uma frase num documento.

Com a bridge em pacote próprio:

    @tachyon/bridge   declara dependência de @tachyon/engine
    @tachyon/engine   NÃO declara dependência de @tachyon/bridge
    check:package-boundary recusa a travessia

A regra deixa de ser observada e passa a ser imposta. É a mesma diferença que a SDD 506 comprou para os outros pacotes.

## 4. O molde já existe no repositório

`EngineHost` é um contrato de 21 pontos com três implementações (`Workspace`, `DaemonEngineHost`, `TaskNotificationService`). Foi assim que a engine deixou de saber que o VS Code existe — spec 233, entregue e viva.

**Esta SDD aplica o mesmo padrão à segunda direção.** Não é desenho novo; é um desenho provado, aplicado onde nunca foi.

## 5. Critérios de aceite

- [ ] **Cenário: a engine não alcança o transporte**
  - **Dado** `packages/engine` sem declarar dependência de `@tachyon/bridge`
  - **Quando** um arquivo da engine importa qualquer coisa da bridge
  - **Então** `check:package-boundary` falha nomeando arquivo, alvo e fronteira

- [ ] **Cenário: um segundo transporte não precisa da engine mudar**
  - **Dado** o contrato que a engine expõe
  - **Quando** alguém escreve um transporte novo contra ele
  - **Então** nenhum arquivo de `packages/engine` precisa ser editado, e existe prova executável disso

- [ ] **Cenário: o produto continua idêntico**
  - **Dado** qualquer fatia desta SDD já mergeada
  - **Quando** se roda `npm run release` e `npm run smoke:vsix`
  - **Então** o VSIX é produzido e instala, com a mesma identidade de versão

- [ ] A régua mede **zero** bindings `engine → bridge`.
- [ ] `packages/bridge` existe, declara `@tachyon/engine`, e a engine não declara nada de volta.
- [ ] `check:package-boundary` com lista de exceções **vazia**.
- [ ] Quem instancia a `Bridge` não é mais a engine.
- [ ] F5 provado por um humano.

## 6. Fora de escopo

- **Um terceiro processo.** A engine já roda como daemon; a bridge vive dentro dele. Separar em processos adiciona custo de comunicação e um modo de falha novo, sem medição que peça.
- **Escrever o segundo transporte.** Esta SDD torna possível; não constrói.
- **Mudar a identidade de release.** Uma versão, um VSIX.
- **Consertar `t-5313dc` e `t-65e80b`.** Defeitos conhecidos de aprovação, com cartão próprio.
- **Reescrever o protocolo MCP.** As tools continuam as mesmas.

## 7. Riscos nomeados

- **`Workspace.ts` é o composition root e tem 23 das 31 arestas.** Ele já é o maior arquivo de coordenação do produto; mexer nele é onde esta SDD pode dar errado.
- **`token`, `callerIdentity` e `clientRebind` são autenticação e ciclo de vida de cliente.** Errar aqui não quebra um teste — abre uma porta. Qualquer fatia que os toque prova o comportamento antes e depois.
- **`stateMigration.ts` migra estado persistido de token e rebind.** Migração errada não falha no gate; falha no reload de alguém.
- **A engine expõe contrato demais.** Um port com 40 métodos é a gaveta de novo, com nome melhor. O `EngineHost` tem 21 e nasceu de necessidade medida.
