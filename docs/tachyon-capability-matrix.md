# Matriz de capacidades do Tachyon

Este documento classifica as capacidades do Tachyon em dois eixos independentes:

- **Infraestrutura:** executa, persiste, isola, conecta e observa.
- **Governança:** define autoridade, contratos, evidências, aprovações e recuperação.

Um mesmo domínio pode conter as duas camadas. Uma worktree, por exemplo, é infraestrutura; impedir sua
integração ou remoção sem autoridade e evidência suficiente é governança.

## Legenda de alcance

| Alcance | Significado |
|---|---|
| **Qualquer — padrão** | Faz parte do produto para qualquer projeto que use a superfície correspondente. |
| **Qualquer — opt-in** | Está disponível a qualquer usuário, mas precisa ser ativado, configurado ou invocado. |
| **Somente Tachyon** | É uma política ou ferramenta usada para desenvolver o próprio repositório Tachyon. |
| **Release Tachyon** | É parte do processo específico de empacotamento e lançamento do Tachyon. |

## Capacidades de infraestrutura

| Capacidade | O que fornece | Alcance | Pode ser desligada? |
|---|---|---|---|
| Engine persistente | Orquestração independente da janela do VS Code. | **Qualquer — padrão** | Não; é o núcleo do produto. |
| Shell VS Code | Sidebar, Control, Activity, Studios, comandos e terminais. | **Qualquer — padrão** | O shell distribuído atualmente é o VS Code. |
| Sessões tmux | Persistência de processos, reattach e captura de saída. | **Qualquer — padrão** | Não para processos gerenciados. |
| Bridge MCP | API local para agentes controlarem o workspace. | **Qualquer — padrão** | O Bridge é estrutural; sua autenticação é configurável. |
| Adaptação de runtimes | Integra Claude, Codex, Pi, Grok, OpenCode e outros por mecanismos nativos. | **Qualquer — padrão** | A disponibilidade de algumas operações depende do runtime. |
| Lifecycle | Start, stop, restart, resume, fork e postmortem. | **Qualquer — padrão** | Algumas operações são opcionais ou dependentes do runtime. |
| Multiagente | Spawn, lineage, wait, read e write entre agentes. | **Qualquer — padrão** | O usuário pode simplesmente não delegar. |
| Atenção | Detecta prompts, idle, crashes e necessidade humana. | **Qualquer — padrão/configurável** | Sim, por agente ou terminal. |
| Activity | Histórico operacional de agentes e ações. | **Qualquer — padrão** | A visualização pode não ser usada. |
| Isolamento de transcript | Namespace de conversa separado por agente. | **Qualquer — opt-in** | Sim. |
| Harness isolado | MCPs, skills, regras e hooks por agente. | **Qualquer — opt-in** | Sim. |
| Worktree isolada | Checkout e branch separados — **local de trabalho, não confinamento de escrita**. O agente recebe a worktree e a instrução de ficar nela; nenhum runtime medido impõe essa fronteira, e o Pi não tem sandbox nenhum. Ver [paridade, dimensão 22](runtimes/parity.md). | **Qualquer — opt-in** | Sim. |
| Delivery canônica | Uma worktree reutilizada sequencialmente pelos participantes da mesma mudança. | **Qualquer — governado** | Pode ser evitada usando delegação sem `gate`. |
| Commands | Comandos curados acionados por humanos ou agentes. | **Qualquer — opt-in** | Sim. |
| Runbooks | Procedimentos sequenciais com resultado por etapa. | **Qualquer — opt-in** | Sim. |
| Pipelines | Encadeamento de agentes e comandos. | **Qualquer — opt-in** | Sim. |
| Schedules | Execuções temporizadas enquanto o workspace está aberto. | **Qualquer — opt-in** | Sim. |
| Multi-root | Engine, Bridge e estado separados por pasta. | **Qualquer — padrão** | Só entra em efeito quando um workspace multi-root é usado. |
| Plugins e skills | Capacidades adicionais materializadas por projeto ou agente. | **Qualquer — opt-in** | Sim. |
| File watching | Reload de configuração e restart por alteração. | **Qualquer — padrão/configurável** | O watch de processos é opt-in. |
| Estado durável | Tasks, handoff, continuidade, pins e sessões. | **Qualquer — disponível** | Cada superfície é opcional. |

## Capacidades de governança

| Capacidade | O que governa | Alcance | Obrigatória? |
|---|---|---|---|
| Identidade do Bridge | Quem realmente realizou uma chamada. | **Qualquer — padrão** | Para ações privilegiadas, sim. |
| Autorização por agente | Impede um agente de se declarar como outro. | **Qualquer — padrão** | Sim nas superfícies protegidas. |
| `maxAgents` | Limite de concorrência da frota. | **Qualquer — padrão/configurável** | Há um limite padrão. |
| Roles e instructions | Contrato operacional entregue ao agente. | **Qualquer — opt-in** | Não. |
| Startup primer | Protocolo básico de operação do agente. | **Qualquer — padrão** | Faz parte dos startups suportados. |
| Project Guidance | Convenções específicas escolhidas pelo projeto. | **Qualquer — opt-in** | Não existem arquivos de projeto implicitamente globais. |
| Board Tasks | Ownership, prioridade, assignee e lifecycle do trabalho. | **Qualquer — opt-in por uso** | Não. |
| Project Handoff | Estado compartilhado e distill concorrência-seguro. | **Qualquer — opt-in por uso** | Não. |
| Continuidade | Estado privado recuperável de cada agente. | **Qualquer — opt-in por uso** | Não. |
| Pins | Checklist leve compartilhado. | **Qualquer — opt-in por uso** | Não concede autoridade. |
| Aprovação humana | Decisões que um agente não pode tomar sozinho. | **Qualquer — disponível** | Somente quando uma operação exige. |
| Propostas de schedule | Um agente propõe e um humano aprova antes de ativar. | **Qualquer — opt-in** | A aprovação é obrigatória para propostas de agentes. |
| Gates de pipeline | Pausa um fluxo aguardando decisão humana. | **Qualquer — opt-in** | Não. |
| Delegação governada | Congela Task, BASE, escopo `owns` e comportamento esperado. | **Qualquer — opt-in via `gate`** | Não. |
| Verificação BASE/HEAD | Prova que uma regressão existe na base e passa no candidato. | **Qualquer — opt-in** | É intrínseca quando esse gate é escolhido. |
| Contrato de verificação congelado | Impede trocar comando ou oráculo durante a delegação. | **Qualquer — governado** | Sim dentro de uma delegação governada. |
| HMAC e freshness | Detecta autoridade adulterada, antiga ou reproduzida. | **Qualquer — governado** | Automática nessa superfície. |
| Lease de Delivery | Mantém um ocupante por Delivery, com handoff sequencial. | **Qualquer — governado** | Automática em Delivery governada. |
| Quarentena | Preserva estado quando ownership ou processo fica ambíguo. | **Qualquer — governado** | Não há bypass silencioso. |
| Git Delivery integration | Define quem pode integrar uma Delivery. | **Qualquer — governado** | Configurável por principals. |
| Git Delivery prune | Define quem pode remover worktree ou branch. | **Qualquer — governado** | Configurável por principals. |
| Salvage, abandon e reconcile | Recuperação explícita de estados anormais. | **Qualquer — governado** | Algumas ações exigem aprovação humana. |
| Verify de worktree | Evidência consultiva associada ao commit. | **Qualquer — opt-in** | Não bloqueia automaticamente. |
| Verify de Task | Evidência hermética de uma delegação governada. | **Qualquer — opt-in** | Só existe quando solicitado e configurado. |

## Matriz específica do sistema de regressões

| Nível | Capacidade | Aplicação | Opt-out |
|---|---|---|---|
| 0 | Sem verificação | Qualquer usuário. | O trabalho permanece `not verified`. |
| 1 | `verify:` de worktree | Qualquer usuário. | Omitir `verify`. |
| 2 | `settings.verify.full`, `typecheck` e `affected` | Qualquer usuário. | Omitir `settings.verify`. |
| 3 | `cmd:<comando>` como behavior gate | Qualquer usuário. | Não criar delegação governada. |
| 4 | Adapter de teste nomeado | Qualquer usuário. | Não configurar `settings.verify.behavior`. |
| 5 | BASE/HEAD e oráculo congelado | Qualquer usuário que escolha `gate`. | Usar delegação sem `gate`. |
| 6 | Product Invariants `PI-*` | **Somente o repositório Tachyon.** | Consumidores não recebem isso por padrão. |
| 7 | Ratificação humana de mudança em PI | **Somente o repositório Tachyon.** | Não é política global do produto. |

## Capacidades exclusivas do repositório Tachyon

| Capacidade ou política | Tipo | Alcance |
|---|---|---|
| Registry `PI-*` | Governança de produto. | **Somente Tachyon** |
| Declaração `Affected Product Invariants` | Governança de desenvolvimento. | **Somente Tachyon** |
| Revisão independente RED/GREEN para PI | Governança de evidência. | **Somente Tachyon** |
| Aprovação do mantenedor para alterar uma promessa PI | Governança de produto. | **Somente Tachyon** |
| `npm run verify:full:quiet` | Infraestrutura de teste escolhida pelo projeto. | **Somente Tachyon** |
| `npm run typecheck` | Infraestrutura de teste escolhida pelo projeto. | **Somente Tachyon** |
| SDD obrigatório para mudanças não triviais | Governança de desenvolvimento. | **Política do Tachyon** |
| `docs/specs/NNN-*` | Histórico e governança do produto. | **Somente Tachyon** |
| Dev Host e dogfood da extensão | Infraestrutura de desenvolvimento. | **Somente Tachyon** |
| Build estável exigindo `HEAD == main == origin/main` | Governança de release. | **Release Tachyon** |
| Proveniência embutida no VSIX | Evidência de release. | **Release Tachyon** |
| Auditoria `.tachyon/deploys/<versão>.json` | Governança de release. | **Release Tachyon** |

## Perfis de adoção

| Perfil | Infraestrutura | Governança |
|---|---|---|
| **Off** | Agentes, tmux, Bridge, Activity e lifecycle. | Sem verify, gate ou regressões. |
| **Advisory** | Worktrees e execução de testes. | Resultados visíveis, mas não bloqueantes. |
| **Governed** | Delivery, clones BASE/HEAD e verificadores. | Escopo congelado, autoridade, leases e recuperação. |
| **Product Contract** | Tudo do perfil Governed. | Product Invariants, revisão independente e ratificação humana. |

Um consumidor pode usar o Tachyon sem adotar o sistema de regressões deste repositório. As proteções de
segurança operacional continuam existindo, mas `PI-*`, SDD obrigatório, revisão RED/GREEN e os comandos npm
do Tachyon são políticas do próprio projeto, não obrigações impostas aos consumidores.

## Referências

- [System Design](system-design.md)
- [README](../README.md)
