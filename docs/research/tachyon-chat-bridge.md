# Tachyon ↔ VS Code Chat bridge (prototype)

_Status: worktree prototype for Dev Host dogfood. Not a full product SDD._  
_Date: 2026-08-03._

## Intent

Let humans use **VS Code Chat** (and Integrated Browser **Add to Chat** attachments) to
**deliver prompts into Tachyon agents** (Bridge / worktree CLIs), without replacing the fleet.

```text
[Integrated Browser] --Add Element/Screenshot--> [VS Code Chat]
                                                      |
                                                      | @tachyon /send grok …
                                                      | or #tachyon_send_prompt
                                                      v
                                              [Tachyon engine agent.input]
                                                      v
                                              [agent terminal / CLI]
```

## Surfaces

| Surface | ID | Role |
|---|---|---|
| Chat participant | `@tachyon` (`tachyon.chat`) | Human-directed routing |
| LM tool | `tachyon_list_agents` | Agent mode / `#` mention |
| LM tool | `tachyon_send_prompt` | Agent mode / `#` mention |

## Commands (@tachyon)

- `/list` — list agents
- `/send <agent> <message>` — deliver + submit
- `/help`
- Free-form: `grok: …` or `to claude: …`

## Dogfood (Dev Host)

1. Arm pointer + F5 Dev Host (fixture with at least one agent if you want a real delivery).
2. Ensure Copilot Chat (or Chat view) is available in the EDH window.
3. Open Chat → type `@tachyon /help`
4. `@tachyon /list`
5. Start an agent in Control if needed, then `@tachyon /send <name> ping from chat bridge`
6. Confirm the text appears in that agent's terminal/composer.
7. Optional: Integrated Browser → Add Element to Chat → `@tachyon /send <name> fix this element`

## Non-goals

- Replacing Tachyon agents with Copilot Agent Mode.
- Driving Integrated Browser tools from Tachyon (core-only).
- Auto-routing every Copilot message into the fleet (opt-in `@tachyon` / tools only).
