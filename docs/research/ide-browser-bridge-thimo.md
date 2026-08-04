# IDE Browser bridge (thimo-style prototype)

_Status: worktree prototype for Dev Host. Not product SDD._  
_Date: 2026-08-03._

## Intent

Drive the **real VS Code Integrated Browser** (Chromium in the editor) from Tachyon agents via Bridge tools `ide_browser_*`, using the same architecture as [thimo/vscode-integrated-browser-mcp](https://github.com/thimo/vscode-integrated-browser-mcp):

```text
Agent ──MCP ide_browser_*──▶ Bridge/engine ──HTTP+token──▶ Shell extension
                                                              │
                                                              ▼
                                                    editor-browser debug session
                                                              │ requestCDPProxy
                                                              ▼
                                                    Integrated Browser (native)
```

## Surfaces

| Layer | Location |
|---|---|
| Shell HTTP + CDP | `src/webview/ide-browser-bridge/` |
| Discovery client | `src/ide-browser/client.ts` |
| Bridge tools | `ide_browser_status\|navigate\|screenshot\|snapshot\|eval\|click\|url` |
| Commands | `tachyon.ideBrowserBridge.{start,stop,status,open}` |

## Discovery

On start, the shell writes:

`~/.tachyon/ide-browser-instances/<hash>.json`

```json
{ "schemaVersion": 1, "kind": "tachyon-ide-browser", "workspaceRoot", "port", "token", "pid", "startedAt" }
```

Engine tools appear only while that file is live (pid check).

## Dogfood (Dev Host) — simple path

1. F5 **Tachyon: Dev Host** (or reload EDH after build)
2. Click the **IDE Browser** status bar globe when you want a tab (no auto-open). Default URL is example.com
3. Reopen / change site: click the **globe** on the status bar, or **Tachyon: Open IDE Browser**
4. Agents: `ide_browser_*` when the bridge instance file is live; `ide_browser_navigate` drives that tab
5. If the globe is red: click it to retry, or Output → **Tachyon IDE Browser**

## Design Mode (user → agent, Orca-style)

1. With bridge + page open (and preferably **grok** running via dogfood marker):
2. Click status bar **Design Mode** (or **Tachyon: Toggle Design Mode**)
3. In the page a floating **✦** FAB appears (bottom-right). Click it to open the right drawer.
4. Hover (blue outline) → **click** an element → drawer fills with tag/text/styles/HTML + note field
5. Click **Send to agent** in the drawer → host delivers pick via `sendAgentInput` (crop PNG under `.tachyon/ide-browser-picks/` when possible)
6. **Esc** / **Exit Design Mode** clears inject. Do not rely on VS Code toast while picking — browser pauses under notifications.

Not Companion / not Copilot “Add Element to Chat”. Primary path is Integrated Browser CDP → in-page widget → Tachyon agent.

Picks use `window.__tachyonDmQueue` polled by the host (binding is best-effort).

## Limits (prototype)

- Single tab; **debug-session path** only (no proposed `openBrowserTab` yet)
- Requires VS Code desktop with `editor-browser` + js-debug CDP proxy
- Tools vanish when the VS Code window stops (engine stays up)
- Not a replacement for Companion (`user_browser_*`) or headless `agent-browser`

## Related upstream

- [vscode#300319](https://github.com/microsoft/vscode/issues/300319) — API proposal CDP
- thimo integrated-browser-mcp — reference implementation
