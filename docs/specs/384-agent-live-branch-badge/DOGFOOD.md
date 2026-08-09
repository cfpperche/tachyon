# Spec 384 — dogfood via Dev Host (EDH)

**Você faz o dogfood.** O prep já está armado no monorepo.

## O que estava errado antes

O `point` foi feito **só no worktree**.  
O F5 roda no monorepo (`~/tachyon`), que lê:

```text
${workspaceFolder}/.tachyon/dev-host/extension
```

Sem esse pointer no monorepo, o preLaunchTask falha com:

> Tachyon Dev Host is not armed  
> preLaunchTask `tachyon: build-dev-host` exit 1

**Corrigido:** `point` refeito a partir de `/home/goat/tachyon` → monorepo armado.

---

## Prep (já feito — só confira se algo quebrou)

| Check | Esperado |
|---|---|
| Monorepo pointer | `~/tachyon/.tachyon/dev-host/extension` → worktree da 384 |
| Fixture | `/tmp/tachyon-dev-host/live-branch-384/workspace` |
| pilot HEAD | `feat/live-demo` (drift vs config `tachyon/pilot`) |
| reviewer HEAD | `main` (shared) |
| preLaunch dry-run | `exit 0` |

Se F5 falhar de novo com “not armed”, re-arme **no monorepo**:

```bash
cd /home/goat/tachyon
scripts/dev-host/cli.sh point \
  --worktree /home/goat/tachyon-worktrees/t-c64647-agent-live-branch \
  --workspace /tmp/tachyon-dev-host/live-branch-384/workspace \
  --spec 384 --slug agent-live-branch-badge
```

---

## Seu dogfood (só isto)

### 1. No monorepo VS Code (`~/tachyon`)

1. **Run and Debug** (ícone play com inseto).
2. Dropdown: **`Tachyon: Dev Host`** (não “Run Tachyon”).
3. **F5** (ou ▶).
4. Espere o preLaunch build terminar **sem** dialog de erro.

### 2. Na janela nova

Título deve conter:

```text
[Extension Development Host]
```

e o folder aberto deve ser o **fixture** (`live-branch-384/workspace`), **não** o monorepo.

> Ignore a janela monorepo (fleet codex/grok). Dogfood só no EDH.

### 3. Sidebar Tachyon no EDH

1. Activity bar → ícone **Tachyon**.
2. Aba **Agents**.
3. Confira:

| Agent | 1º badge (live) | Tom |
|---|---|---|
| **pilot** | `⎇ feat/live-demo ⚠` | warn (drift vs `tachyon/pilot`) |
| **reviewer** | `⎇ main` | quieto (shared cwd) |

Badge de branch deve ser **sempre o primeiro** da lista de badges da row.

### 4. Anotar

- pass / fail  
- screenshot se quiser  
- SHA da status bar do EDH / `git -C …/t-c64647-agent-live-branch rev-parse --short HEAD`

---

## Cleanup (depois, com EDH fechado)

```bash
# 1) Fechar a janela [Extension Development Host]
cd /home/goat/tachyon
export TACHYON_DEV_HOST_ID=live-branch-384
scripts/dev-host/cli.sh clean
scripts/dev-host/cli.sh point-clear
# se a lane ainda estiver com o agent:
# node scripts/dev-host/lane.mjs release --owner grok
```

---

## Mapa mental

```text
Monorepo (~/tachyon)          ← você aperta F5 AQUI
  .tachyon/dev-host/
    extension → worktree 384  ← código sob teste
    workspace → fixture       ← pasta aberta no EDH

EDH (janela nova)             ← você olha a UI AQUI
  fixture workspace
  agents pilot + reviewer
```

**Nunca** dogfoodar a sidebar do monorepo para validar a 384 — ela roda a extensão instalada/main, não o worktree.
