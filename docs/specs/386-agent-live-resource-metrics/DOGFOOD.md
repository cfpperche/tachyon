# 386 — dogfood via Dev Host (F5)

## Por que a sidebar “vazia” / sem métricas

1. **Point precisa de fixture** (não monorepo root).
2. Fixture antigo usava `echo` + `autostart: false` → agentes **não ficam running** → **sem peek/CPU/mem** (e parecia “nada”).
3. Fixture atual: `pilot`, `reviewer`, `busy` com **loop + autostart: true**.

## Prep (já refeito)

```text
extension → …/agent-live-resource-metrics
workspace → /tmp/tachyon-dev-host/metrics-386/workspace
agents:    pilot, reviewer, busy (autostart loops)
```

## Seu F5

1. Monorepo `~/tachyon`
2. **Run and Debug → Tachyon: Dev Host → F5**
3. Só a janela **`[Extension Development Host]`**
4. Activity bar → **Tachyon** → Agents

### Esperado

| | |
|---|---|
| Rows | `pilot`, `reviewer` (filho), `busy` |
| ~1–2s depois | peek `N% · XM` nos running |
| ▤ | abre CPU / Mem |
| ▾ em pilot | colapsa `reviewer` (+1) |
| Header | Expand metrics / Collapse metrics |
| `busy` | CPU alto (busy loop) |

Se rows não aparecerem: Command Palette → **Tachyon: Doctor** no EDH; confirme que o folder aberto é o fixture mirror (não `~/tachyon` monorepo fleet).

## Re-armar se precisar

```bash
export TACHYON_DEV_HOST_ID=metrics-386
cd /home/goat/tachyon
# yml já está no fixture; re-point:
bash scripts/dev-host/cli.sh point \
  --worktree /home/goat/tachyon-worktrees/agent-live-resource-metrics \
  --workspace /tmp/tachyon-dev-host/metrics-386/workspace \
  --spec 386 --slug agent-live-resource-metrics
cd /home/goat/tachyon-worktrees/agent-live-resource-metrics && npm run build
```

## Cleanup

```bash
# fechar EDH
export TACHYON_DEV_HOST_ID=metrics-386
cd /home/goat/tachyon
npm run dogfood:dev-host -- clean
npm run dogfood:dev-host -- point-clear
```
