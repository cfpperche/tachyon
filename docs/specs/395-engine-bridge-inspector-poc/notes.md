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

### Installed / F5

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
