# 395 — Engine/Bridge Inspector POC notes

**Branch:** `grok/engine-bridge-inspector-poc`  
**Worktree:** `/home/goat/tachyon-worktrees/engine-bridge-inspector`  
**Pin:** p-78af51 (option B)

## How to dogfood

1. From this worktree: `npm run build` (or full package/install ritual you use for VSIX).
2. In VS Code with Tachyon loaded from this build:
   - Command Palette → **Tachyon: Inspect Engine/Bridge**
   - or sidebar title-bar menu (next to Inspect tmux Server)
3. Compare with **Tachyon: Inspect tmux Server** — different domain, deep-link button between them.

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
