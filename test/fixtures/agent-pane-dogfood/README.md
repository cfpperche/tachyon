# agent-pane-dogfood (t-610355)

Isolated fixture for F5 dogfood of the first-party agent pane (layer 2).

**Agents are real CLIs** (`grok` / `claude` / `codex`). Do **not** use `bash` + `kind: agent` here.

> **Create the agents first (SDD 478).** This fixture declares no agents. An `agents:` entry is a
> pointer to a canonical profile, and the authority that attests it is custodied by the host (VS Code
> secret storage), so no checked-in fixture can ship one. After arming the Dev Host, create the rows
> below with **Tachyon: Agent Studio**, then continue.

> Create `dogfood` (grok), and `claude` / `codex` if you want more rows.

1. Point Dev Host: worktree `agent-pane-first-party`, fixture `agent-pane`, `--owner grok`.
2. F5 **Tachyon: Dev Host · grok** (or active `grok`).
3. Wait for agent `dogfood` (grok) or start another row from the sidebar.
4. Sidebar row: **eye** = integrated terminal (layer 1); **terminal** icon = agent pane (layer 2).
