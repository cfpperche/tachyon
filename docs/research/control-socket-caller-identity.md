# Identidade do chamador no control socket

**Veredito: cabe com mudança.** Hoje o daemon consegue distinguir sessões de shell, mas não consegue recuperar uma identidade confiável do chamador nem distinguir humano de agente. O transporte já tem um handshake `attach` e um token aleatório por sessão; portanto há uma junta natural para carregar uma identidade autenticada sem reescrever o framing JSON/newline nem a forma de `invoke`. O token atual, porém, nasce depois de uma autenticação feita somente pelo nonce compartilhado e não prova quem abriu a sessão.

## 1. O que o transporte carrega hoje?

Ele carrega três sinais, mas nenhum identifica de modo confiável a pessoa ou o agente:

1. **Credencial de peer do sistema operacional: não.** O servidor cria um `net.Server` e recebe apenas o `net.Socket`; o callback não lê PID, UID ou credenciais do peer (`src/engine-service/controlServer.ts:107-116`). Não há uso de `SO_PEERCRED`, `LOCAL_PEERCRED`, `getPeerCredentials` ou equivalente no repositório. O UID só é consultado ao validar o *arquivo* lateral do nonce, não a conexão: o arquivo deve pertencer ao UID corrente e não pode ter bits de grupo/outros (`src/engine-service/controlPeerAuth.ts:23-32`). Isso prova que quem lê o segredo está no mesmo domínio de arquivos do UID, não qual processo conectou.

2. **Nonce compartilhado: sim, em toda conexão.** O daemon cria uma única sequência aleatória de 32 bytes e a grava em `<socket>.nonce` com modo `0600` (`src/engine-service/controlPeerAuth.ts:4-20`). Cada request abre uma conexão nova, lê esse mesmo arquivo e acrescenta `controlNonce` ao objeto JSON (`src/engine-service/controlClient.ts:355-364`, `src/engine-service/controlClient.ts:402-416`). O servidor compara esse campo em tempo constante, o remove e só então faz o parse do protocolo (`src/engine-service/controlServer.ts:377-385`). Portanto o nonce autentica posse de um segredo comum ao UID, não uma conexão nem um agente.

3. **Handshake e token por sessão de shell: sim.** O protocolo possui `attach`; os demais requests relevantes carregam `shellId` e `sessionToken` (`src/engine-service/protocol.ts:599-610`). No `attach`, `shell.id`, versão, locale, capacidades e digest de settings são dados pelo próprio cliente (`src/engine-service/protocol.ts:167-180`). O servidor calcula um fingerprint desses dados e emite um token aleatório de 32 bytes para a sessão (`src/engine-service/controlServer.ts:185-215`, `src/engine-service/controlServer.ts:498-506`). Depois, `query` e `invoke` exigem que `shellId` e token coincidam com uma sessão viva (`src/engine-service/controlServer.ts:218-235`, `src/engine-service/controlServer.ts:485-495`).

O token de sessão distingue uma sessão de outra, mas **não estabelece a identidade do ator**. `attach` também é autorizado apenas pelo nonce comum; qualquer processo que o leia pode declarar seu próprio `shell.id`, capacidades e demais campos e receber um token novo. O cliente oficial faz exatamente esse fluxo: cria por padrão um UUID local para `shell.id`, monta o hello e chama `attach` (`src/shell/WorkspaceClient.ts:201-230`, `src/shell/WorkspaceClient.ts:535-551`). Não há registro confiável de agente resolvido durante esse handshake.

Consequentemente, quando `extension.invoke` chega à lógica de domínio, o máximo que o servidor transportou adiante foi `shellId` e `operationId`: `invokeOnce` chama `options.invoke(command, { shellId, operationId })` (`src/engine-service/controlServer.ts:291-321`). A execução de `extension.invoke` não recebe nem verifica origem adicional (`src/engine-service/engineService.ts:713-718`), e as sete ações `soul.profile.*` são executadas diretamente (`src/engine-service/extensionOperationService.ts:611-633`).

No encadeamento de produção há ainda uma perda explícita: ao instalar o servidor, `engineService` fornece um callback `invoke` que aceita somente `command` e chama `executeWorkspaceCommand` sem o contexto de sessão (`src/engine-service/engineService.ts:439-459`). Portanto nem mesmo o `shellId` que o servidor conhece chega hoje à execução da ação.

## 2. Se não há identidade hoje, ela cabe naturalmente?

**Sim.** O lugar natural já existente é a fronteira `attach` → sessão → `invoke`, não uma reescrita do protocolo:

- `attach` já é o handshake que valida o hello, negocia a versão e cria o registro de sessão (`src/engine-service/controlServer.ts:185-215`);
- o registro `LiveShellSession` já guarda estado associado à sessão (`src/engine-service/controlServer.ts:72-77`);
- cada `invoke` já precisa apresentar o token dessa sessão (`src/engine-service/protocol.ts:605-609`) e o servidor já encaminha contexto de sessão para `options.invoke` (`src/engine-service/controlServer.ts:291-321`).

Assim, existe uma junta protocolar onde uma identidade autenticada poderia ser estabelecida uma vez e depois recuperada pelo token nos requests seguintes. Isso exigiria mudança de autenticação/contrato — o hello atual é autoafirmado e o nonce autoriza qualquer cliente same-uid —, mas não exige substituir o framing de um JSON terminado por newline, abrir conexão persistente ou criar uma segunda forma de `extension.invoke`. Este é apenas o resultado de encaixe: não define qual credencial, emissor ou política deveria ocupar a junta.

## 3. O extension host distingue UI do VS Code de agente com shell?

**Localmente, sim; no daemon, hoje, não.**

No extension host, uma ação humana do Agent Studio entra como mensagem do webview e é despachada por tipo. As ações de Soul chamam explicitamente os métodos do `WorkspaceAgentStudioTarget` (`src/cockpit/agentStudioDomain.ts:135-151`). O `WorkspaceShellHandle` usado pela extensão delega esses métodos ao `ClientWorkspaceStudioTarget` (`src/shell/WorkspaceShellHandle.ts:48-66`, `src/shell/WorkspaceShellHandle.ts:116-124`), que os converte em `extension.invoke` (`src/shell/ClientWorkspaceStudioTarget.ts:400-430`, `src/shell/ClientWorkspaceStudioTarget.ts:523-535`). Portanto, enquanto ainda está executando o callback/manejador do VS Code, o extension host sabe que o gesto veio de sua porta local de UI: é a própria pilha de chamada.

Um agente com shell não passa por essa pilha. Ele pode abrir o socket diretamente, fazer seu próprio `attach` e enviar `invoke`, porque cada request é uma conexão independente (`src/engine-service/controlClient.ts:355-416`). O daemon recebe ambas as origens na mesma porta e, após autenticar o token da sessão, entrega apenas `shellId` e `operationId` à camada seguinte (`src/engine-service/controlServer.ts:218-235`, `src/engine-service/controlServer.ts:291-321`). Como a sessão do extension host não é marcada por uma credencial exclusiva e confiável, essa distinção observável dentro do extension host se perde ao cruzar o socket.

Resumo por porta:

| Ator / gatilho | O que é observável hoje | O que o daemon pode concluir |
| --- | --- | --- |
| Interface / mensagem do webview | O extension host está no handler local de UI antes de chamar `WorkspaceShellHandle`. | Depois do socket, apenas que um token válido de alguma sessão de shell foi apresentado. |
| Agente / `attach` + `invoke` direto | Não entra no extension host; declara um hello e recebe sua própria sessão usando o nonce comum. | Depois do socket, apenas que um token válido dessa sessão foi apresentado. |
| Tachyon / callback de comando instalado no daemon | A porta de produção liga o control server diretamente a `executeWorkspaceCommand` (`src/engine-service/engineService.ts:439-459`). | Não há ator adicional no contexto: o callback descarta até o `shellId` fornecido pelo control server. |

Logo, a resposta operacional para as sete mutações é: **o extension host poderia marcar a origem enquanto ainda atende a UI, mas o protocolo atual não preserva uma prova dessa origem; o daemon não consegue reconstruí-la a partir de `shellId`, `sessionToken` ou nonce.**
