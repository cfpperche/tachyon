# 395 — Engine/Bridge Inspector POC notes

**Branch:** `grok/engine-bridge-inspector-poc`  
**Worktree:** `/home/goat/tachyon-worktrees/engine-bridge-inspector`  
**Pin:** p-78af51 (option B)

## How to dogfood

### Dev-host preview (fastest)

```bash
cd /home/goat/tachyon-worktrees/engine-bridge-inspector
node esbuild.mjs
npm run preview:webview:catalog   # regenerates routes.json
npm run preview:webview
```

Open:

- **default** (attached + error + none):  
  http://localhost:5174/scripts/webview-preview/index.html?view=control-inspector&fixture=default
- **healthy** only:  
  http://localhost:5174/scripts/webview-preview/index.html?view=control-inspector&fixture=healthy
- **empty**:  
  http://localhost:5174/scripts/webview-preview/index.html?view=control-inspector&fixture=empty

### F5 Extension Development Host (Dev Host)

Default F5 config **Tachyon: Dev Host** requires the pointer armed (otherwise preLaunchTask fails with *“Dev Host is not armed”*):

```bash
cd /home/goat/tachyon-worktrees/engine-bridge-inspector
# open THIS folder in VS Code (not the monorepo root) — ${workspaceFolder} must be this worktree
npm run dogfood:dev-host -- point \
  --worktree /home/goat/tachyon-worktrees/engine-bridge-inspector \
  --fixture sample-workspace \
  --spec 395 --slug control-inspector
# Run and Debug → "Tachyon: Dev Host" → F5
# EDH window → Command Palette → Tachyon: Inspect Engine/Bridge
# cleanup: npm run dogfood:dev-host -- point-clear
```

Alternate (no pointer): launch config **Run Tachyon (test fixture)** (builds `workspaceFolder` dist directly).

### Installed / VSIX

1. From this worktree: `npm run build` (or VSIX ritual).
2. Command Palette → **Tachyon: Inspect Engine/Bridge**
3. Compare with **Tachyon: Inspect tmux Server**

## What the POC shows

- Per attached workspace shell: engine identity (pid, version, instance, startedAt, bundle), Bridge URL/port/instance, workspace root/hash, agent counts.
- Summary chips: workspace count, attached engines, errors, agents running/total.
- Copy diagnostics (clipboard, no secrets).
- Open tmux Server Inspector (sibling).

## Explicit non-goals (POC)

- No engine restart / kill
- No Bridge tool runner
- No plugin integrity table
- No managed-worktree deep list (392 can plug later)

## Files

- `src/control-inspector/model.ts` — pure model + diagnostics format
- `src/webview/ControlInspector.ts` — panel host
- `src/webview/control-inspector/*` — Preact UI
- `test/unit/controlInspector.test.ts`
