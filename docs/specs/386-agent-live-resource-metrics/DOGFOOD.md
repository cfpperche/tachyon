# 386 — dogfood via Dev Host (F5)

**Status prep:** armado 2026-07-14 (corrigido após F5 falhar sem fixture/point).

## Já preparado

| Item | Valor |
|---|---|
| Worktree (extensão) | `/home/goat/tachyon-worktrees/agent-live-resource-metrics` |
| Point monorepo | `~/tachyon/.tachyon/dev-host/extension` → worktree |
| Fixture workspace | `/tmp/tachyon-dev-host/metrics-386/workspace` |
| preLaunch dry-run | exit 0 |

> **Não** use a raiz do monorepo como workspace do EDH — o point recusa. O F5 abre o **fixture**.

## O que você faz

1. No monorepo VS Code (`~/tachyon`)
2. **Run and Debug** → **`Tachyon: Dev Host`** (não “Run Tachyon”)
3. **F5**
4. Janela **`[Extension Development Host]`** com folder do fixture (não a frota monorepo)

## Checklist UI (fixture)

Fixture tem agents `pilot` / `reviewer` (`echo`) — CPU baixa, mas:

1. Se running com pane: peek / ▤ / lanes (pode precisar **Start** no agent)
2. Expand metrics / Collapse metrics no header Agents
3. Chevron ▾ esquerdo (se houver filhos) ≠ ▤ métricas
4. Hover toolbar sem cobrir o nome

Para **CPU real**, use frota monorepo com EDH apontando o worktree (opcional):

```bash
CODE=$(node /home/goat/tachyon-worktrees/agent-live-resource-metrics/scripts/dev-host/resolve-code.mjs /home/goat/tachyon-worktrees/agent-live-resource-metrics)
"$CODE" \
  --extensionDevelopmentPath=/home/goat/tachyon-worktrees/agent-live-resource-metrics \
  /home/goat/tachyon
```

## Se F5 falhar de novo

```bash
export TACHYON_DEV_HOST_ID=metrics-386
cd /home/goat/tachyon
bash scripts/dev-host/cli.sh seed
bash scripts/dev-host/cli.sh point \
  --worktree /home/goat/tachyon-worktrees/agent-live-resource-metrics \
  --workspace /tmp/tachyon-dev-host/metrics-386/workspace \
  --spec 386 --slug agent-live-resource-metrics
# Show Errors no dialog do preLaunch se ainda falhar
```

## Cleanup (depois)

```bash
# fechar EDH primeiro
export TACHYON_DEV_HOST_ID=metrics-386
cd /home/goat/tachyon
npm run dogfood:dev-host -- clean
npm run dogfood:dev-host -- point-clear
```
