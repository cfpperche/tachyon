# 386 — dogfood

## Build (já feito no worktree)

```bash
cd /home/goat/tachyon-worktrees/agent-live-resource-metrics
# node_modules → monorepo ok
npm run build
```

## Opção A — frota real (recomendado para ver CPU/mem)

Abre o monorepo com a extensão do worktree (agentes reais com pane pid):

```bash
# binário VS Code local / test
CODE=$(node /home/goat/tachyon-worktrees/agent-live-resource-metrics/scripts/dev-host/resolve-code.mjs /home/goat/tachyon-worktrees/agent-live-resource-metrics)
"$CODE" \
  --extensionDevelopmentPath=/home/goat/tachyon-worktrees/agent-live-resource-metrics \
  /home/goat/tachyon
```

Ou no monorepo VS Code: adicionar temporariamente um launch “Extension Development Path” apontando o worktree.

## Opção B — Dev Host F5 (fixture isolado)

```bash
cd /home/goat/tachyon
export TACHYON_DEV_HOST_ID=metrics-386
npm run dogfood:dev-host -- seed
npm run dogfood:dev-host -- point \
  --worktree /home/goat/tachyon-worktrees/agent-live-resource-metrics \
  --workspace /tmp/tachyon-dev-host/metrics-386/workspace \
  --spec 386 --slug agent-live-resource-metrics
# Run and Debug → Tachyon: Dev Host → F5
```

Fixture agents (`echo`) mostram pouca CPU; serve para UI (toggle/peek/gutter).

## Checklist

1. Agente **running** → peek `N% · XM` (CPU após 2º refresh do fleet ~1–2s)
2. **▤** expande L3 CPU + L4 Mem
3. Chevron **▾** esquerdo só colapsa **filhos** (independente de métricas)
4. Header: **Expand metrics** / **Collapse metrics**
5. Hover: toolbar L1 sem cobrir o nome
6. Stopped: sem peek / sem ▤

## Branch

`grok/agent-live-resource-metrics` @ `/home/goat/tachyon-worktrees/agent-live-resource-metrics`  
Commit: `933be09e` (feat 386)
