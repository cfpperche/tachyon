# Como o Paseo conversa com seus agentes

_Task `t-1cb3f8`, 2026-08-12. Fonte lida: `getpaseo/paseo`, commit
`635a8be437f390841786c04955bc867ecb84d619` (`release: 0.85.1`, 2026-08-12)._

## Veredito primeiro

**O Paseo achou exatamente a porta que faltava ao Orca: ACP.** Para os agentes do catálogo ele
lança um subprocesso com pipes, faz JSON-RPC newline-delimited em stdin/stdout, recebe eventos
estruturados e envia `session/prompt`. Não lê transcript para construir a conversa e não digita em
PTY. O catálogo amplo não custa um decoder por CLI porque 36 entradas reutilizam um único cliente
ACP; quatro delas têm pequenos adaptadores específicos.

**Isso não resolve o enforcement que medimos hoje.** O Paseo só pode decidir uma autorização quando
o agente chama `session/request_permission`. O seu “Auto Accept” inclusive deixa explícita essa
fronteira: ele responde automaticamente a uma request que chegou
(`packages/server/src/server/agent/providers/acp-agent.ts:2212-2254`). Não existe nessa integração um
interceptor anterior a toda tool. Portanto Grok, OpenCode, Codex e pi continuariam podendo executar
sem chamar o cliente, como medido em `docs/research/t-c88c94-acp-injection.md`. Modos fortes são
configuração enviada ao runtime — por RPC ou no lançamento —, não um portão universal do Paseo.

**O número atual no código não é 38.** Neste commit são **6 providers embutidos com implementação
dedicada** e **36 entradas no catálogo ACP**, total bruto de **42 nomes suportados**. A página pública
chama apenas Claude, Codex, OpenCode e Pi de “Native support”; Copilot é um embutido via ACP e OMP é
embutido mas desabilitado por padrão. O “38”/“+34” do screenshot corresponde à apresentação antiga
de 4 nativos + 34 catálogo; o catálogo cresceu. O número que mede integrações próprias é **6**, não
38 nem 42. O número que mede conversa estruturada pronta é, porém, **todo o catálogo ACP**, e não
apenas “processos lançados”.

## Reprodução e limite da leitura

Clonei o upstream fora do repositório do produto, em `/tmp/paseo-source.V8nBr8`, e li o commit acima.
Nenhum código do Paseo foi copiado para cá; este documento contém somente conclusões, caminhos,
linhas e citações curtas. Para repetir: clone o repositório e faça checkout de `635a8be437f39084`.

A busca pedida foi decisiva: `agent-client-protocol|acp|jsonrpc` encontra a dependência
`@agentclientprotocol/sdk` e a implementação ACP logo no import
(`packages/server/src/server/agent/providers/acp-agent.ts:14-59`). Em contraste, a mesma busca no
Orca havia dado zero no subsistema de chat.

## 1. Por onde a conversa chega

Para as entradas de catálogo, **notificações ACP no stdout do filho**. O processo é criado com os
três stdios em pipe (`packages/server/src/server/agent/providers/acp-agent.ts:2453-2472`). O stdout vira um stream NDJSON: acumula até newline,
faz `JSON.parse` e entrega a mensagem à conexão; no sentido oposto serializa uma mensagem JSON mais
`\n` (`packages/server/src/server/agent/providers/acp-agent.ts:300-365`). A `ClientSideConnection` do SDK é ligada diretamente ao stdin/stdout
do filho e faz o handshake `initialize` (`packages/server/src/server/agent/providers/acp-agent.ts:2495-2516`).

A conversa chega em `session/update`. O callback valida o `sessionId`, traduz a notificação e publica
os eventos internos (`packages/server/src/server/agent/providers/acp-agent.ts:2257-2283`). Os casos estruturados incluem chunks da resposta,
raciocínio, tool call/update, plano, modo, config, uso e slash commands
(`packages/server/src/server/agent/providers/acp-agent.ts:2612-2675`). Não há tail de arquivo nem parser de transcript nesse caminho.

Isso vale especificamente para o catálogo ACP. Os seis embutidos não usam uma porta única: Claude
usa o Agent SDK, Codex usa app-server, Copilot usa ACP, OpenCode usa seu SDK/servidor, Pi e OMP usam
RPC próprio. A lista de factories é a evidência concentrada dessa separação
(`packages/server/src/server/agent/provider-registry.ts:184-225`). O ganho arquitetural não é “um
protocolo para tudo”; é “um protocolo comum que torna dezenas de CLIs uma integração só”.

## 2. Por onde o operador envia

**Porta estruturada, não PTY.** Um turno chama `connection.prompt` com `sessionId`, `messageId` e
content blocks (`packages/server/src/server/agent/providers/acp-agent.ts:1587-1633`). A mesma conexão foi criada sobre os pipes do subprocesso,
portanto o prompt sai como JSON-RPC no stdin. Criação e retomada também são protocolo:
`session/new`, `session/load` ou `session/resume` (`packages/server/src/server/agent/providers/acp-agent.ts:1482-1550`).

Modelo, esforço e modo do composer também têm portas estruturadas. O cliente usa
`unstable_setSessionModel` ou config option para modelo (`packages/server/src/server/agent/providers/acp-agent.ts:1872-1965`), config option para
nível de pensamento (`packages/server/src/server/agent/providers/acp-agent.ts:1967-2010`) e `setSessionMode`/config option para modo
(`packages/server/src/server/agent/providers/acp-agent.ts:1737-1851`). É por isso que a UI pode oferecer esses controles sem raspar uma TUI.

## 3. ACP aparece?

**Sim, como dependência e como implementação central.** Além do import do SDK em
`packages/server/src/server/agent/providers/acp-agent.ts:14-59`, o transporte realiza `initialize` com a versão do protocolo e capabilities
(`packages/server/src/server/agent/providers/acp-agent.ts:2500-2514`), `session/new` (`packages/server/src/server/agent/providers/acp-agent.ts:1489-1498`) e `session/prompt`
(`packages/server/src/server/agent/providers/acp-agent.ts:1611-1618`). O wire é JSON-RPC/NDJSON de stdin/stdout, não WebSocket nem transcript.

Essa é a explicação de escala contra o Orca. O Orca paga uma integração por formato de arquivo e por
TUI; o Paseo paga um adapter genérico e exige que o CLI fale ACP.

## 4. O que “suporta” significa e qual é o número real

Há três classes, não 38 integrações equivalentes:

| classe no commit    | quantidade | o que existe                                                                                                                          |
| ------------------- | ---------: | ------------------------------------------------------------------------------------------------------------------------------------- |
| embutidos dedicados |      **6** | Claude, Codex, Copilot, OpenCode, Pi, OMP; manifesto em `packages/protocol/src/provider-manifest.ts:197-258`                          |
| catálogo ACP        |     **36** | comandos versionados em `packages/app/src/data/acp-provider-catalog.ts:12-361`                                                        |
| custom ACP          |  ilimitado | qualquer config `extends: "acp"` com `command` não vazio, validada em `packages/server/src/server/agent/provider-registry.ts:727-746` |

Uma entrada do catálogo não é “só lançada”. A UI a materializa como provider `extends: "acp"`, com
comando, ambiente e parâmetros (`packages/app/src/hooks/use-acp-provider-catalog.ts:11-25`). O
registro então cria `GenericACPAgentClient`, que herda toda a sessão, streaming, modelos, modos,
permissions e persistência de `ACPAgentClient`
(`packages/server/src/server/agent/providers/generic-acp-agent.ts:56-79`). Cursor, Kimi, Kiro e
TRAE ganham adapters especializados; as outras 32 usam o genérico
(`packages/server/src/server/agent/provider-registry.ts:741-794`).

Logo há **6 integrações de primeira classe no sentido de código próprio**. Há **42 nomes suportados
no total bruto atual (6 + 36)**, embora a documentação pública destaque só quatro como nativos e
conte Copilot novamente na lista ACP. “42” não significa 42 backends distintos: 36 compartilham a
mesma implementação e quatro apenas refinam essa base. A propaganda “38” está atrasada em relação ao
commit lido, não descreve um limite arquitetural.

As diferenças funcionais continuam reais. O genérico anuncia um conjunto comum de capabilities, mas
permite desligar MCP e ajustar capabilities por provider
(`packages/server/src/server/agent/providers/generic-acp-agent.ts:21-35,164-168`). A
descoberta real de modelo, modos e config vem da resposta da sessão ACP
(`packages/server/src/server/agent/providers/acp-agent.ts:641-707,2531-2547`). Um CLI que não anuncia algo não o ganha por estar no catálogo.

## 5. Como o modo de permissão chega ao agente

Não há uma resposta única porque a UI normaliza mecanismos do runtime:

- **ACP:** modos disponíveis vêm de `session/new`/config e a seleção volta por
  `setSessionMode` ou `setSessionConfigOption` (`packages/server/src/server/agent/providers/acp-agent.ts:641-673,1816-1845`). “Auto Accept” é uma
  feature local do cliente que apenas escolhe uma opção allow quando recebe
  `requestPermission` (`packages/server/src/server/agent/providers/acp-agent.ts:734-747,2212-2225`).
- **Codex embutido:** `full-access` vira `approvalPolicy: "never"` e sandbox
  `danger-full-access` nos parâmetros do app-server
  (`packages/server/src/server/agent/providers/codex-app-server-agent.ts:264-285,4785-4810`).
- **OMP embutido:** modo é flag de lançamento: `--approval-mode yolo|write|always-ask`
  (`packages/server/src/server/agent/providers/omp/provider-config.ts:35-53`).
- **Claude embutido:** a sessão do SDK recebe `permissionMode`, inclusive bypass
  (`packages/server/src/server/agent/providers/claude/agent.ts:2299-2309,3115-3124`).

Portanto a leitura do screenshot estava certa: Paseo controla lançamento e/ou configuração
estruturada por provider. Mas isso confirma nossa conclusão, não a supera. O cliente consegue pedir
um modo; o runtime continua sendo quem aplica esse modo e quem decide se emitirá uma request antes da
ação. Sem request, o handler ACP do Paseo não participa.

## 6. Como observa subagentes

O contador mistura duas fontes normalizadas em uma mesma track: subagentes que são agentes Paseo e
subagentes internos reportados pelo provider. A apresentação conta todas as linhas e depois as que
têm status `running`, produzindo exatamente `N subagents · M running`
(`packages/app/src/subagents/track-presentation.ts:42-54`).

Os subagentes internos são **adapters por provider, não uma capability ACP genérica**:

- Claude combina eventos ao vivo com replay de arquivos próprios; o replay lê
  `<session>/subagents/agent-<id>.jsonl` e o sidecar meta
  (`packages/server/src/server/agent/providers/claude/subagents/replay-source.ts:10-17`).
- Codex traduz threads/itens do app-server em eventos `provider_subagent` com id, título, descrição,
  estado e timeline (`packages/server/src/server/agent/providers/codex-app-server-agent.ts:5333-5377`).
- OpenCode descobre sessões filhas via seu SDK e hidrata mensagens/timeline
  (`packages/server/src/server/agent/providers/opencode-agent.ts:3694-3731,3763-3774`).
- OMP mantém um índice próprio de subagentes e emite o mesmo vocabulário
  (`packages/server/src/server/agent/providers/omp/subagent-index.ts:43-60,96-116`).

O `ACPAgentClient` genérico traduz os updates ACP padrão listados em `packages/server/src/server/agent/providers/acp-agent.ts:2612-2675`; não há
ali um caso `provider_subagent`. Assim, um agente do catálogo pode mostrar uma chamada de ferramenta
de subagente como tool call, mas não ganha automaticamente a track rica e navegável dos providers
com adapter. Esse é um exemplo concreto de por que “36 no catálogo” não equivale a 36 integrações
dedicadas.

## O que muda na conclusão sobre ACP

Muda a confiança sobre **viabilidade e escala**: o Paseo é evidência de produção de que ACP elimina o
custo de quatro decodificadores de transcript e de digitação frágil no PTY, enquanto preserva
streaming, prompts, modelos, modos, esforço, comandos e requests de permissão. A diferença de alcance
contra o Orca é real e vem do protocolo.

Não muda a conclusão sobre **enforcement** nem a fronteira arquitetural já encontrada. O próprio
Paseo mantém seis adapters embutidos, modos específicos por runtime e observação de subagente
específica. ACP é uma excelente porta de conversa e configuração, mas não transforma toda execução
de tool em uma decisão do cliente. Para Tachyon, continua valendo: ACP chat é uma segunda espécie de
agente controlada pelo cliente; enforcement uniforme ainda exige configuração específica ou sandbox
externa ao processo.
