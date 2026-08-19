# Medição de quota por runtime

Pesquisa para o cartão `t-4c6e14`, feita em 2026-08-19. O objetivo foi explicar o
resultado do Runtime Ops e comparar mecanismos públicos; não foi feita alteração
de código.

## Resumo executivo

Codex e Grok mostram uma janela por motivos diferentes, e a tela está correta nas
duas leituras observadas:

* **Codex:** a resposta bruta desta conta trouxe uma única janela no campo
  `rateLimits.primary`, mas ela era semanal (`windowDurationMins: 10080`), e
  `secondary` era `null`. Portanto não perdemos uma janela de sessão no caminho.
  A resposta também trouxe uma janela semanal separada para o limite de
  `GPT-5.3-Codex-Spark`; a fonte atual mapeia apenas `primary`/`secondary` do
  limite principal, então essa janela específica não aparece na tela.
* **Grok:** a resposta bruta trouxe um único `currentPeriod` semanal. Não há uma
  segunda janela para o projetor descartar; a tela reflete o control plane.

Isso não prova que cada conta ou plano sempre tenha uma janela: prova o payload
observado nesta coleta. A diferença importante é que Codex tem slots e limites
adicionais no protocolo, enquanto Grok expôs somente um período nesta leitura.

## 1. Evidência bruta das fontes

### Codex

Foi executado o app-server em modo read-only, com a sequência
`initialize` → `account/read` sem refresh → `account/rateLimits/read`. A chamada é
de control plane e não inicia turno de inferência. Para não registrar identidade,
tokens ou outros dados da conta, o coletor de pesquisa imprimiu somente o objeto
retornado por `account/rateLimits/read`:

```json
{
  "rateLimits": {
    "limitId": "codex",
    "limitName": null,
    "primary": {
      "usedPercent": 90,
      "windowDurationMins": 10080,
      "resetsAt": 1787226082
    },
    "secondary": null,
    "credits": {
      "hasCredits": false,
      "unlimited": false,
      "balance": "0"
    },
    "individualLimit": null,
    "spendControlReached": false,
    "planType": "prolite",
    "rateLimitReachedType": null
  },
  "rateLimitsByLimitId": {
    "codex_bengalfox": {
      "limitId": "codex_bengalfox",
      "limitName": "GPT-5.3-Codex-Spark",
      "primary": {
        "usedPercent": 0,
        "windowDurationMins": 10080,
        "resetsAt": 1787764476
      },
      "secondary": null,
      "credits": null,
      "individualLimit": null,
      "spendControlReached": null,
      "planType": "prolite",
      "rateLimitReachedType": null
    },
    "codex": {
      "limitId": "codex",
      "limitName": null,
      "primary": {
        "usedPercent": 90,
        "windowDurationMins": 10080,
        "resetsAt": 1787226082
      },
      "secondary": null,
      "credits": {
        "hasCredits": false,
        "unlimited": false,
        "balance": "0"
      },
      "individualLimit": null,
      "spendControlReached": false,
      "planType": "prolite",
      "rateLimitReachedType": null
    }
  },
  "rateLimitResetCredits": {
    "availableCount": 0,
    "credits": []
  }
}
```

`10080` minutos = 7 dias, portanto a única janela principal é semanal. O
projetor local aceita `primary` como `session` ou `weekly` conforme a duração,
aceita `secondary` como a segunda janela e ordena semanticamente as duas. Ele
também rejeita payload sem janelas. Os testes locais cobrem payload com ambas,
somente `secondary` semanal e somente `primary` semanal; a fixture sintética está
em `test/fixtures/codex-app-server-rate-limits-v0.144.4.json`.

**Conclusão Codex:** o provedor não devolveu uma janela de 5 horas nesta coleta;
não há perda entre a resposta e a tela. Há, porém, um limite adicional por modelo
(`GPT-5.3-Codex-Spark`) que o contrato neutro atual não projeta.

### Grok

Foi executado `grok agent --no-leader stdio` e enviado somente o pedido ACP
`_x.ai/billing`, após `initialize`. É o mesmo control plane usado por `/usage` e
não consome turno de inferência. A saída de pesquisa reteve apenas o trecho de
quota do resultado, excluindo campos não necessários:

```json
{
  "config": {
    "creditUsagePercent": 94,
    "currentPeriod": {
      "type": "USAGE_PERIOD_TYPE_WEEKLY",
      "start": "2026-08-17T08:28:21.629738+00:00",
      "end": "2026-08-24T08:28:21.629738+00:00"
    }
  }
}
```

O projetor exige percentual e período semanal, calcula o reset a partir de
`currentPeriod.end` e emite uma janela `weekly`. Ele recusa período diário,
percentual ausente ou denominador inventado. Não existe um segundo período neste
payload.

**Conclusão Grok:** o control plane devolveu apenas um período semanal; a tela
não está escondendo uma segunda janela.

## 2. Como as plataformas abertas fazem

### Amostra e critério

O diretório `~/tachyon-ade-bench/competitors/` contém 24 catálogos. Considerei
“mede quota” somente evidência explícita de quota/uso de provedor, janela ou
reset — não menções genéricas a estatísticas, créditos comerciais ou uso de
tokens. A leitura foi documental, sem instalar concorrentes, sem login e sem
ler credenciais.

Entre os catálogos de fonte aberta avaliados (OpenADE, Emdash, Orca, Hive,
Kandev e Compozy), encontrei evidência suficiente em **Orca e Kandev**. Os
outros quatro têm fontes abertas, mas seus catálogos não documentam um medidor
de quota de provedor. Assim, a amostra é: **6 plataformas OSS ADE; 2 com
mecanismo de quota documentado; 4 sem fonte suficiente**. CodexBar é incluído
abaixo como ferramenta OSS adjacente usada por Kandev, não como um sétimo ADE.

| Plataforma | Mecanismo observado | Janelas/medida | Frescor | Credencial |
|---|---|---|---|---|
| **Orca** (MIT) | Serviço de rate-limit do app; o repositório anuncia account switcher e usage tracking. A documentação pública e issues mostram refresh em background e, para Codex, `account/rateLimits/read` com fallback PTY histórico. | Claude e Codex; o pedido público de transparência cita 5h, weekly e Fable para Claude, mas também confirma que Codex/Grok podem aparecer somente weekly. Modelos/contas podem ter limites extras. | Refresh em background; issue pública descreve cadência de 15 min. | Usa contas/homes locais gerenciados pelo Orca; issue mostra que o caminho Claude pode criar `~/.claude` durante refresh mesmo desabilitado. |
| **Kandev + plugin provider-usage** (MIT) | Poller local chama binário OSS CodexBar; Augment é exceção e usa Analytics API própria. O snapshot é servido pela UI. | CodexBar expõe janelas por provedor, incluindo 5h, weekly, monthly e outras; Augment mostra consumo mensal contra orçamento, média/dia e projeção. | Poll configurável, padrão 5 min; refresh manual também existe. | CodexBar usa credenciais OAuth locais (`~/.claude`, `~/.codex`, etc.); Augment requer token de Analytics e e-mail da organização. |
| **CodexBar** (ferramenta OSS, não ADE) | CLI multi-provedor com fontes `oauth` rápidas e fallback CLI; cache local. | O catálogo público lista, entre outros: Codex session/weekly/credits, Claude 5h/weekly, Kimi 5h/weekly, Kiro monthly credits, Copilot usage e múltiplas quotas de outros provedores. | Cache nativo; no plugin Kandev a leitura ocorre a cada poucos minutos. | Varia: OAuth, CLI local, cookies, API key ou config local; é declarada por provedor. |

**O que os outros quatro catálogos OSS permitem afirmar:** OpenADE menciona
“usage stats/scoreboards”, Emdash documenta agentes e worktrees, Hive documenta
processos PTY e autenticação do CLI, e Compozy documenta observabilidade de
tool-usage. Nenhum desses textos é evidência de quota de provedor, janelas ou
reset. Eles ficam na amostra “sem fonte”, não foram classificados como “não
mede” em definitivo.

## 3. Estamos pior?

Não há um vencedor absoluto; os mecanismos medem coisas diferentes.

| Eixo | Tachyon | Orca | Kandev/CodexBar |
|---|---|---|---|
| Sessão rodando | Codex e Grok não; Claude sim, porque a fonte é status-line de sessão viva. | Background para Codex/Claude, sujeito ao caminho de autenticação. | Não para fontes OAuth/HTTP; fallback CLI pode depender do CLI, mas não de um turno. |
| Consome inferência | Não: app-server read-only, billing ACP e status-line. | O caminho documentado de quota é separado do turno, mas fallback PTY é mais frágil. | Não para OAuth/Analytics; a ferramenta declara fallback CLI. |
| Guarda credencial | Codex/Grok deixam credencial no CLI; Tachyon recebe só projeção neutra e exige grant explícito. | Pode gerenciar homes/contas locais e tem risco de efeitos colaterais no refresh. | Lê credenciais locais; Augment adiciona token de serviço, guardado pelo plugin. |
| Janelas | Projeta as janelas retornadas, hoje uma no Codex e uma no Grok; não inventa ausentes. Claude pode trazer duas. | Mais detalhes e contas em alguns provedores, mas há casos de ambiguidade/refresh falho. | Mais ampla cobertura e várias janelas por provedor; inclui extras/modelos quando a fonte suporta. |
| Falha | Emite `provider-unavailable` com motivo; não transforma ausência em zero. | Pode mostrar refresh failed/PTY timeout e há issue pedindo distinção explícita entre ausente, não suportado e falha. | Snapshot pode ficar indisponível; o plugin tem fallback de provedor/CLI e status de integração. |

Estamos melhores em minimização de autoridade: não guardamos credencial nem
fazemos inferência para consultar quota, exigimos consentimento e distinguimos
indisponível de percentual. Estamos piores em cobertura de janelas/modelos e na
dependência do status-line do Claude, que exige uma sessão já rodando. Orca e
CodexBar estão melhores em amplitude porque investem em adaptadores específicos
por provedor; isso aumenta superfície, manutenção e, no caso de cookies/tokens,
risco de credencial.

## O QUE NÃO DEU PARA MEDIR

* **Codex em outras contas/planos:** a coleta é uma conta `prolite`, em um
  instante; não permite generalizar a ausência da janela de 5h.
* **Codex Spark na tela:** o payload trouxe limite adicional, mas não foi medido
  o caminho de projeção/UI para saber se existe outra tela deliberada.
* **Grok além do período atual:** não houve evidência de uma janela diária,
  mensal ou por modelo no payload; não é possível afirmar que o provedor nunca
  ofereça uma em outro plano.
* **Claude sem sessão:** o código e a descrição da fonte dizem que a quota vem
  da status-line de sessão viva; não foi iniciada uma sessão somente para testar
  isso, e `claude auth status --json` não foi chamado.
* **Orca:** não foi instalado nem executado. Cadência, fallback e efeitos de
  autenticação vêm de documentação/issue pública; não foi feita medição da UI
  nem de todas as janelas por provedor.
* **OpenADE, Emdash, Hive e Compozy:** os catálogos não fornecem um mecanismo de
  quota verificável. Não foi feita instalação nem inspeção exaustiva de cada
  repositório para procurar uma implementação escondida.
* **Os 18 catálogos restantes:** não foram tratados como plataformas abertas de
  quota nesta amostra; os registros têm sinais de pricing, uso ou billing, mas
  não evidência suficiente de um medidor comparável.
* **Frescor real de cada fornecedor:** resets e percentuais são instantâneos da
  leitura; não foi feito estudo longitudinal nem comparação contra o dashboard
  de cada provedor.

## Fontes consultadas

* Código local: `packages/engine/src/runtimeObservability/codexAppServerSource.ts`,
  `grokUsageSource.ts`, `claudeStatusLineSource.ts`, `types.ts` e os testes
  correspondentes.
* Catálogos locais: `~/tachyon-ade-bench/competitors/*.json` (24 arquivos),
  especialmente `openade.json`, `emdash.json`, `orca.json`, `hive.json`,
  `kandev.json` e `compozy.json`.
* [Orca README e usage tracking](https://github.com/stablyai/orca), [Orca issue de
  refresh/credencial Claude](https://github.com/stablyai/orca/issues/12181), e
  [Orca pedido de transparência de janelas](https://github.com/stablyai/orca/issues/12820).
* [Kandev provider-usage](https://github.com/kdlbs/kandev-plugin-provider-usage) e
  [CodexBar documentação de Codex](https://github.com/bcharleson/codexbar/blob/main/docs/codex.md),
  [provedores](https://github.com/bcharleson/codexbar/blob/main/docs/providers.md).
