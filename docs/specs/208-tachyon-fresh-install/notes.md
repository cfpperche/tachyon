# 208 — tachyon-fresh-install — notes

## Design decisions
### 2026-06-11 — parent — "create is the opt-in", not "install" or "look"
Installing the extension or clicking the ⚡ icon must not boot a Bridge/tmux. Booting happens when a folder has config at startup, or when the user invokes a creation command (Init/New Agent/Studio) — pickFolderForCreate boots on demand. Passive view focus does not.

### 2026-06-11 — parent — the welcome bug fixed itself via lazy activation
The viewsWelcome never showed because the Agents tree always had the Bridge node. With lazy activation a look-only folder has no Workspace → no Bridge node → empty tree → welcome renders. No separate fix needed.

## Deviations
## Tradeoffs
## Open questions
