# agent-pane-dogfood (t-610355)

Isolated fixture for F5 dogfood of the first-party agent pane (layer 2).

**Agents are real CLIs** (`grok` / `claude` / `codex`). Do **not** use `bash` + `kind: agent` here.

1. Point Dev Host: worktree `agent-pane-first-party`, fixture `agent-pane`, `--owner grok`.
2. F5 **Tachyon: Dev Host · grok** (or active `grok`).
3. Wait for agent `dogfood` (grok) or start another row from the sidebar.
4. Sidebar row: **eye** = integrated terminal (layer 1); **terminal** icon = agent pane (layer 2).
