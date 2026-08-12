# Cookbook — choose the browser surface

Tachyon has three browser products. Choose by **whose viewport must be controlled**; their sessions
and tool namespaces are not interchangeable.

## When to use

| Need | Product | What must be running |
|---|---|---|
| Human and agent share a page inside VS Code; the human picks UI and reads the reply there | **Integrated Browser + Design Mode** | VS Code desktop/Extension Development Host, `settings.ideBrowser.enabled: true`, IDE Browser Host, and an editor Integrated Browser tab |
| Work in the human's everyday signed-in browser and its existing tabs | **Companion browser** | `settings.companion.tabTools: true`, a paired Companion browser with Agent tab access, and live sync to this engine |
| Agent-owned headless inspection, screenshots, extraction, or isolated automation | **agent-browser plugin** | Installed plugin launcher, its pinned `agent-browser` binary, and host Chrome/Chromium; `AB doctor` must pass |

## When not to use

- Do not use `ide_browser_*` for the human's normal Chrome session or unattended headless work.
- Do not use `user_browser_*` for the VS Code tab, or when the human has not paired and granted tab access.
- Do not use agent-browser to claim a shared human viewport. It owns a separate named Chrome session;
  authenticated state exists only if the human prepared isolated saved state for it.
- Do not substitute a terminal answer for `design_mode_chat_reply` when the request came from Design Mode.

## Happy paths

1. **Design Mode:** enable `settings.ideBrowser.enabled`, open the globe, call
   `ide_browser_status`, then observe or act with `ide_browser_*`. The human turns on the inspect icon,
   chooses a running agent, and picks or chats. Reply with `design_mode_chat_reply`, passing the
   prompt's `turnId`.
2. **Companion:** enable tab tools, pair Companion and enable Agent tab access. Start with
   `user_browser_tabs_list`; keep its opaque `tabId` on every call. Take
   `user_browser_snapshot`, prefer its `@eN` refs, and carry `documentToken` so navigation fails stale.
3. **agent-browser:** set one fixed session name and an idle timeout; invoke only through
   `.tachyon/bin/_tachyon-tool agent-browser agent-browser` (`AB`). Run `AB doctor`, then
   `AB --session <name> open <url>` → `snapshot -i` → `get` or `screenshot`.

## Tools

| Product | Tools / commands | Reach |
|---|---|---|
| Integrated Browser | `ide_browser_{status,navigate,url,snapshot,screenshot,click,eval}`; `design_mode_chat_reply` | The single VS Code editor Chromium tab and Design Mode panel |
| Companion | `user_browser_{tabs_list,tab_open,tab_activate,tab_close}`; `{snapshot,find,get,screenshot,console,network,list_frames}`; `{navigate,click,fill,type,press_key,select_option,check,hover,scroll,drag,dialog,upload,download,wait_for}` with the same `user_browser_` prefix | A paired human-browser tab selected by `tabId` |
| agent-browser | `AB doctor`; `AB --session <name> open|snapshot|get|screenshot|close`; use `AB --help` for the installed version's full CLI | An isolated plugin-owned Chrome session with accessibility `@eN` refs |

## Fail closed / safety

- Integrated Browser tools stay discoverable, but calls refuse when the feature is disabled or the
  IDE Browser Host is offline. Do not fall through to another browser family: enable/open the intended surface.
- Companion tools are absent unless tab tools are enabled and refuse when unpaired. A stale
  `documentToken` refuses after navigation; mutations may require `confirmed` and are bounded by configured hosts.
- agent-browser must stop when doctor fails or `allowedDomains` rejects a host. Its write commands
  execute immediately: get explicit human approval before the first write, snapshot before and after,
  and never treat `confirmActions` as an effective hold on CLI 0.31.0.

## Cleanup

1. Turn Design Mode off when the shared picking session ends; use the advanced **IDE Browser Bridge
   Stop** command only when the host itself should stop.
2. Close only Companion tabs opened for the task (`user_browser_tab_close`); leave the human's
   pre-existing tabs alone. Unpair through Control only when the pairing itself was temporary.
3. Run `AB --session <name> close` (or `quit`). Keep `AGENT_BROWSER_IDLE_TIMEOUT_MS` as a backstop;
   saved state under `.tachyon/browser-state/` is credential-class, gitignored, and removed when stale.

## See also

- Contract: [`spec.md`](./spec.md)
- Architecture and accepted boundaries: [`architecture-fit.md`](./architecture-fit.md)
- Plugin design and operating boundary: [`SDD 267`](../267-plugin-agent-browser/spec.md)
