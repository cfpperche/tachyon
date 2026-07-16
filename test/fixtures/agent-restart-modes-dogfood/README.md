# restart-modes dogfood (spec 389)

One **stopped Grok** agent for human validation of Restart modes.

| Entry | Kind | State |
|-------|------|--------|
| `grok` | agent (LLM CLI) | **stopped** (`autostart: false`) |

## EDH

1. F5 **Tachyon: Dev Host** (pointer → this fixture)
2. Sidebar → **Agents** → `grok` stopped
3. **Start** (play) → wait ready
4. **⋯**:
   - **Restart** — graceful + resume (default)
   - **Restart new section** — graceful + new
   - **Force restart (new section)** — force + new
5. **Open terminal** — pane no editor

## Headless matrix (bash, no LLM)

```bash
npm run dogfood:restart-modes
```
