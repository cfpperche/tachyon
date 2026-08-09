# Custo das tools do Integrated Browser (`t-c0d92a`)

**A premissa “8 de 78” está errada hoje.** Em 2026-08-06, `tools/list` da Bridge usada por este
agente devolveu **116 tools**, das quais as mesmas **8** são do Integrated Browser (6,9%). Até a
contagem unitária do núcleo já está em **80**, não 78 (`test/unit/auth.test.ts:101,114`).

## Tokens

Medição diferencial com dois catálogos MCP locais: a resposta real de `tools/list` (116 tools) e a
mesma resposta sem exatamente `ide_browser_status|navigate|screenshot|snapshot|eval|click|url` e
`design_mode_chat_reply` (108 tools). O prompt, modelo, configuração e resposta (`OK`) foram iguais;
somei input novo + cache criado + cache lido, pois a divisão de cache muda sem mudar o contexto.

| Runtime medido | Catálogo completo | Sem as 8 | Custo das 8 |
|---|---:|---:|---:|
| Claude Code 2.1.223 | 22.341 | 22.209 | **132 tokens** |
| Codex CLI 0.146.1 | 15.233 | 15.233 | **0 tokens** |
| Grok 0.2.118 | 11.232 | 11.232 | **0 tokens** |

Claude repetiu cada lado duas vezes com o mesmo resultado. Codex repetiu dois pares estabilizados
com o mesmo resultado. Grok completou um par com homes novos antes de a credencial local deixar de
estar disponível; portanto o zero de Grok é uma medição única, não uma estimativa. Os oito schemas
ocupam 4.473 bytes em JSON, mas Codex e Grok não os cobraram no contexto inicial observado — ambos
usam descoberta/lazy loading de tools — e Claude cobrou só a representação compacta.

## Chamada com a feature desligada

Chamei `ide_browser_status` de verdade por esta sessão MCP, com
`settings.ideBrowser.enabled` desligado. A tool continua chamável e retorna `isError: true` com uma
recusa clara e acionável:

```text
error: Integrated Browser is disabled. Set settings.ideBrowser.enabled: true in tachyon.yml (Control → Settings), then open the globe icon.
```

Isso ainda oferece uma capacidade que a leitura depois recusa, mas não produz tool ausente nem erro
obscuro: distingue “feature desligada” de “bridge offline” e diz exatamente qual decisão humana muda
o estado.

**Recomendação:** não desregistrar; 132 tokens apenas no Claude e zero observado nos outros dois são ruído, e a recusa atual é clara.
